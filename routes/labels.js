import express from 'express';
import {
  listFiles,
  listItems,
  labelPreviewPdf,
  downloadZpl,
} from '../controllers/labelsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

// A impressao acontece na maquina cliente Windows via agente local. A API Linux
// apenas entrega dados, preview e ZPL.
router.get('/files',       authenticate, requirePermission('etiquetas', 'read'),  listFiles);
router.get('/items',       authenticate, requirePermission('etiquetas', 'read'),  listItems);
router.get('/preview.pdf', authenticate, requirePermission('etiquetas', 'read'),  labelPreviewPdf);
router.get('/zpl',         authenticate, requirePermission('etiquetas', 'print'), downloadZpl);

export default router;
