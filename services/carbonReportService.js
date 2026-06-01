import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import axios from 'axios';
import ExcelJS from 'exceljs';
import { scrapeCarbonExcel } from './carbonScraperService.js';

// Orquestra o ciclo do Relatório Carbon:
//   1. scraping do Carbon (Playwright) -> xlsx bruto
//   2. lê a aba "data", coleta as OS
//   3. de-para com o Jira por cf[10256] (OS/PD)
//   4. sobrescreve ETAPA / previsões nas linhas correspondentes
//   5. escrita atômica do latest.xlsx (+ status.json)
//
// Credenciais do Jira vêm do ambiente (JIRA_URL/JIRA_EMAIL/JIRA_API_TOKEN),
// igual ao cron sync_cards_jira.cjs — o cron não tem usuário logado.

const TMP = process.env.CARBON_TMP_DIR || os.tmpdir();
export const LATEST_FILE = path.join(TMP, 'carbon-latest.xlsx');
export const STATUS_FILE = path.join(TMP, 'carbon-status.json');

// ===== Mapeamento Excel <-> Jira =====================================
// O export do Carbon tem UMA aba "data" (~1112 linhas x 31 colunas) com
// valores planos (sem fórmulas). Índices 0-based; exceljs é 1-based (col+1).
const EXCEL = {
  sheet: 'data',
  headerRow: 1,
  col: {
    OS: 0,
    ETAPA: 5,
    PREV_VIDRO: 17,
    PREV_ACO: 18,
    PREV_OPACO: 19, // OPACO ~ Manta
    PREV_TENSYLON: 20,
    PREV_SUP_VIDRO: 21,
  },
};

// Custom fields do Jira (confirmados no dump jira_kanban_custom_fields.txt)
const JIRA_FIELDS = {
  OS_PD: 'customfield_10256', // chave do de-para (mesma faixa da coluna OS)
  SITUACAO: 'customfield_10039', // -> ETAPA
  PREV_VIDRO: 'customfield_11448',
  PREV_ACO: 'customfield_11450',
  PREV_MANTA: 'customfield_11449', // -> OPACO
  PREV_TENSYLON: 'customfield_13064',
  PREV_SUP_VIDRO: 'customfield_12635',
};

const JIRA_REQUEST_FIELDS = [
  'status',
  JIRA_FIELDS.OS_PD,
  JIRA_FIELDS.SITUACAO,
  JIRA_FIELDS.PREV_VIDRO,
  JIRA_FIELDS.PREV_ACO,
  JIRA_FIELDS.PREV_MANTA,
  JIRA_FIELDS.PREV_TENSYLON,
  JIRA_FIELDS.PREV_SUP_VIDRO,
];

const BATCH_SIZE = 50;
const col1 = (i) => i + 1;

// Lock em memória: o ciclo pode passar de 15 min (Atualizar Todos demora).
let running = false;
export function isRunning() {
  return running;
}

// ===== Jira ==========================================================
function jiraAuthHeader() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildJql(osBatch) {
  const list = osBatch.map((o) => `"${String(o).replace(/"/g, '\\"')}"`).join(', ');
  const proj = process.env.JIRA_PROJECT ? `project = ${process.env.JIRA_PROJECT} AND ` : '';
  const cfId = JIRA_FIELDS.OS_PD.replace('customfield_', '');
  return `${proj}cf[${cfId}] in (${list}) ORDER BY updated DESC`;
}

function normSituacao(v) {
  if (v == null) return null;
  const s = typeof v === 'object' ? v.value || v.name || '' : String(v);
  // Remove emojis/bolinhas de cor do início (ex.: "⚫Aguardando entrada")
  return s.replace(/^[^\p{L}\p{N}]+/u, '').trim() || null;
}

function dateOnly(v) {
  if (!v) return null;
  return String(v).slice(0, 10);
}

