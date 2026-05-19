require("dotenv").config();

const axios = require("axios");
const { Pool } = require("pg");
const { recordRun, recordSkipped } = require("./recordRun.cjs");

const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "maestro",
  password: process.env.DB_PASSWORD || "postgres",
  port: process.env.DB_PORT || 5432,
});

const JIRA_URL = process.env.JIRA_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

const jiraClient = axios.create({
  baseURL: `${JIRA_URL}/rest/api/3`,
  auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
  timeout: 30_000,
});

const COMMON_FIELDS = [
  "issuetype",
  "summary",
  "status",
  "customfield_10039", // SITUAÇÃO
  "customfield_10040", // PEDIDO CARBON
  "customfield_10245", // DT. PREVISÃO ENTREGA
  "customfield_10256", // OS/PD
  "customfield_11069", // Marca
  "customfield_11070", // Modelo
  "customfield_11071", // Ano Modelo
  "customfield_11298", // Veiculo - Marca/Modelo
  "customfield_11353", // Nº do Projeto
];

function readOptionOrString(raw) {
  if (raw == null) return "";
  if (typeof raw === "object") return String(raw.value ?? raw.name ?? "").trim();
  return String(raw).trim();
}

function readDate(raw) {
  if (!raw) return null;
  const s = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function buildMotherRow(material, issue) {
  const f = issue.fields || {};
  const osPd = readOptionOrString(f.customfield_10256);
  const pedidoCarbon = readOptionOrString(f.customfield_10040);
  const numeroOs = osPd || pedidoCarbon || null;

  return {
    jira_key:         issue.key,
    material,
    project:          String(f?.project?.key || issue.key.split("-")[0] || "").trim() || null,
    tipo:             readOptionOrString(f.issuetype?.name || f.issuetype),
    resumo:           String(f.summary || ""),
    status:           String(f.status?.name || ""),
    situacao:         readOptionOrString(f.customfield_10039),
    numero_os:        numeroOs,
    numero_projeto:   readOptionOrString(f.customfield_11353) || null,
    veiculo:          readOptionOrString(f.customfield_11298) || null,
    marca:            readOptionOrString(f.customfield_11069) || null,
    modelo:           readOptionOrString(f.customfield_11070) || null,
    ano_modelo:       readOptionOrString(f.customfield_11071) || null,
    previsao_entrega: readDate(f.customfield_10245),
  };
}

// produced_at marca a PRIMEIRA transição para "Produzido" e nunca é
// sobrescrito (COALESCE preserva o valor existente). Mesmo padrão do
// sync_cards_jira.cjs legado em jira_cards.
const UPSERT_MOTHER_SQL = `
  INSERT INTO maestro.production_cards (
    jira_key, material, project, tipo, resumo, status, situacao,
    numero_os, numero_projeto, veiculo, marca, modelo, ano_modelo,
    previsao_entrega, produced_at, last_synced_at, updated_at
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
    CASE WHEN $6 = 'Produzido' THEN now() ELSE NULL END,
    now(),
    now()
  )
  ON CONFLICT (jira_key) DO UPDATE SET
    material         = EXCLUDED.material,
    project          = EXCLUDED.project,
    tipo             = EXCLUDED.tipo,
    resumo           = EXCLUDED.resumo,
    status           = EXCLUDED.status,
    situacao         = EXCLUDED.situacao,
    numero_os        = EXCLUDED.numero_os,
    numero_projeto   = EXCLUDED.numero_projeto,
    veiculo          = EXCLUDED.veiculo,
    marca            = EXCLUDED.marca,
    modelo           = EXCLUDED.modelo,
    ano_modelo       = EXCLUDED.ano_modelo,
    previsao_entrega = EXCLUDED.previsao_entrega,
    produced_at      = COALESCE(
      maestro.production_cards.produced_at,
      CASE WHEN EXCLUDED.status = 'Produzido' THEN now() ELSE NULL END
    ),
    last_synced_at   = now(),
    updated_at       = now()
`;

function buildChildUpsertSql(childTable, columns) {
  const cols = ["jira_key", ...columns, "updated_at"];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const setClause = columns.map((c) => `${c} = EXCLUDED.${c}`).join(",\n    ");
  return `
    INSERT INTO maestro.${childTable} (${cols.join(", ")})
    VALUES (${placeholders.replace(/\$\d+$/, "now()")})
    ON CONFLICT (jira_key) DO UPDATE SET
    ${setClause},
    updated_at = now()
  `;
}

async function fetchAllIssues(jql, fields) {
  const out = [];
  let nextPageToken = null;

  do {
    const params = { jql, maxResults: 100, fields: fields.join(",") };
    if (nextPageToken) params.nextPageToken = nextPageToken;

    const resp = await jiraClient.get("/search/jql", { params });
    out.push(...(resp.data.issues || []));
    nextPageToken = resp.data.isLast ? null : resp.data.nextPageToken ?? null;
  } while (nextPageToken);

  return out;
}

// Sincroniza um material executando JQL, upserting na mãe (production_cards)
// e na filha (childTable). mãe + filha numa transação por card pra garantir
// integridade do FK.
//
// config:
//   material       — 'VIDRO' | 'ACO' | 'MANTA' | 'TENSYLON' | 'SUP_VIDRO'
//   jql            — JQL completa
//   extraFields    — array de customfields adicionais p/ a filha
//   childTable     — ex: 'producao_vidro'
//   childColumns   — array com nomes das colunas da filha (sem jira_key/updated_at)
//   mapChild(issue) — função que retorna objeto { colName: value, ... }
async function runMaterialSync(config) {
  const { material, jql, extraFields, childTable, childColumns, mapChild } = config;

  const allFields = [...new Set([...COMMON_FIELDS, ...(extraFields || [])])];
  const issues = await fetchAllIssues(jql, allFields);

  const childUpsertSql = buildChildUpsertSql(childTable, childColumns);
  let processed = 0;

  for (const issue of issues) {
    const mother = buildMotherRow(material, issue);
    const childData = mapChild(issue) || {};
    const childValues = [mother.jira_key, ...childColumns.map((c) => childData[c] ?? null)];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(UPSERT_MOTHER_SQL, [
        mother.jira_key,
        mother.material,
        mother.project,
        mother.tipo,
        mother.resumo,
        mother.status,
        mother.situacao,
        mother.numero_os,
        mother.numero_projeto,
        mother.veiculo,
        mother.marca,
        mother.modelo,
        mother.ano_modelo,
        mother.previsao_entrega,
      ]);
      await client.query(childUpsertSql, childValues);
      await client.query("COMMIT");
      processed++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`[${material}] erro ao salvar ${issue.key}:`, err.message);
    } finally {
      client.release();
    }
  }

  return processed;
}

