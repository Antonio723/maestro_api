import express from 'express';
import {
  listCertificates,
  getCertificate,
  createCertificate,
  updateCertificate,
  deleteCertificate,
  generateCertificatePdf,
  fromInvoice,
  gerarCertificadosCorte,
  listarCertsPorCorte,
} from '../controllers/qualityController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { openAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

// ⚠️ HOTFIX ACESSO ABERTO: a tela de Corte emite certificado de qualidade em
// lote sem login, então SOMENTE /by-cutting (listar) e /from-cutting (gerar)
// usam openAuth. Os demais endpoints de qualidade (tela protegida do Maestro)
// seguem com authenticate + requirePermission. Ver middleware/optionalAuth.js.
router.get('/',           authenticate, requirePermission('certificates', 'read'),   listCertificates);
router.get('/by-cutting', openAuth,                                                  listarCertsPorCorte);
router.get('/:id/pdf',    authenticate, requirePermission('certificates', 'read'),   generateCertificatePdf);
router.get('/:id',        authenticate, requirePermission('certificates', 'read'),   getCertificate);
router.post('/from-invoice', authenticate, requirePermission('certificates', 'create'), fromInvoice);
router.post('/from-cutting', openAuth,                                                   gerarCertificadosCorte);
router.post('/',          authenticate, requirePermission('certificates', 'create'), createCertificate);
router.put('/:id',        authenticate, requirePermission('certificates', 'update'), updateCertificate);
router.delete('/:id',     authenticate, requirePermission('certificates', 'delete'), deleteCertificate);

export default router;
