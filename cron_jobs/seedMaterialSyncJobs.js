// Semeia os jobs versionados da Produção Unificada de Materiais (1 por domínio):
//   - sync_os_snapshot: card-pai Apontamento Produção (AP) -> os_snapshot
//   - sync_fabrica_<material>: cada fábrica -> producao_<material>
//
// Idempotente: se o job já existe (por nome), não sobrescreve (preserva edições
// feitas pela UI de crons). O código de cada job apenas chama o helper
// cron_jobs/jiraFabricaSync.cjs (require relativo ao jobWorker.cjs, em cron_jobs/).
import { query } from '../config/database.js';

const codeOsSnapshot = `
const svc = require("./jiraFabricaSync.cjs");
const result = await svc.syncOsSnapshot();
ctx.setRecordsProcessed(result.gravados);
ctx.setDetails(result);
`.trim();

const codeFabrica = (material) => `
const svc = require("./jiraFabricaSync.cjs");
const result = await svc.syncFabrica("${material}");
ctx.setRecordsProcessed(result.gravados);
ctx.setDetails(result);
`.trim();

// Agendamentos escalonados (a cada 15 min, ~2 min de defasagem entre si) para
// diluir a carga no Jira.
const MATERIAL_JOBS = [
  {
    name: 'sync_os_snapshot',
    description: 'Apontamento Produção (AP) -> maestro.os_snapshot (tabela-mãe por OS: veículo, etapa, previsões por material).',
    cron_expression: '2,17,32,47 * * * *',
    code: codeOsSnapshot,
  },
  {
    name: 'sync_fabrica_vidro',
    description: 'Fábrica de Vidro (VIDRO) -> maestro.producao_vidro.',
    cron_expression: '4,19,34,49 * * * *',
    code: codeFabrica('vidro'),
  },
  {
    name: 'sync_fabrica_aco',
    description: 'Fábrica de Aço (ACO) -> maestro.producao_aco.',
    cron_expression: '6,21,36,51 * * * *',
    code: codeFabrica('aco'),
  },
  {
    name: 'sync_fabrica_manta',
    description: 'Fábrica de Manta (MANTA) -> maestro.producao_manta.',
    cron_expression: '8,23,38,53 * * * *',
    code: codeFabrica('manta'),
  },
  {
    name: 'sync_fabrica_tensylon',
    description: 'Fábrica de Tensylon (TENSYLON) -> maestro.producao_tensylon.',
    cron_expression: '10,25,40,55 * * * *',
    code: codeFabrica('tensylon'),
  },
  {
    name: 'sync_fabrica_sup_vidro',
    description: 'Suporte Vidro (SVIDRO) -> maestro.producao_sup_vidro.',
    cron_expression: '12,27,42,57 * * * *',
    code: codeFabrica('sup_vidro'),
  },
  {
    name: 'sync_etapa_pb',
    description: 'Produção Blindados (PB) -> os_snapshot.etapa_pb (estágio detalhado de produção por OS).',
    cron_expression: '14,29,44,59 * * * *',
    code: `
const svc = require("./jiraFabricaSync.cjs");
const result = await svc.syncEtapaPB();
ctx.setRecordsProcessed(result.gravados);
ctx.setDetails(result);
`.trim(),
  },
];

export async function seedMaterialSyncJobs() {
  for (const job of MATERIAL_JOBS) {
    const existing = await query('SELECT id FROM maestro.cron_jobs WHERE name = $1', [job.name]);
    if (existing.rowCount > 0) continue;

    const jobIns = await query(
      `INSERT INTO maestro.cron_jobs (name, description) VALUES ($1, $2) RETURNING id`,
      [job.name, job.description],
    );
    const jobId = jobIns.rows[0].id;

    await query(
      `INSERT INTO maestro.cron_job_versions
         (job_id, version_number, status, cron_expression, code, notes)
       VALUES ($1, 1.00, 'OPE', $2, $3, 'Produção Unificada de Materiais — seed inicial.')`,
      [jobId, job.cron_expression, job.code],
    );

    console.log(`✅ Cron de material semeado: ${job.name} (v1.00 OPE)`);
  }
}
