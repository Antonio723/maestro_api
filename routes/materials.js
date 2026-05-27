import express from 'express';
import {
  listarMateriais,
  criarMaterial,
  atualizarMaterial,
  excluirMaterial,
  listarTiposMedida,
  criarTipoMedida,
} from '../controllers/materialsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',       authenticate, requirePermission('materials', 'read'),   listarMateriais);
router.get('/measure-types',  authenticate, requirePermission('materials', 'read'),   listarTiposMedida);
router.post('/measure-types', authenticate, requirePermission('materials', 'create'), criarTipoMedida);
router.post('/',      authenticate, requirePermission('materials', 'create'), criarMaterial);
router.patch('/:id',  authenticate, requirePermission('materials', 'update'), atualizarMaterial);
router.delete('/:id', authenticate, requirePermission('materials', 'delete'), excluirMaterial);

export default router;
