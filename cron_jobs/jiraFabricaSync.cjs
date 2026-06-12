// Helper compartilhado da Produção Unificada de Materiais.
// Sincroniza:
//   - syncOsSnapshot(): board principal (Apontamento Produção / AP) -> os_snapshot
//   - syncFabrica(cfg): um board de fábrica -> producao_<material>
//
// O card-pai da OS nasce em AP (Apontamento Produção); o PB (Produção Blindados)
// só é aberto quando a produção é autorizada. Logo a MÃE é o AP: ele já carrega
// OS/PD, situação, veículo e as previsões por material (1 card "Recebimento" por OS).
//
// Paginação JQL no mesmo padrão de sync_cards_jira.cjs / carbonReportService.
// Cada chamada cria e fecha seu próprio pool (executa dentro de worker_threads
// do scheduler, uma vez a cada N minutos). CommonJS para ser require-ável pelo
// código do job versionado (require relativo a cron_jobs/).
//
// Desempenho: os UPSERTs são feitos em LOTE (multi-row INSERT, BATCH_SIZE linhas
// por statement). O gargalo medido era 1 round-trip por card até a VPS remota
// (~120 ms/card); em lote a gravação cai de minutos para segundos.

const axios = require('axios');
const { Pool } = require('pg');

const JIRA_URL = process.env.JIRA_URL;
const EMAIL = process.env.JIRA_EMAIL;
const API_TOKEN = process.env.JIRA_API_TOKEN;

// Quantas linhas por INSERT multi-row. 500 * (≤13 params) = ≤6500 params,
// bem abaixo do limite de 65535 parâmetros do Postgres.
const BATCH_SIZE = Number(process.env.FABRICA_SYNC_BATCH) || 500;

// Tipo de ticket do board principal (o card-pai da OS no AP). Praticamente todo
// o projeto AP é "Recebimento" (1 card por OS); o filtro mantém a mãe enxuta e
// imune a eventuais issuetypes avulsos. Configurável caso o nome mude no Jira.
const AP_ISSUETYPE = process.env.AP_ISSUETYPE || 'Recebimento';

// Issuetype do card principal do PB — usado só para puxar a ETAPA de produção
// (estágio detalhado) das OS já em produção. Ver syncEtapaPB().
const PB_ISSUETYPE = process.env.PB_ISSUETYPE || 'Produção Blindados';

// Tabelas por material — whitelist (o sufixo entra no SQL, então NÃO pode vir de
// fora). project = chave do projeto Jira; osStrategy = de onde tirar o número da OS.
const FABRICAS = {
  // fabricaField: customfield com a fábrica/fornecedor do material (só VIDRO o usa
  // hoje — alimenta a coluna "Vidro" do Dashboard de Processos).
  vidro:     { project: 'VIDRO',    table: 'producao_vidro',     osStrategy: 'os_pd',  fabricaField: 'customfield_10100' },
  aco:       { project: 'ACO',      table: 'producao_aco',       osStrategy: 'resumo' },
  manta:     { project: 'MANTA',    table: 'producao_manta',     osStrategy: 'resumo' },
  tensylon:  { project: 'TENSYLON', table: 'producao_tensylon',  osStrategy: 'os_pd' },
  sup_vidro: { project: 'SVIDRO',   table: 'producao_sup_vidro', osStrategy: 'os_pd' },
};

