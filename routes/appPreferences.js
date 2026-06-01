import express from 'express';
import {
  obterPreferencias,
  atualizarPreferencias,
  listarAssinantesCertificado,
} from '../controllers/appPreferencesController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// Leitura liberada para qualquer usuário autenticado — flags afetam o
// comportamento das telas e são consultadas pelo frontend sem permissão extra.
// ⚠️ HOTFIX ACESSO ABERTO: a tela de Corte lê as preferências sem login, então
// GET / usa openAuth. A escrita (PATCH) e os assinantes seguem protegidos.
router.get('/quality-certificate-signers', authenticate, requirePermission('app_preferences', 'update'), listarAssinantesCertificado);
router.get('/',   openAuth, obterPreferencias);
router.patch('/', authenticate, requirePermission('app_preferences', 'update'), atualizarPreferencias);

export default router;
