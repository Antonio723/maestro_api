import express from 'express';
import {
  obterPreferencias,
  atualizarPreferencias,
} from '../controllers/appPreferencesController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

// Leitura liberada para qualquer usuário autenticado — flags afetam o
// comportamento das telas e são consultadas pelo frontend sem permissão extra.
router.get('/',   authenticate, obterPreferencias);
router.patch('/', authenticate, requirePermission('app_preferences', 'update'), atualizarPreferencias);

export default router;