// Custom fields (confirmados no dump jira_kanban_custom_fields.txt / carbonReportService).
const CF = {
  OS_PD: 'customfield_10256',
  SITUACAO: 'customfield_10039',
  PEDIDO_CARBON: 'customfield_10040',
  ORDEM: 'customfield_12141',
  VEICULO: 'customfield_11298',
  MARCA: 'customfield_11069',
  MODELO: 'customfield_11070',
  ANO: 'customfield_11071',
  PREV_VIDRO: 'customfield_11448',
  PREV_ACO: 'customfield_11450',
  PREV_MANTA: 'customfield_11449',
  PREV_TENSYLON: 'customfield_13064',
  PREV_SUP_VIDRO: 'customfield_12635',
  // Campos do Dashboard de Processos (confirmados nos cards AP reais).
  VEICULO_COMPRAS: 'customfield_11504',   // VEÍCULO (string completa)
  COR: 'customfield_10038',               // COR
  BLINDAGEM: 'customfield_11067',         // BLINDAGEM (produto)
  CHASSI: 'customfield_10257',            // CHASSIS
  PARCEIRO: 'customfield_11335',          // PARCEIRO
  DATA_PEDIDO: 'customfield_11336',       // DATA OS (Data do Pedido)
  DATA_RECEBIMENTO: 'customfield_11352',  // RECEBIMENTO
  DATA_CONTRATO: 'customfield_11141',     // DATA CONTRATO (DT.CONTRATO)
  PRAZO_CONTRATO: 'customfield_11328',    // PRAZO CONTRATO
  LIBERACAO_EXERCITO: 'customfield_11351',// LIBERAÇÃO EXÉRCITO
  OBS: 'customfield_14120',               // OBS (Comentários Core)
};

function makePool() {
  return new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'maestro',
    password: process.env.DB_PASSWORD || 'postgres',
    port: process.env.DB_PORT || 5432,
  });
}

function makeClient() {
  if (!JIRA_URL || !EMAIL || !API_TOKEN) {
    throw new Error('JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN não configurados no ambiente');
  }
  return axios.create({
    baseURL: `${JIRA_URL}/rest/api/3`,
    auth: { username: EMAIL, password: API_TOKEN },
  });
}

// Valor "plano" de um custom field (option/objeto -> .value/.name; senão o valor).
function cf(fields, id) {
  const v = fields[id];
  if (v == null) return null;
  if (typeof v === 'object') return v.value ?? v.name ?? null;
  return v;
}

function dateOnly(v) {
  if (v == null || v === '') return null;
  return String(v).slice(0, 10);
}

// Remove emoji/bolinha de cor do início (ex.: "⚫Aguardando entrada").
function normSituacao(v) {
  if (v == null) return null;
  return String(v).replace(/^[^\p{L}\p{N}]+/u, '').trim() || null;
}

// Último número de 4-10 dígitos do resumo (mesma heurística do jiraCardLookup).
function extractOsFromResumo(resumo) {
  const m = String(resumo || '').match(/\b(\d{4,10})\b/g);
  return m ? m[m.length - 1] : '';
}

// scope: 'kanban' (padrão) = só cards ativos (statusCategory != Done) — é o que
// roda a cada N min. 'base' = projeto inteiro (reconciliação manual/ocasional).
function scopeClause(scope) {
  return scope === 'base' ? '' : ' AND statusCategory != "Done"';
}

async function buscarIssues(client, jql, fieldList, nextPageToken) {
  const params = { jql, maxResults: 100, fields: fieldList.join(',') };
  if (nextPageToken) params.nextPageToken = nextPageToken;
  const resp = await client.get('/search/jql', { params });
  return resp.data;
}

