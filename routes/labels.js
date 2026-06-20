import express from 'express';
import {
  listFiles,
  listItems,
  labelPreviewPdf,
  downloadZpl,
  downloadAgent,
} from '../controllers/labelsController.js';

const router = express.Router();

// ⚠️ ACESSO ABERTO: a tela de Etiquetagem opera SEM login (estação de corte/kiosk).
// Por isso estas rotas NÃO usam authenticate/requirePermission. A impressão
// acontece na máquina cliente Windows via agente local; a API Linux apenas
// entrega dados, preview e ZPL. Para reverter (re-exigir login), reaplicar:
//   import { authenticate } from '../middleware/auth.js';
//   import { requirePermission } from '../middleware/rbac.js';
//   e prefixar cada rota com: authenticate, requirePermission('etiquetas', '<read|print>')
router.get('/files',       listFiles);
router.get('/items',       listItems);
router.get('/preview.pdf', labelPreviewPdf);
router.get('/agent',       downloadAgent);
router.get('/zpl',         downloadZpl);

export default router;
