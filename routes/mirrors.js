import express from 'express';
import { getProjects, getAramidaProjects, getTensylonProjects, getLiberadoEngenhariaProjects, getPrevisaoMaterial, generateOS, getJiraFieldsList, getDimensions, getFactories } from '../controllers/mirrorsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

// Material-specific routes must come before the generic /projects route.
router.get('/projects/aramida',  authenticate, requirePermission('espelhos', 'read'),   getAramidaProjects);
router.get('/projects/tensylon', authenticate, requirePermission('espelhos', 'read'),   getTensylonProjects);
router.get('/projects/liberado-engenharia', authenticate, requirePermission('espelhos', 'read'), getLiberadoEngenhariaProjects);
router.get('/dimensions',        authenticate, requirePermission('espelhos', 'read'),   getDimensions);
router.get('/factories',         authenticate, requirePermission('espelhos', 'read'),   getFactories);
router.get('/projects',          authenticate, requirePermission('espelhos', 'read'),   getProjects);
router.get('/previsao-material', authenticate, requirePermission('espelhos', 'read'),   getPrevisaoMaterial);
router.post('/generate-os',      authenticate, requirePermission('espelhos', 'create'), generateOS);

// Diagnostic: list all Jira fields to find correct customfield IDs.
// Usage: GET /api/mirrors/jira-fields?search=metro
router.get('/jira-fields',       authenticate, requirePermission('espelhos', 'read'),   getJiraFieldsList);

export default router;
