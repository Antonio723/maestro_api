import express from 'express';
import {
  getAllCuttingRecords,
  getCuttingRecordById,
  createCuttingRecord,
  updateCuttingRecord,
  deleteCuttingRecord,
  getMetadata,
  backfillJiraKeys,
} from '../controllers/cuttingController.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: tela de Apontamento de Corte liberada sem login
// (openAuth). Ver middleware/optionalAuth.js. Reverter -> authenticate +
// requirePermission('cutting_records', ...).

// Rotas estáticas antes de "/:id" para evitar colisão com :id
router.get('/metadata', openAuth, getMetadata);

router.post('/backfill-jira-keys', openAuth, backfillJiraKeys);

router.get('/',        openAuth, getAllCuttingRecords);
router.get('/:id',     openAuth, getCuttingRecordById);
router.post('/',       openAuth, createCuttingRecord);
router.put('/:id',     openAuth, updateCuttingRecord);
router.delete('/:id',  openAuth, deleteCuttingRecord);

export default router;
