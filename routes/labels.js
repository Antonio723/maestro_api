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

// A impressão é feita no navegador da máquina cliente (a VPS não alcança a
// impressora da LAN). Aqui ficam só os dados das peças e o ZPL/PDF de modelo.
router.get('/files',       authenticate, requirePermission('etiquetas', 'read'),  listFiles);
router.get('/items',       authenticate, requirePermission('etiquetas', 'read'),  listItems);
router.get('/preview.pdf', authenticate, requirePermission('etiquetas', 'read'),  labelPreviewPdf);
router.get('/zpl',         authenticate, requirePermission('etiquetas', 'download'), downloadZpl);

export default router;
