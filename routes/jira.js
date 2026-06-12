import express from 'express';
import multer from 'multer';
import {
  getJiraIssues,
  getContecIssues,
  getPCPRelatorio,
  getMantaRelatorio,
  getCarbonRelatorio,
  getCarbonRelatorioStatus,
  reprogramarEmMassa,
  atualizarDatasIndividuais,
  buscarArquivosPorIds,
  imprimirOpsPorIds,
  downloadArquivo,
  downloadArquivoJira,
  gerarEspelhos,
  obterLogsEspelhos,
  listarProjetosEspelhos,
  obterProjetoEspelho,
  obterEstatisticasProjetos,
  listarProjects,
  obterProjectById,
  criarProject,
  atualizarProject,
  clonarProject,
  excluirProject,
  obterMarcasUnicas
} from '../controllers/jiraController.js';
import { attachNf, attachNfStatus } from '../controllers/jiraAttachController.js';
import { getDashboardProcessos } from '../controllers/dashboardProcessosController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// PCP — Jira proxy
router.get('/issues',          authenticate, requirePermission('pcp_orders', 'read'),   getJiraIssues);
router.get('/contec',          authenticate, requirePermission('pcp_orders', 'read'),   getContecIssues);
router.get('/pcp-relatorio',   authenticate, requirePermission('pcp_reports', 'read'),  getPCPRelatorio);
router.get('/manta-relatorio', authenticate, requirePermission('pcp_reports', 'read'),  getMantaRelatorio);
router.get('/carbon-relatorio',        authenticate, requirePermission('pcp_reports', 'read'),  getCarbonRelatorio);
router.get('/carbon-relatorio/status', authenticate, requirePermission('pcp_reports', 'read'),  getCarbonRelatorioStatus);
router.get('/dashboard-processos',     authenticate, requirePermission('pcp_reports', 'read'),  getDashboardProcessos);
router.post('/reprogramar-massa',          authenticate, requirePermission('pcp_orders', 'update'), reprogramarEmMassa);
router.post('/atualizar-datas-individuais', authenticate, requirePermission('pcp_orders', 'update'), atualizarDatasIndividuais);
router.post('/buscar-arquivos',            authenticate, requirePermission('pcp_orders', 'read'),   buscarArquivosPorIds);
router.post('/imprimir-ops',               authenticate, requirePermission('pcp_orders', 'read'),   imprimirOpsPorIds);
router.get('/download-arquivo/:cardId/:directory/*',                        authenticate, requirePermission('pcp_orders', 'read'), downloadArquivo);
router.get('/download-arquivo-jira/:cardId/:attachmentId/:filename',        authenticate, requirePermission('pcp_orders', 'read'), downloadArquivoJira);

// Espelhos — generation + logs
router.post('/gerar-espelhos', authenticate, requirePermission('espelhos', 'create'), upload.array('arquivoProjeto[]', 10), gerarEspelhos);
router.get('/logs-espelhos',   authenticate, requirePermission('espelhos', 'read'),   obterLogsEspelhos);

// Espelhos — projetos-espelhos (legacy)
router.get('/projetos-espelhos',       authenticate, requirePermission('espelhos', 'read'), listarProjetosEspelhos);
router.get('/projetos-espelhos-stats', authenticate, requirePermission('espelhos', 'read'), obterEstatisticasProjetos);
router.get('/projetos-espelhos/:id',   authenticate, requirePermission('espelhos', 'read'), obterProjetoEspelho);

// Etapa 5 — sincroniza PDF da NF para o card Jira correspondente.
router.post('/attach-nf',        authenticate, requirePermission('invoicing', 'update'), upload.single('file'), attachNf);
router.get('/attach-nf/status',  authenticate, requirePermission('invoicing', 'read'),   attachNfStatus);

// Espelhos — maestro.project CRUD
router.get('/projects/brands',  authenticate, requirePermission('espelhos', 'read'),   obterMarcasUnicas);
router.get('/projects',         authenticate, requirePermission('espelhos', 'read'),   listarProjects);
router.get('/projects/:id',     authenticate, requirePermission('espelhos', 'read'),   obterProjectById);
router.post('/projects',        authenticate, requirePermission('espelhos', 'create'), criarProject);
router.put('/projects/:id',     authenticate, requirePermission('espelhos', 'update'), atualizarProject);
router.post('/projects/:id/clone', authenticate, requirePermission('espelhos', 'clone'),  clonarProject);
router.delete('/projects/:id',  authenticate, requirePermission('espelhos', 'delete'), excluirProject);

export default router;
