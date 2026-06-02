require("dotenv").config();

const axios = require("axios");
const cron = require("node-cron");
const { Pool } = require("pg");
const { recordRun, recordSkipped } = require("./recordRun.cjs");

// ============================================================================
// REFERÊNCIA — o cron que de fato roda em produção é a versão OPE no banco
// (maestro.cron_job_versions), semeada por migrateLegacyJobs.js. Este arquivo
// existe só como documentação/execução standalone, no mesmo padrão de
// sync_cards_jira.cjs.
//
// Board ALMOXARIFADO MANTA (id 146, projeto MANTA): atualiza SOMENTE linhas
// já existentes em jira_cards e SOMENTE os campos situacao, status e
// nota_fiscal. Cards do board ainda sem registro são ignorados — a produção
// (sync_cards_jira) continua dona do registro e dos demais campos.
// ============================================================================

const JOB_NAME = "sync_almoxarifado_manta";
let rodando = false;

// ==========================
// DATABASE
// ==========================
const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "maestro",
  password: process.env.DB_PASSWORD || "postgres",
  port: process.env.DB_PORT || 5432,
});

// ==========================
// JIRA CONFIG (Agile API)
// ==========================
const JIRA_URL = process.env.JIRA_URL;
const EMAIL = process.env.JIRA_EMAIL;
const API_TOKEN = process.env.JIRA_API_TOKEN;

const BOARD_ID = 146; // ALMOXARIFADO MANTA

const client = axios.create({
  baseURL: `${JIRA_URL}/rest/agile/1.0`,
  auth: {
    username: EMAIL,
    password: API_TOKEN,
  },
});

// ==========================
// HELPERS
// ==========================
function unwrap(raw) {
  if (raw == null) return "";
  if (typeof raw === "object") return String(raw.value ?? raw.name ?? "").trim();
  return String(raw).trim();
}

function normalizeNotaFiscal(raw) {
  const v = unwrap(raw);
  if (!v) return null;
  // customfield_10101 é número (ex.: 46433.0) — remove o ".0" decimal
  return v.replace(/\.0+$/, "");
}

// ==========================
// UPDATE (somente existentes)
// ==========================
// Mexe APENAS em situacao, status e nota_fiscal. WHERE key = $1 garante que
// cards do board ainda sem registro em jira_cards sejam ignorados (rowCount 0).
async function atualizar(issue) {
  const fields = issue.fields || {};
  const status = unwrap(fields.status?.name);
  const situacao = unwrap(fields.customfield_10039);
  const notaFiscal = normalizeNotaFiscal(fields.customfield_10101);

  try {
    const res = await pool.query(
      `UPDATE maestro.jira_cards
          SET status = $2,
              situacao = $3,
              nota_fiscal = $4,
              last_updated_at = NOW()
        WHERE key = $1`,
      [issue.key, status, situacao, notaFiscal]
    );
    return res.rowCount;
  } catch (err) {
    console.error(`Erro ao atualizar ${issue.key}:`, err.message);
    return 0;
  }
}

// ==========================
// BUSCAR ISSUES DO BOARD
// ==========================
async function buscarPagina(startAt) {
  const params = {
    startAt,
    maxResults: 100,
    fields: "status,customfield_10039,customfield_10101",
  };
  const { data } = await client.get(`/board/${BOARD_ID}/issue`, { params });
  return data;
}

// ==========================
// PROCESSAMENTO
// ==========================
async function processar() {
  let startAt = 0;
  let lidos = 0;
  let atualizados = 0;
  let ignorados = 0;

  console.log(" Sync ALMOXARIFADO MANTA (board 146) iniciada...");

  while (true) {
    const data = await buscarPagina(startAt);
    const issues = data.issues || [];
    if (issues.length === 0) break;

    for (const issue of issues) {
      const n = await atualizar(issue);
      if (n > 0) atualizados++;
      else ignorados++;
      lidos++;
    }

    startAt += issues.length;
    if (startAt >= (data.total || 0)) break;
  }

  console.log(
    `🏁 Lidos: ${lidos} | Atualizados: ${atualizados} | Ignorados (sem registro): ${ignorados}`
  );
  return { lidos, atualizados, ignorados };
}

// ==========================
// CRON
// ==========================
cron.schedule(
  "*/5 * * * *",
  async () => {
    if (rodando) {
      console.log("⏳ Ainda em execução, pulando...");
      await recordSkipped(JOB_NAME, "Execução anterior ainda em andamento");
      return;
    }

    rodando = true;
    console.log("\n⏰ Rodando sincronização do almoxarifado...");

    try {
      await recordRun(JOB_NAME, async (ctx) => {
        const r = await processar();
        ctx.setRecordsProcessed(r.atualizados);
        ctx.setDetails(r);
      });
    } catch (err) {
      console.error("❌ Erro geral:", err.message);
    } finally {
      rodando = false;
    }
  },
  {
    timezone: "America/Sao_Paulo",
  }
);

// ==========================
//  EXECUÇÃO INICIAL
// ==========================
const isProd = process.env.NODE_ENV === "production";

if (isProd) {
  console.log("Executando em:", new Date().toISOString());
  recordRun(JOB_NAME, async (ctx) => {
    const r = await processar();
    ctx.setRecordsProcessed(r.atualizados);
    ctx.setDetails(r);
  }).catch((err) => console.error("❌ Erro geral:", err.message));
} else {
  console.log("################");
  console.log(
    `Script Sync Almoxarifado Manta Ambiente: ${process.env.NODE_ENV} | rodar? ${isProd}`
  );
  console.log("---------------");
}
