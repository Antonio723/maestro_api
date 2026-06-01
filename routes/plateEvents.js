import express from 'express';
import { findByPlate, metadata } from '../controllers/plateEventController.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: eventos de placa consultados pelas telas de chão de
// fábrica, liberados sem login (openAuth). Ver middleware/optionalAuth.js.
router.get('/metadata', openAuth, metadata);
router.get('/plate/:plateId', openAuth, findByPlate);

export default router;
