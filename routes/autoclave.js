import express from 'express';
import {
  createCycle,
  getAll,
  listDetailedCycles,
  findIncompleteCycles,
  findByDateRange,
  duplicateCycle,
  updateStatus,
  uploadReport,
  completeCycleWithImage,
  getReport,
} from '../controllers/autoclaveCycleController.js';
import {
  createPackage,
  addPlatesToPackage,
  removePlateFromPackage,
  updatePackageStatus,
} from '../controllers/autoclavePackageController.js';
import { openAuth } from '../middleware/optionalAuth.js';
import { upload } from '../middleware/upload.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: tela de Autoclave liberada sem login (openAuth).
// Ver middleware/optionalAuth.js. Reverter -> authenticate + requirePermission.

// ── /cycle  ──────────────────────────────────────────────────────────────────
// Rotas estáticas antes de "/:id/*" para evitar colisão com :id
router.get('/cycle/summary',    openAuth, listDetailedCycles);
router.get('/cycle/incomplete', openAuth, findIncompleteCycles);
router.get('/cycle/by-cycle',   openAuth, findByDateRange);
router.get('/cycle',            openAuth, getAll);

router.post('/cycle',                       openAuth, createCycle);
router.post('/cycle/:id/duplicate',         openAuth, duplicateCycle);
router.patch('/cycle/:id/status',           openAuth, updateStatus);
router.post('/cycle/:id/upload',            openAuth, upload.single('file'), uploadReport);
router.post('/cycle/complete/:id/upload',   openAuth, upload.single('file'), completeCycleWithImage);
router.get('/cycle/:id/report',             openAuth, getReport);

// ── /package ─────────────────────────────────────────────────────────────────
router.post('/package/cycle',                openAuth, createPackage);
router.post('/package/:packid/addPlates',    openAuth, addPlatesToPackage);
router.post('/package/removePlate',          openAuth, removePlateFromPackage);
router.post('/package/:packid/updateStatus', openAuth, updatePackageStatus);

export default router;
