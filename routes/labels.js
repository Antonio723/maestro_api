import express from 'express';
import {
  listFiles,
  listItems,
  labelPreviewPdf,
  downloadZpl,
  printItem,
  listPrinters,
} from '../controllers/labelsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/files',       authenticate, requirePermission('etiquetas', 'read'),  listFiles);
router.get('/printers',    authenticate, requirePermission('etiquetas', 'read'),  listPrinters);
router.get('/items',       authenticate, requirePermission('etiquetas', 'read'),  listItems);
router.get('/preview.pdf', authenticate, requirePermission('etiquetas', 'read'),  labelPreviewPdf);
router.get('/zpl',         authenticate, requirePermission('etiquetas', 'download'), downloadZpl);
router.post('/print',      authenticate, requirePermission('etiquetas', 'print'), printItem);

export default router;
