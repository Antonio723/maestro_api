// Migra os crons legados (.cjs) para o banco como versão OPE 1.00.
// Roda uma única vez por job — se já existe registro, não faz nada.
//
// O código abaixo é a forma "limpa" do job: sem cron.schedule, sem mutex
// `rodando`, sem recordRun (o scheduler central faz tudo isso agora).
// O código aqui é o corpo que será executado dentro do worker_threads
// — ele recebe `ctx` (com setRecordsProcessed, log, etc.) e tem `require` livre.

import { query } from '../config/database.js';

const SYNC_CARDS_JIRA_CODE = `
const axios = require("axios");
const { Pool } = require("pg");

const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "maestro",
  password: process.env.DB_PASSWORD || "postgres",
  port: process.env.DB_PORT || 5432,
});

const JIRA_URL = process.env.JIRA_URL;
const EMAIL = process.env.JIRA_EMAIL;
const API_TOKEN = process.env.JIRA_API_TOKEN;

const JQL = \`project = MANTA AND status IN ("A Produzir", "Liberado Engenharia","Em Produção", "Produzido")\`;

const client = axios.create({
  baseURL: \`\${JIRA_URL}/rest/api/3\`,
  auth: { username: EMAIL, password: API_TOKEN },
});

async function salvarOuAtualizar(issue) {
  const sql = \`
    INSERT INTO maestro.jira_cards (
      key, tipo, resumo, status, situacao, veiculo, previsao,
      project, fabrica_manta, produced_at, last_updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      CASE WHEN $4 = 'Produzido' THEN NOW() ELSE NULL END,
      NOW()
    )
    ON CONFLICT (key)
    DO UPDATE SET
      tipo = EXCLUDED.tipo,
      resumo = EXCLUDED.resumo,
      status = EXCLUDED.status,
      situacao = EXCLUDED.situacao,
      veiculo = EXCLUDED.veiculo,
      previsao = EXCLUDED.previsao,
      project = EXCLUDED.project,
      fabrica_manta = EXCLUDED.fabrica_manta,
      produced_at = COALESCE(
        maestro.jira_cards.produced_at,
        CASE WHEN EXCLUDED.status = 'Produzido' THEN NOW() ELSE NULL END
      ),
      last_updated_at = NOW();
  \`;
  const values = [
    issue.key, issue.tipo, issue.resumo, issue.status, issue.situacao,
    issue.veiculo, issue.previsao || null, issue.project || null, issue.fabricaManta || null,
  ];
  await pool.query(sql, values);
}

async function buscarIssues(jql, nextPageToken) {
  const params = {
    jql,
    maxResults: 100,
    fields: "issuetype,summary,status,customfield_10039,customfield_11298,customfield_10245,customfield_11353,customfield_11329",
  };
  if (nextPageToken) params.nextPageToken = nextPageToken;
  const response = await client.get("/search/jql", { params });
  return response.data;
}

async function processar() {
  let nextPage = null;
  let total = 0;
  console.log("Sync Jira iniciada...");

  do {
    const data = await buscarIssues(JQL, nextPage);
    const issues = data.issues || [];

    for (const issue of issues) {
      const fields = issue.fields || {};
      const key = issue.key;
      const tipo = fields.issuetype?.name || "";
      const resumo = fields.summary || "";
      const status = fields.status?.name || "";

      const situacaoRaw = fields.customfield_10039;
      const situacao = typeof situacaoRaw === "object" ? situacaoRaw?.value : situacaoRaw || "";

      const veiculoRaw = fields.customfield_11298;
      const veiculo = typeof veiculoRaw === "object" ? veiculoRaw?.value : veiculoRaw || "";

      const previsaoRaw = fields.customfield_10245;

      const projectRaw = fields.customfield_11353;
      const project = typeof projectRaw === "object" ? projectRaw?.value : projectRaw || "";

      const fabricaMantaRaw = fields.customfield_11329;
      const fabricaManta = typeof fabricaMantaRaw === "object" ? fabricaMantaRaw?.value : fabricaMantaRaw || "";

      await salvarOuAtualizar({
        key, tipo, resumo, status, situacao, veiculo,
        previsao: previsaoRaw, project, fabricaManta,
      });
      total++;
    }

    nextPage = data.nextPageToken;
    if (data.isLast) break;
  } while (true);

  console.log(\`Total sincronizado: \${total}\`);
  return total;
}

try {
  const total = await processar();
  ctx.setRecordsProcessed(total);
} finally {
  await pool.end();
}
`.trim();

