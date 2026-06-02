import express from 'express';
import {
  listGrouped,
  getById,
  create,
  update,
  remove,
  jiraLookup,
  materialOptions,
  lotesImpressos,
} from '../controllers/tensylonEnfestoController.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: telas de produção do Carbon operam sem login
// (openAuth), igual ao enfesto da aramida e ao apontamento de corte.
// Rotas estáticas antes de "/:id" para evitar colisão.
router.get('/jira-lookup', openAuth, jiraLookup);
router.get('/material-options', openAuth, materialOptions);
router.get('/lotes-impressos', openAuth, lotesImpressos);

router.get('/', openAuth, listGrouped);
router.get('/:id', openAuth, getById);
router.post('/', openAuth, create);
router.put('/:id', openAuth, update);
router.delete('/:id', openAuth, remove);

export default router;
