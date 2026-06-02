// Scheduler central de cron jobs versionados.
//
// Responsabilidades:
//   - Na inicialização, carregar todas as versões em status OPE e agendar.
//   - Quando OPE muda (promoção/edição), reagendar via rescheduleJob().
//   - Executar versões manualmente via runVersionById() (botão ▶ na UI).
//   - Isolar execução em worker_threads (jobWorker.cjs) com timeout.
//   - Persistir cada execução em maestro.cron_runs (compatível com a tela de auditoria existente).

import cron from 'node-cron';
import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'jobWorker.cjs');

// Cap de execução do worker. Precisa ser maior que o budget interno dos jobs
// (ex.: Relatório Carbon ~30 min) para não matar a execução antes da hora.
// Configurável por env; default 45 min.
const DEFAULT_TIMEOUT_MS = Number(process.env.CRON_JOB_TIMEOUT_MS) || 45 * 60 * 1000;

// jobName -> { task, versionId, jobId }
const scheduledTasks = new Map();
// Mutex: jobName em execução
const runningJobs = new Set();

export async function loadOpeVersions() {
  const { rows } = await query(`
    SELECT j.id AS job_id, j.name, v.id AS version_id, v.cron_expression, v.code
    FROM maestro.cron_jobs j
    JOIN maestro.cron_job_versions v ON v.job_id = j.id AND v.status = 'OPE'
  `);
  for (const row of rows) {
    scheduleVersion(row.job_id, row.name, row.version_id, row.cron_expression, row.code);
  }
  console.log(`✅ Scheduler: ${rows.length} cron(s) carregado(s)`);
}

function scheduleVersion(jobId, jobName, versionId, cronExpr, code) {
  if (!cron.validate(cronExpr)) {
    console.error(`❌ Cron inválido para ${jobName}: ${cronExpr}`);
    return;
  }

  unschedule(jobName);

  const task = cron.schedule(
    cronExpr,
    () => {
      runVersionInWorker(jobName, versionId, code).catch((err) => {
        console.error(`❌ Erro no cron ${jobName}:`, err?.message || err);
      });
    },
    { timezone: 'America/Sao_Paulo' }
  );

  scheduledTasks.set(jobName, { task, versionId, jobId });
  console.log(`📅 Agendado ${jobName} (v.id=${versionId}) — "${cronExpr}"`);
}

function unschedule(jobName) {
  const existing = scheduledTasks.get(jobName);
  if (existing) {
    existing.task.stop();
    scheduledTasks.delete(jobName);
    console.log(`🛑 Removido agendamento de ${jobName}`);
  }
}

// Chamado pelo controller após qualquer mudança que possa afetar a versão OPE
// (promoção, edição de cron_expression na OPE, exclusão de versão OPE).
export async function rescheduleJob(jobId) {
  const { rows } = await query(
    `SELECT j.id AS job_id, j.name, v.id AS version_id, v.cron_expression, v.code
     FROM maestro.cron_jobs j
     LEFT JOIN maestro.cron_job_versions v ON v.job_id = j.id AND v.status = 'OPE'
     WHERE j.id = $1`,
    [jobId]
  );
  if (rows.length === 0) return;
  const row = rows[0];

  if (!row.version_id) {
    unschedule(row.name);
    return;
  }
  scheduleVersion(row.job_id, row.name, row.version_id, row.cron_expression, row.code);
}

// Execução de uma versão por id — usado pelo botão "▶ Executar agora" na UI.
// Funciona com versões de qualquer status (DVP/SAT/REL/OPE).
export async function runVersionById(versionId, opts = {}) {
  const { rows } = await query(
    `SELECT j.name, v.id AS version_id, v.code, v.status
     FROM maestro.cron_job_versions v
     JOIN maestro.cron_jobs j ON j.id = v.job_id
     WHERE v.id = $1`,
    [versionId]
  );
  if (rows.length === 0) throw new Error('Versão não encontrada');
  const v = rows[0];
  return runVersionInWorker(v.name, v.version_id, v.code, opts);
}

async function runVersionInWorker(jobName, versionId, code, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (runningJobs.has(jobName)) {
    await query(
      `INSERT INTO maestro.cron_runs (job_name, status, finished_at, error_message)
       VALUES ($1, 'skipped', now(), $2)`,
      [jobName, 'Execução anterior ainda em andamento']
    );
    return { skipped: true };
  }

  runningJobs.add(jobName);

  const insert = await query(
    `INSERT INTO maestro.cron_runs (job_name, status) VALUES ($1, 'running') RETURNING id`,
    [jobName]
  );
  const runId = insert.rows[0].id;

  let records = null;
  let details = null;
  let errorMessage = null;
  let status = 'success';

  try {
    await new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: { jobName, versionId, runId, code },
      });

      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error(`Timeout após ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      worker.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'records')      records = msg.value;
        else if (msg.type === 'details') details = msg.value;
        else if (msg.type === 'log')     console.log(`[${jobName}]`, ...(msg.args || []));
        else if (msg.type === 'error')   errorMessage = msg.message;
      });

      worker.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      worker.on('exit', (exitCode) => {
        clearTimeout(timeout);
        if (exitCode === 0) resolve();
        else reject(new Error(errorMessage || `Worker terminou com código ${exitCode}`));
      });
    });
  } catch (err) {
    status = 'error';
    errorMessage = err?.message || String(err);
  } finally {
    runningJobs.delete(jobName);
  }

  await query(
    `UPDATE maestro.cron_runs
        SET finished_at = now(),
            status = $2,
            records_processed = $3,
            error_message = $4,
            details = $5
      WHERE id = $1`,
    [runId, status, records, errorMessage, details ? JSON.stringify(details) : null]
  );

  return { runId, status, errorMessage };
}
