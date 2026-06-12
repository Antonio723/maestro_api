import express from 'express';
import { listProjectAudit, listOsGenerationAudit, rollbackOsGenerationAudit } from '../controllers/auditController.js';
import { listAccessGeo } from '../controllers/accessGeoController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/projects',      authenticate, requirePermission('audit_logs', 'read'), listProjectAudit);
router.get('/os-generation', authenticate, requirePermission('audit_logs', 'read'), listOsGenerationAudit);
router.post('/os-generation/:id/rollback', authenticate, requirePermission('audit_logs', 'export'), rollbackOsGenerationAudit);

// Localização (por IP) de quem acessa o site — somente para quem vê a auditoria
// de acessos (masters/admin). Ver middleware accessGeoLogger.
router.get('/geo',           authenticate, requirePermission('access_audit', 'read'), listAccessGeo);

export default router;