// Cron do board ALMOXARIFADO MANTA (board id 146, projeto MANTA).
//
// Diferente do sync de produção, este NÃO faz upsert: atualiza SOMENTE linhas
// já existentes em jira_cards (match por key) e mexe APENAS em situacao, status
// e nota_fiscal. Cards do board que ainda não existem na tabela são ignorados —
// a produção (sync_cards_jira) continua sendo a dona do registro e dos demais
// campos (resumo, veiculo, previsao, project, fabrica_manta, produced_at).
//
// Usa a Agile API (/rest/agile/1.0/board/146/issue) para pegar exatamente os
// cards visíveis no board, respeitando o filtro salvo — sem precisar replicar
// a lista de status das colunas em JQL.
const SYNC_ALMOXARIFADO_MANTA_CODE = `
const axios = require("axios");
const { Pool } = require("pg");

const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "maestro",
  password: process.env.DB_PASSWORD || "postgres",
  port: process.env.DB_PORT || 5432,
});

const JIRA_URL = process.env.JIRA_URL;
const EMAIL = process.env.JIRA_EMAIL;
const API_TOKEN = process.env.JIRA_API_TOKEN;

const BOARD_ID = 146; // ALMOXARIFADO MANTA

const client = axios.create({
  baseURL: \`\${JIRA_URL}/rest/agile/1.0\`,
  auth: { username: EMAIL, password: API_TOKEN },
});

function unwrap(raw) {
  if (raw == null) return "";
  if (typeof raw === "object") return String(raw.value ?? raw.name ?? "").trim();
  return String(raw).trim();
}

function normalizeNotaFiscal(raw) {
  const v = unwrap(raw);
  if (!v) return null;
  // customfield_10101 é número (ex.: 46433.0) — remove o ".0" decimal
  return v.replace(/\\.0+$/, "");
}

// Atualiza SOMENTE linhas já existentes e SOMENTE situacao/status/nota_fiscal.
// rowCount === 0 significa que o card ainda não existe em jira_cards (ignorado).
async function atualizar(issue) {
  const fields = issue.fields || {};
  const status = unwrap(fields.status?.name);
  const situacao = unwrap(fields.customfield_10039);
  const notaFiscal = normalizeNotaFiscal(fields.customfield_10101);

  const res = await pool.query(
    \`UPDATE maestro.jira_cards
        SET status = $2,
            situacao = $3,
            nota_fiscal = $4,
            last_updated_at = NOW()
      WHERE key = $1\`,
    [issue.key, status, situacao, notaFiscal]
  );
  return res.rowCount;
}

async function buscarPagina(startAt) {
  const params = {
    startAt,
    maxResults: 100,
    fields: "status,customfield_10039,customfield_10101",
  };
  const { data } = await client.get(\`/board/\${BOARD_ID}/issue\`, { params });
  return data;
}

async function processar() {
  let startAt = 0;
  let lidos = 0;
  let atualizados = 0;
  let ignorados = 0;

  console.log("Sync ALMOXARIFADO MANTA (board 146) iniciada...");

  while (true) {
    const data = await buscarPagina(startAt);
    const issues = data.issues || [];
    if (issues.length === 0) break;

    for (const issue of issues) {
      const n = await atualizar(issue);
      if (n > 0) atualizados++; else ignorados++;
      lidos++;
    }

    startAt += issues.length;
    if (startAt >= (data.total || 0)) break;
  }

  console.log(\`Lidos: \${lidos} | Atualizados: \${atualizados} | Ignorados (sem registro): \${ignorados}\`);
  return { lidos, atualizados, ignorados };
}

try {
  const r = await processar();
  ctx.setRecordsProcessed(r.atualizados);
  ctx.setDetails(r);
} finally {
  await pool.end();
}
`.trim();