async function fetchJiraByOs(osList) {
  const jiraUrl = process.env.JIRA_URL;
  if (!jiraUrl) throw new Error('JIRA_URL não configurado no ambiente');
  if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
    throw new Error('JIRA_EMAIL/JIRA_API_TOKEN não configurados no ambiente');
  }

  const unique = [...new Set(osList.map((o) => String(o).trim()).filter(Boolean))];
  if (unique.length === 0) return new Map();

  console.log(`[CarbonReport] de-para Jira para ${unique.length} OS`);
  const map = new Map();
  const url = `${jiraUrl}/rest/api/3/search/jql`;
  const auth = jiraAuthHeader();

  for (const batch of chunk(unique, BATCH_SIZE)) {
    const jql = buildJql(batch);
    let nextPageToken = null;
    do {
      const body = { jql, fields: JIRA_REQUEST_FIELDS, maxResults: 100 };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const resp = await axios.post(url, body, {
        headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 30000,
      });

      for (const issue of resp.data.issues || []) {
        const f = issue.fields || {};
        const os = String(f[JIRA_FIELDS.OS_PD] ?? '').trim();
        if (!os || map.has(os)) continue; // mantém o card mais recente (JQL ordena por updated DESC)
        map.set(os, {
          etapa: normSituacao(f[JIRA_FIELDS.SITUACAO]),
          prevVidro: dateOnly(f[JIRA_FIELDS.PREV_VIDRO]),
          prevAco: dateOnly(f[JIRA_FIELDS.PREV_ACO]),
          prevOpaco: dateOnly(f[JIRA_FIELDS.PREV_MANTA]),
          prevTensylon: dateOnly(f[JIRA_FIELDS.PREV_TENSYLON]),
          prevSupVidro: dateOnly(f[JIRA_FIELDS.PREV_SUP_VIDRO]),
        });
      }

      nextPageToken = resp.data.isLast ? null : resp.data.nextPageToken ?? null;
    } while (nextPageToken);
  }

  console.log(`[CarbonReport] Jira retornou ${map.size}/${unique.length} OS`);
  return map;
}

// ===== Excel =========================================================
function getSheet(wb) {
  const ws = wb.getWorksheet(EXCEL.sheet) || wb.worksheets[0];
  if (!ws) throw new Error('Planilha sem abas legíveis');
  return ws;
}

function getOsList(ws) {
  const list = [];
  const osCol = col1(EXCEL.col.OS);
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= EXCEL.headerRow) return;
    const v = row.getCell(osCol).value;
    if (v != null && String(v).trim() !== '') list.push(String(v).trim());
  });
  return list;
}

function setIfPresent(row, colIdx, value) {
  if (value == null || value === '') return;
  row.getCell(col1(colIdx)).value = value;
}

function applyJira(ws, jiraMap) {
  const c = EXCEL.col;
  const osCol = col1(c.OS);
  let matched = 0;
  let missing = 0;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= EXCEL.headerRow) return;
    const os = String(row.getCell(osCol).value ?? '').trim();
    if (!os) return;

    const j = jiraMap.get(os);
    if (!j) {
      missing++;
      return;
    }
    matched++;
    setIfPresent(row, c.ETAPA, j.etapa);
    setIfPresent(row, c.PREV_VIDRO, j.prevVidro);
    setIfPresent(row, c.PREV_ACO, j.prevAco);
    setIfPresent(row, c.PREV_OPACO, j.prevOpaco);
    setIfPresent(row, c.PREV_TENSYLON, j.prevTensylon);
    setIfPresent(row, c.PREV_SUP_VIDRO, j.prevSupVidro);
  });

  return { matched, missing };
}

// ===== Status ========================================================
function writeStatus(payload) {
  const status = { updatedAt: new Date().toISOString(), ...payload };
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (err) {
    console.warn('[CarbonReport] falha ao gravar status.json:', err.message);
  }
  return status;
}

export function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return { updatedAt: null, ok: false, message: 'sem execução registrada' };
  }
}

// ===== Ciclo completo ================================================
/**
 * Executa um ciclo: scrape -> de-para Jira -> publica latest.xlsx (atômico).
 * Pula se já houver um ciclo em andamento.
 * @param {{ scrape?: () => Promise<string> }} [opts] scraper injetável (testes)
 */
export async function run({ scrape = scrapeCarbonExcel } = {}) {
  if (running) {
    console.warn('[CarbonReport] ciclo anterior ainda em andamento; pulando');
    return { skipped: true };
  }
  running = true;
  const startedAt = Date.now();
  console.log('[CarbonReport] iniciando ciclo');

  try {
    const rawPath = await scrape();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(rawPath);
    const ws = getSheet(wb);
    const osList = getOsList(ws);

    const jiraMap = await fetchJiraByOs(osList);
    const merge = applyJira(ws, jiraMap);

    // Escrita atômica: grava em .tmp e renomeia por cima.
    const tmp = `${LATEST_FILE}.tmp`;
    await wb.xlsx.writeFile(tmp);
    fs.renameSync(tmp, LATEST_FILE);

    fs.rm(rawPath, { force: true }, () => {});

    const durationMs = Date.now() - startedAt;
    const stats = { ok: true, rows: osList.length, ...merge, durationMs };
    writeStatus(stats);
    console.log('[CarbonReport] ciclo concluído', stats);
    return stats;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error('[CarbonReport] ciclo falhou:', err.message);
    // Mantém o último latest.xlsx bom; registra a falha no status.
    writeStatus({ ok: false, message: err.message, durationMs });
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}
