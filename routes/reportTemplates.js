import express from 'express';
import multer from 'multer';
import {
  listTemplates, getTemplate, getVersionJrxml,
  createTemplate, deleteTemplate,
  createVersion, updateVersion, deleteVersion,
  renderByKey, renderVersion,
} from '../controllers/reportTemplatesController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// .jrxml é XML pequeno → guardamos em memória para parsear/armazenar o conteúdo.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Render do uso (versão OPE). Mantido antes do '/:id' para não colidir com a rota param.
// ⚠️ HOTFIX ACESSO ABERTO: a impressão de etiquetas do Enfesto roda sem login,
// então SOMENTE o render (/render/:key) usa openAuth. A gestão de templates
// (tela Admin/Relatórios) segue protegida. Ver middleware/optionalAuth.js.
router.post('/render/:key', openAuth, renderByKey);

router.get('/',    authenticate, requirePermission('report_templates', 'read'),   listTemplates);
router.get('/:id', authenticate, requirePermission('report_templates', 'read'),   getTemplate);
router.post('/',   authenticate, requirePermission('report_templates', 'create'), upload.single('jrxml'), createTemplate);
router.delete('/:id', authenticate, requirePermission('report_templates', 'delete'), deleteTemplate);

router.get('/:id/versions/:vid/jrxml',   authenticate, requirePermission('report_templates', 'read'),    getVersionJrxml);
router.post('/:id/versions',             authenticate, requirePermission('report_templates', 'create'),  upload.single('jrxml'), createVersion);
router.patch('/:id/versions/:vid',       authenticate, requirePermission('report_templates', 'update'),  upload.single('jrxml'), updateVersion);
router.delete('/:id/versions/:vid',      authenticate, requirePermission('report_templates', 'delete'),  deleteVersion);
router.post('/:id/versions/:vid/render', authenticate, requirePermission('report_templates', 'execute'), renderVersion);

export default router;