// Relatório Carbon: scraping do Carbon (Playwright) + de-para Jira, publicando
// carbon-latest.xlsx para download no PCP. Antes rodava como node-cron solto
// (jobs/carbonExportJob.js); agora vive no sistema versionado para aparecer no
// admin de crons e gravar cada execução em maestro.cron_runs.
//
// Reusa o serviço ESM existente via import() dinâmico — sem duplicar a lógica.
// require.resolve aponta para Orquestra_API/services relativo ao jobWorker.cjs
// (cron_jobs/), independente do cwd do processo.
const CARBON_EXPORT_CODE = `
const { pathToFileURL } = require("node:url");

const svcPath = require.resolve("../services/carbonReportService.js");
const { run } = await import(pathToFileURL(svcPath).href);

const result = await run();
if (!result || result.ok === false || result.error) {
  throw new Error(result && (result.error || result.message) || "ciclo do Relatório Carbon falhou");
}
ctx.setRecordsProcessed(result.rows ?? null);
ctx.setDetails(result);
`.trim();

// Vínculo de jira_key nos cutting_records (modelo PUSH). Antes o vínculo só
// acontecia quando alguém abria a tela de Corte (backfill no GET /cutting). Agora
// roda no cron: ~5 min após o card aparecer no espelho (sync_cards_jira), o corte
// já fica vinculado, independente de UI. Reusa o serviço ESM via import dinâmico
// (mesma fonte de heurística do apontamento — sem regra de board duplicada).
const BACKFILL_JIRA_KEYS_CODE = `
const { pathToFileURL } = require("node:url");

const svcPath = require.resolve("../services/cuttingJiraBackfill.js");
const { backfillCuttingJiraKeys } = await import(pathToFileURL(svcPath).href);

const result = await backfillCuttingJiraKeys({ limit: 500 });
ctx.setRecordsProcessed(result.filled);
ctx.setDetails(result);
`.trim();

const LEGACY_JOBS = [
  {
    name: 'sync_cards_jira',
    description: 'Sincroniza cards do Jira (project MANTA) com a tabela jira_cards.',
    cron_expression: '*/5 * * * *',
    code: SYNC_CARDS_JIRA_CODE,
  },
  {
    name: 'sync_almoxarifado_manta',
    description: 'Atualiza situacao, status e nota_fiscal em jira_cards a partir do board ALMOXARIFADO MANTA (board 146). Só atualiza cards já existentes.',
    cron_expression: '*/5 * * * *',
    code: SYNC_ALMOXARIFADO_MANTA_CODE,
  },
  {
    name: 'carbon_export',
    description: 'Relatório Carbon: scraping do Carbon (Playwright) + de-para Jira; publica carbon-latest.xlsx para download no PCP.',
    cron_expression: '*/15 * * * *',
    code: CARBON_EXPORT_CODE,
  },
  {
    name: 'backfill_jira_keys',
    description: 'Vincula jira_key nos cutting_records com NULL (modelo push, ~5 min após o card sincronizar). Mesma heurística do apontamento via resolveJiraCardForCutting.',
    cron_expression: '*/5 * * * *',
    code: BACKFILL_JIRA_KEYS_CODE,
  },
];

export async function migrateLegacyCronJobs() {
  for (const job of LEGACY_JOBS) {
    const existing = await query('SELECT id FROM maestro.cron_jobs WHERE name = $1', [job.name]);
    if (existing.rowCount > 0) {
      // job já cadastrado — não sobrescreve (preserva edições do usuário).
      continue;
    }

    const jobIns = await query(
      `INSERT INTO maestro.cron_jobs (name, description) VALUES ($1, $2) RETURNING id`,
      [job.name, job.description]
    );
    const jobId = jobIns.rows[0].id;

    await query(
      `INSERT INTO maestro.cron_job_versions
         (job_id, version_number, status, cron_expression, code, notes)
       VALUES ($1, 1.00, 'OPE', $2, $3, 'Migração inicial do .cjs legado.')`,
      [jobId, job.cron_expression, job.code]
    );

    console.log(`✅ Cron job legado migrado: ${job.name} (v1.00 OPE)`);
  }
}
