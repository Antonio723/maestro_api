import cron from 'node-cron';
import { run } from '../services/carbonReportService.js';

// Cron do Relatório Carbon: a cada 15 min faz scraping do Carbon + de-para Jira
// e publica o latest.xlsx para download na tela do PCP.
export function startCarbonExportJob() {
  const expr = process.env.CARBON_CRON_EXPR || '*/15 * * * *';

  cron.schedule(
    expr,
    () => {
      run().catch((err) => console.error('[CarbonExport] Cron error:', err?.message || err));
    },
    { timezone: 'America/Sao_Paulo' }
  );

  console.log(`[CarbonExport] Job agendado — "${expr}".`);

  // Execução inicial opcional ao subir (gera o primeiro arquivo sem esperar 15 min).
  if (String(process.env.CARBON_RUN_ON_BOOT).toLowerCase() === 'true') {
    console.log('[CarbonExport] Executando ciclo inicial (CARBON_RUN_ON_BOOT).');
    run().catch((err) => console.error('[CarbonExport] Ciclo inicial falhou:', err?.message || err));
  }
}
