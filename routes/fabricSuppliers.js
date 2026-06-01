import express from 'express';
import {
  listarFornecedores,
  criarFornecedor,
  atualizarFornecedor,
  excluirFornecedor,
} from '../controllers/fabricSuppliersController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: Enfesto/Criar OT listam fornecedores de material
// balístico sem login (openAuth em GET /). O cadastro (POST/PATCH/DELETE) — tela
// protegida do Maestro — segue com authenticate. Ver middleware/optionalAuth.js.
router.get('/',       openAuth,                                                       listarFornecedores);
router.post('/',      authenticate, requirePermission('fabric_suppliers', 'create'), criarFornecedor);
router.patch('/:id',  authenticate, requirePermission('fabric_suppliers', 'update'), atualizarFornecedor);
router.delete('/:id', authenticate, requirePermission('fabric_suppliers', 'delete'), excluirFornecedor);

export default router;