// Encapsula o boilerplate de schedule+mutex+recordRun pro cron por material.
// Cada arquivo sync_<material>.cjs chama esta função e nada mais.
function scheduleMaterialJob({ jobName, cronExpr = "*/5 * * * *", syncConfig }) {
  let running = false;

  async function runOnce() {
    if (running) {
      console.log(`[${jobName}] ainda em execução, pulando...`);
      await recordSkipped(jobName, "Execução anterior ainda em andamento");
      return;
    }
    running = true;
    console.log(`\n[${jobName}] iniciando sincronização...`);
    try {
      await recordRun(jobName, async (ctx) => {
        const total = await runMaterialSync(syncConfig);
        ctx.setRecordsProcessed(total);
        console.log(`[${jobName}] sincronizados: ${total}`);
      });
    } catch (err) {
      console.error(`[${jobName}] erro geral:`, err.message);
    } finally {
      running = false;
    }
  }

  const cron = require("node-cron");
  cron.schedule(cronExpr, runOnce, { timezone: "America/Sao_Paulo" });

  if (process.env.NODE_ENV === "production") {
    runOnce().catch((err) => console.error(`[${jobName}] erro inicial:`, err.message));
  } else {
    console.log(`[${jobName}] dev mode — schedule "${cronExpr}" registrado, sem run inicial`);
  }
}

module.exports = {
  scheduleMaterialJob,
  runMaterialSync,
  readOptionOrString,
  readDate,
};