// Coleta todas as issues (apenas fetch — a gravação é feita em lote depois).
async function coletar(client, jql, fieldList, mapIssue) {
  let nextPage = null;
  const rows = [];
  do {
    const data = await buscarIssues(client, jql, fieldList, nextPage);
    for (const issue of data.issues || []) {
      const r = mapIssue(issue);
      if (r) rows.push(r);
    }
    if (data.isLast) break;
    nextPage = data.nextPageToken;
  } while (nextPage);
  return rows;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// UPSERT multi-row genérico.
//   paramCols: colunas alimentadas por parâmetro ($1, $2, ...)
//   litCols:   colunas com expressão literal por linha (ex.: now()), sem param
//   casts:     { indiceDaColuna: 'date'|'jsonb'|... } para fixar o tipo do param
//   dedupKeyIdx: índice da coluna que é alvo do ON CONFLICT. O Postgres recusa um
//     INSERT multi-row que atinja a mesma chave 2x no mesmo statement, então
//     deduplicamos mantendo a ÚLTIMA ocorrência (com ORDER BY updated ASC = a mais recente).
async function bulkUpsert(pool, cfg, rows) {
  const { table, paramCols, litCols = [], conflict, updateSet, casts = {}, dedupKeyIdx } = cfg;
  if (dedupKeyIdx != null) {
    const byKey = new Map();
    for (const r of rows) byKey.set(r[dedupKeyIdx], r); // set tardio sobrescreve = última vence
    rows = [...byKey.values()];
  }
  const nparam = paramCols.length;
  const allCols = [...paramCols, ...litCols.map((l) => l.name)];
  let gravados = 0;
  for (const part of chunk(rows, BATCH_SIZE)) {
    const tuples = part
      .map((_, r) => {
        const ps = paramCols.map((__, c) => {
          const ph = `$${r * nparam + c + 1}`;
          return casts[c] ? `${ph}::${casts[c]}` : ph;
        });
        return `(${[...ps, ...litCols.map((l) => l.expr)].join(',')})`;
      })
      .join(',');
    const flat = part.flat();
    const sql =
      `INSERT INTO ${table} (${allCols.join(',')}) VALUES ${tuples} ` +
      `ON CONFLICT ${conflict} DO UPDATE SET ${updateSet}`;
    await pool.query(sql, flat);
    gravados += part.length;
  }
  return gravados;
}

// ── Mãe: Apontamento Produção (AP) -> os_snapshot ────────────────────────────
async function syncOsSnapshot({ scope = 'kanban' } = {}) {
  const pool = makePool();
  const client = makeClient();
  // ASC: se houver +1 card AP para a mesma OS, o mais recente é aplicado por último.
  const jql =
    `project = AP AND issuetype = "${AP_ISSUETYPE}"${scopeClause(scope)} ORDER BY updated ASC`;
  const fieldList = [
    'status', CF.OS_PD, CF.SITUACAO, CF.VEICULO, CF.MARCA, CF.MODELO, CF.ANO,
    CF.PREV_VIDRO, CF.PREV_ACO, CF.PREV_MANTA, CF.PREV_TENSYLON, CF.PREV_SUP_VIDRO,
    // campos do Dashboard de Processos
    CF.VEICULO_COMPRAS, CF.COR, CF.BLINDAGEM, CF.CHASSI, CF.PARCEIRO,
    CF.DATA_PEDIDO, CF.DATA_RECEBIMENTO, CF.DATA_CONTRATO, CF.PRAZO_CONTRATO,
    CF.LIBERACAO_EXERCITO, CF.OBS,
  ];

  try {
    const rows = await coletar(client, jql, fieldList, (issue) => {
      const f = issue.fields || {};
      const numeroOs = String(cf(f, CF.OS_PD) ?? '').trim();
      if (!numeroOs) return null; // card AP sem OS — ignora
      return [
        numeroOs,
        issue.key,
        cf(f, CF.VEICULO),
        cf(f, CF.MARCA),
        cf(f, CF.MODELO),
        cf(f, CF.ANO),
        normSituacao(cf(f, CF.SITUACAO)),
        f.status?.name || null,
        dateOnly(cf(f, CF.PREV_VIDRO)),
        dateOnly(cf(f, CF.PREV_ACO)),
        dateOnly(cf(f, CF.PREV_MANTA)),
        dateOnly(cf(f, CF.PREV_TENSYLON)),
        dateOnly(cf(f, CF.PREV_SUP_VIDRO)),
        cf(f, CF.VEICULO_COMPRAS),
        cf(f, CF.COR),
        cf(f, CF.BLINDAGEM),
        cf(f, CF.CHASSI),
        cf(f, CF.PARCEIRO),
        dateOnly(cf(f, CF.DATA_PEDIDO)),
        dateOnly(cf(f, CF.DATA_RECEBIMENTO)),
        dateOnly(cf(f, CF.DATA_CONTRATO)),
        cf(f, CF.PRAZO_CONTRATO) != null ? String(cf(f, CF.PRAZO_CONTRATO)) : null,
        dateOnly(cf(f, CF.LIBERACAO_EXERCITO)),
        cf(f, CF.OBS),
      ];
    });

    const gravados = await bulkUpsert(pool, {
      table: 'maestro.os_snapshot',
      paramCols: [
        'numero_os', 'ap_key', 'veiculo', 'marca', 'modelo', 'ano', 'etapa', 'status',
        'prev_vidro', 'prev_aco', 'prev_manta', 'prev_tensylon', 'prev_sup_vidro',
        'veiculo_compras', 'cor', 'blindagem', 'chassi', 'parceiro',
        'data_pedido', 'data_recebimento', 'data_contrato', 'prazo_contrato',
        'liberacao_exercito', 'obs',
      ],
      litCols: [{ name: 'last_updated_at', expr: 'now()' }],
      casts: {
        8: 'date', 9: 'date', 10: 'date', 11: 'date', 12: 'date',
        18: 'date', 19: 'date', 20: 'date', 22: 'date',
      },
      dedupKeyIdx: 0, // numero_os — garante 1 linha por OS no mesmo batch
      conflict: '(numero_os)',
      updateSet: `
        ap_key = EXCLUDED.ap_key, veiculo = EXCLUDED.veiculo, marca = EXCLUDED.marca,
        modelo = EXCLUDED.modelo, ano = EXCLUDED.ano, etapa = EXCLUDED.etapa,
        status = EXCLUDED.status, prev_vidro = EXCLUDED.prev_vidro, prev_aco = EXCLUDED.prev_aco,
        prev_manta = EXCLUDED.prev_manta, prev_tensylon = EXCLUDED.prev_tensylon,
        prev_sup_vidro = EXCLUDED.prev_sup_vidro,
        veiculo_compras = EXCLUDED.veiculo_compras, cor = EXCLUDED.cor,
        blindagem = EXCLUDED.blindagem, chassi = EXCLUDED.chassi, parceiro = EXCLUDED.parceiro,
        data_pedido = EXCLUDED.data_pedido, data_recebimento = EXCLUDED.data_recebimento,
        data_contrato = EXCLUDED.data_contrato, prazo_contrato = EXCLUDED.prazo_contrato,
        liberacao_exercito = EXCLUDED.liberacao_exercito, obs = EXCLUDED.obs,
        last_updated_at = now()`,
    }, rows);

    return { project: 'AP', table: 'os_snapshot', scope, scanned: rows.length, gravados };
  } finally {
    await pool.end();
  }
}

// ── Fábrica -> producao_<material> ───────────────────────────────────────────
async function syncFabrica(materialKey, { scope = 'kanban' } = {}) {
  const cfg = FABRICAS[materialKey];
  if (!cfg) throw new Error(`Material desconhecido: ${materialKey}`);

  const pool = makePool();
  const client = makeClient();
  const jql = `project = ${cfg.project}${scopeClause(scope)} ORDER BY updated DESC`;
  const fieldList = ['status', 'summary', CF.OS_PD, CF.SITUACAO, CF.PEDIDO_CARBON, CF.ORDEM];
  if (cfg.fabricaField) fieldList.push(cfg.fabricaField);

  try {
    const rows = await coletar(client, jql, fieldList, (issue) => {
      const f = issue.fields || {};
      const resumo = f.summary || '';
      const osPd = String(cf(f, CF.OS_PD) ?? '').trim();
      const numeroOs = cfg.osStrategy === 'os_pd'
        ? (osPd || extractOsFromResumo(resumo) || null)
        : (extractOsFromResumo(resumo) || osPd || null);
      const statusName = f.status?.name || null;
      return [
        numeroOs,
        issue.key,
        normSituacao(cf(f, CF.SITUACAO)),
        statusName,
        cf(f, CF.PEDIDO_CARBON),
        null, // previsão por material vive na mãe (AP); aqui fica reservado
        JSON.stringify({ resumo, ordem: cf(f, CF.ORDEM) ?? null }),
        statusName === 'Produzido' ? new Date() : null,
        cfg.fabricaField ? cf(f, cfg.fabricaField) : null, // fábrica/fornecedor (só VIDRO)
      ];
    });

    // cfg.table vem da whitelist FABRICAS — seguro interpolar.
    const gravados = await bulkUpsert(pool, {
      table: `maestro.${cfg.table}`,
      paramCols: [
        'numero_os', 'jira_key', 'situacao', 'status', 'pedido_carbon',
        'previsao', 'campos', 'produced_at', 'fabrica',
      ],
      litCols: [{ name: 'last_updated_at', expr: 'now()' }],
      casts: { 5: 'date', 6: 'jsonb', 7: 'timestamptz' },
      dedupKeyIdx: 1, // jira_key — único por card, mas guarda contra repetição na mesma página
      conflict: '(jira_key)',
      updateSet: `
        numero_os = EXCLUDED.numero_os, situacao = EXCLUDED.situacao, status = EXCLUDED.status,
        pedido_carbon = EXCLUDED.pedido_carbon, previsao = EXCLUDED.previsao, campos = EXCLUDED.campos,
        produced_at = COALESCE(maestro.${cfg.table}.produced_at, EXCLUDED.produced_at),
        fabrica = EXCLUDED.fabrica, last_updated_at = now()`,
    }, rows);

    return { project: cfg.project, table: cfg.table, scope, scanned: rows.length, gravados };
  } finally {
    await pool.end();
  }
}

// ── Estágio de produção: Produção Blindados (PB) -> os_snapshot.etapa_pb ──────
// A ETAPA detalhada da OS (INSTALANDO VIDRO, MONTANDO, ENTREGUE...) vive no
// workflow do PB, não no AP. Aqui só atualizamos a coluna etapa_pb das OS que já
// existem na mãe (UPDATE, nunca INSERT). O AP continua dono da linha.
function stripStagePrefix(name) {
  if (name == null) return null;
  // remove prefixo "14 - ", "9.1 - ", "147 - " etc. e normaliza p/ maiúsculas
  return String(name).replace(/^\s*\d+(\.\d+)?\s*-\s*/, '').trim().toUpperCase() || null;
}

async function syncEtapaPB({ scope = 'base' } = {}) {
  const pool = makePool();
  const client = makeClient();
  // base por padrão: precisamos também das OS já "Entregue" (statusCategory Done).
  const jql =
    `project = PB AND issuetype = "${PB_ISSUETYPE}"${scopeClause(scope)} ORDER BY updated ASC`;
  const fieldList = ['status', CF.OS_PD];

  try {
    const rows = await coletar(client, jql, fieldList, (issue) => {
      const numeroOs = String(cf(issue.fields || {}, CF.OS_PD) ?? '').trim();
      if (!numeroOs) return null;
      return [numeroOs, stripStagePrefix(issue.fields?.status?.name)];
    });

    // dedup por OS (ASC => fica o mais recente)
    const byOs = new Map();
    for (const r of rows) byOs.set(r[0], r[1]);
    const pares = [...byOs.entries()];

    let gravados = 0;
    for (const part of chunk(pares, BATCH_SIZE)) {
      const values = part
        .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
        .join(',');
      const flat = part.flat();
      // UPDATE em lote via VALUES; só toca OS que já existem na mãe.
      const sql =
        `UPDATE maestro.os_snapshot o SET etapa_pb = v.etapa_pb, last_updated_at = now() ` +
        `FROM (VALUES ${values}) AS v(numero_os, etapa_pb) ` +
        `WHERE o.numero_os = v.numero_os`;
      const res = await pool.query(sql, flat);
      gravados += res.rowCount;
    }
    return { project: 'PB', table: 'os_snapshot.etapa_pb', scope, scanned: pares.length, gravados };
  } finally {
    await pool.end();
  }
}

module.exports = { syncOsSnapshot, syncFabrica, syncEtapaPB, FABRICAS };
