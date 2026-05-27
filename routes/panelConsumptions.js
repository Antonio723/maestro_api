import express from 'express';
import {
  listar,
  criar,
  replaceByRecord,
  cancelar,
} from '../controllers/panelConsumptionsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',    authenticate, requirePermission('panel_consumptions', 'read'),   listar);
router.post('/',   authenticate, requirePermission('panel_consumptions', 'manage'), criar);
router.put('/by-record/:cuttingRecordId',
                  authenticate, requirePermission('panel_consumptions', 'manage'), replaceByRecord);
router.delete('/:id', authenticate, requirePermission('panel_consumptions', 'manage'), cancelar);

export default router;
