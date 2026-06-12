import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import jiraRoutes from './routes/jira.js';
import printRoutes from './routes/print.js';
import ordensDiariasRoutes from './routes/ordensDiarias.js';
import cuttingProjectsRoutes from './routes/cuttingPlans.js';
import filesRoutes from './routes/files.js';
import mirrorsRoutes from './routes/mirrors.js';
import auditRoutes from './routes/audit.js';
import qualityRoutes from './routes/quality.js';
import plateSuppliersRoutes from './routes/plateSuppliers.js';
import panelReceiptsRoutes from './routes/panelReceipts.js';
import panelReservationsRoutes from './routes/panelReservations.js';
import panelConsumptionsRoutes from './routes/panelConsumptions.js';
import fabricSuppliersRoutes from './routes/fabricSuppliers.js';
import osPlanningRoutes from './routes/osPlanning.js';
import productionPacksRoutes from './routes/productionPacks.js';
import cronRunsRoutes from './routes/cronRuns.js';
import cronJobsRoutes from './routes/cronJobs.js';
import reportTemplatesRoutes from './routes/reportTemplates.js';
import cuttingRomaneioRoutes from './routes/cuttingRomaneio.js';
import materialsRoutes from './routes/materials.js';
import conformityCertificatesRoutes from './routes/conformityCertificates.js';
import productionConfigRoutes from './routes/productionConfig.js';
import appPreferencesRoutes from './routes/appPreferences.js';
import rastreabilidadesRoutes from './routes/rastreabilidades.js';
import workorderRoutes from './routes/workorder.js';
import plateRoutes from './routes/plate.js';
import plateEventsRoutes from './routes/plateEvents.js';
import autoclaveRoutes from './routes/autoclave.js';
import cuttingRoutes from './routes/cutting.js';
import tensylonEnfestoRoutes from './routes/tensylonEnfesto.js';
import invoiceRoutes from './routes/invoices.js';
import receiptRoutes from './routes/receipt.js';
import labelsRoutes from './routes/labels.js';
import { ensureDatabaseCompatibility } from './config/database.js';
import { accessGeoLogger } from './middleware/accessGeoLogger.js';
import { loadOpeVersions } from './cron_jobs/scheduler.js';
import { migrateLegacyCronJobs } from './cron_jobs/migrateLegacyJobs.js';
import { seedMaterialSyncJobs } from './cron_jobs/seedMaterialSyncJobs.js';
import { startRoleExpirationJob } from './jobs/roleExpirationJob.js';

// Carregar variáveis de ambiente
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Confiar no proxy reverso (nginx/Caddy) para X-Forwarded-Proto
app.set('trust proxy', 1);

// Middlewares
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} não permitido por CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Step-Up-Token'],
  exposedHeaders: ['Content-Disposition', 'X-OS-Failures', 'X-OS-Field-Warnings']
}));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Registra (em segundo plano, sem atrasar a request) a localização por IP de
// quem acessa a API — consultável em Auditoria > Localização.
app.use('/api', accessGeoLogger);

// Log de requisições (desenvolvimento)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`, req.body);
    next();
  });
}

// Rota de health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Maestro API está rodando!',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Rotas da API
app.use('/api/auth', authRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/print', printRoutes);
app.use('/api/ordens-diarias', ordensDiariasRoutes);
app.use('/api/cutting-projects', cuttingProjectsRoutes);
app.use('/api/files',            filesRoutes);
app.use('/api/mirrors',          mirrorsRoutes);
app.use('/api/audit',            auditRoutes);
app.use('/api/quality',          qualityRoutes);
app.use('/api/plate-suppliers',  plateSuppliersRoutes);
app.use('/api/panel-receipts',   panelReceiptsRoutes);
app.use('/api/panel-reservations', panelReservationsRoutes);
app.use('/api/panel-consumptions', panelConsumptionsRoutes);
app.use('/api/fabric-suppliers', fabricSuppliersRoutes);
app.use('/api/os-planning',      osPlanningRoutes);
app.use('/api/production-packs', productionPacksRoutes);
app.use('/api/cron-runs',        cronRunsRoutes);
app.use('/api/cron-jobs',        cronJobsRoutes);
app.use('/api/report-templates', reportTemplatesRoutes);
app.use('/api/cutting-romaneio', cuttingRomaneioRoutes);
app.use('/api/materials',                materialsRoutes);
app.use('/api/conformity-certificates',  conformityCertificatesRoutes);
app.use('/api/production-config',        productionConfigRoutes);
app.use('/api/app-preferences',          appPreferencesRoutes);
app.use('/api/rastreabilidades',         rastreabilidadesRoutes);
app.use('/api/workorder',                workorderRoutes);
app.use('/api/plate',                    plateRoutes);
app.use('/api/plate-events',             plateEventsRoutes);
app.use('/api/autoclave',                autoclaveRoutes);
app.use('/api/cutting',                  cuttingRoutes);
app.use('/api/tensylon-enfesto',         tensylonEnfestoRoutes);
app.use('/api/labels',                   labelsRoutes);
app.use('/api',                          invoiceRoutes);
app.use('/api/receipt',                  receiptRoutes);

// Rota 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Rota não encontrada'
  });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Erro interno do servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Iniciar servidor com fallback de porta para desenvolvimento
function startServer(initialPort) {
  const server = app.listen(initialPort, () => {
    console.log('🚀 Servidor rodando na porta:', initialPort);
    console.log(`📡 API disponível em: http://localhost:${initialPort}`);
    console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = initialPort + 1;
      console.error(`⚠️ Porta ${initialPort} em uso. Tentando porta ${nextPort}...`);
      startServer(nextPort);
      return;
    }

    console.error('❌ Erro ao iniciar servidor:', err);
    process.exit(1);
  });
}

async function bootstrap() {
  try {
    await ensureDatabaseCompatibility();
    await migrateLegacyCronJobs();
    await seedMaterialSyncJobs();
    await loadOpeVersions();
    startRoleExpirationJob();
    // O Relatório Carbon agora roda pelo scheduler central (job 'carbon_export'
    // em maestro.cron_jobs, semeado por migrateLegacyCronJobs) — não há mais
    // agendamento solto aqui.
    startServer(PORT);
  } catch (error) {
    console.error('❌ Erro ao validar estrutura do banco:', error);
    process.exit(1);
  }
}

bootstrap();

// Tratamento de erros não capturados
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

// Cron jobs legados (.cjs) foram migrados para maestro.cron_jobs/cron_job_versions
// e agora são executados pelo scheduler central (loadOpeVersions). Os arquivos
// .cjs permanecem em disco apenas como referência histórica.
