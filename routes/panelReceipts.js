import express from 'express';
import {
  listar,
  obter,
  criar,
  atualizar,
  excluir,
  validar,
  lookup,
} from '../controllers/panelReceiptsController.js';
import {
  listarReservas,
  criarReserva,
  cancelarReserva,
} from '../controllers/panelReservationsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

// /lookup precisa vir antes de /:id para não cair no matcher de parâmetro.
router.get('/lookup',          authenticate, requirePermission('panel_receipts', 'read'),     lookup);

router.get('/',                authenticate, requirePermission('panel_receipts', 'read'),     listar);
router.get('/:id',             authenticate, requirePermission('panel_receipts', 'read'),     obter);
router.post('/',               authenticate, requirePermission('panel_receipts', 'create'),   criar);
router.put('/:id',             authenticate, requirePermission('panel_receipts', 'update'),   atualizar);
router.delete('/:id',          authenticate, requirePermission('panel_receipts', 'delete'),   excluir);
router.patch('/:id/validate',  authenticate, requirePermission('panel_receipts', 'validate'), validar);

// Reservas aninhadas ao recebimento (Etapa 4)
router.get('/:id/reservations',  authenticate, requirePermission('panel_reservations', 'read'),   listarReservas);
router.post('/:id/reservations', authenticate, requirePermission('panel_reservations', 'create'), criarReserva);

export default router;
