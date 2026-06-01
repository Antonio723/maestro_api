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
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: a tela de Corte consulta recebimentos via /lookup
// sem login (openAuth). O restante do módulo de Recebimento (tela protegida do
// Maestro) segue com authenticate + requirePermission. Ver optionalAuth.js.
// /lookup precisa vir antes de /:id para não cair no matcher de parâmetro.
router.get('/lookup',          openAuth,                                                  lookup);

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
