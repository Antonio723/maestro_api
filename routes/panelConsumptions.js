import express from 'express';
import {
  listar,
  criar,
  replaceByRecord,
  cancelar,
} from '../controllers/panelConsumptionsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: a tela de Corte lista e regrava as alocações de
// painel do registro de corte sem login (openAuth em GET / e PUT /by-record).
// criar/cancelar avulsos seguem protegidos. Ver middleware/optionalAuth.js.
router.get('/',    openAuth,                                                          listar);
router.post('/',   authenticate, requirePermission('panel_consumptions', 'manage'),  criar);
router.put('/by-record/:cuttingRecordId',
                  openAuth,                                                           replaceByRecord);
router.delete('/:id', authenticate, requirePermission('panel_consumptions', 'manage'), cancelar);

export default router;
