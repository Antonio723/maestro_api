import express from 'express';
import {
  findAllById,
  findByInStock,
  findAvailable,
  findById,
  updateStatus,
} from '../controllers/plateController.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: placas usadas pelas telas de Corte/Autoclave/Criar
// OT/PCP Estoque, liberadas sem login (openAuth). Ver middleware/optionalAuth.js.

// Rotas específicas antes do `:id` para evitar colisão com Express
router.get('/getEstoque', openAuth, findByInStock);
router.get('/available',  openAuth, findAvailable);
router.post('/update-status', openAuth, updateStatus);
router.post('/', openAuth, findAllById);
router.get('/:id', openAuth, findById);

export default router;
