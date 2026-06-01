import express from 'express';
import {
  gerarRomaneioCorte,
  listarRomaneiosImpressos,
} from '../controllers/cuttingRomaneioController.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: romaneio de corte (gerar/listar) usado pela tela de
// Corte, liberado sem login (openAuth). Ver middleware/optionalAuth.js.
router.get('/printed', openAuth, listarRomaneiosImpressos);
router.post('/', openAuth, gerarRomaneioCorte);

export default router;
