import express from 'express';
import {
  gerarRomaneioCorte,
  listarRomaneiosImpressos,
} from '../controllers/cuttingRomaneioController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Romaneio de corte é visível/emitido apenas por usuários logados — exige
// autenticação. A tela de Corte em si segue aberta (openAuth), mas estes
// endpoints não.
router.get('/printed', authenticate, listarRomaneiosImpressos);
router.post('/', authenticate, gerarRomaneioCorte);

export default router;
