import express from 'express';
import {
  listWorkorders,
  platesByEnfesto,
  listGrouped,
  createWorkorder,
  updateWorkorder,
  deleteWorkorder,
  exportWorkordersExcel,
} from '../controllers/workorderController.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: rotas do Enfesto/Criar OT/PCP Estoque liberadas sem
// login (openAuth). Ver middleware/optionalAuth.js. Para reverter, voltar a
// usar authenticate + requirePermission('workorders', ...).
router.get('/', openAuth, listWorkorders);
router.get('/plates-by-enfesto', openAuth, platesByEnfesto);
router.get('/enfesto/list', openAuth, listGrouped);
router.get('/export/excel', openAuth, exportWorkordersExcel);
router.post('/', openAuth, createWorkorder);
router.put('/:id', openAuth, updateWorkorder);
router.delete('/', openAuth, deleteWorkorder);

export default router;
