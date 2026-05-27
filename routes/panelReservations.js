import express from 'express';
import { cancelarReserva } from '../controllers/panelReservationsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.delete('/:id', authenticate, requirePermission('panel_reservations', 'delete'), cancelarReserva);

export default router;
