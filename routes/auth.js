import express from 'express';
import {
  register, login, getMe, updateMe,
  listUsers, createUser, updateUser,
  getPermissionsCatalog,
  listRoles, createRole, updateRole,
  getUserRoles, updateUserRoles,
  listAccessAudit,
  // Fase 5
  stepUp, changePassword, resetUserPassword,
  updateUserTimeout,
  deleteUser, restoreUser, listDeletedUsers,
  getUserOverrides, setUserOverride, deleteUserOverride,
  // Fase 6
  getEffectivePermissions, bulkAssignRole,
} from '../controllers/authController.js';
import {
  listCargos, createCargo, updateCargo, deleteCargo,
} from '../controllers/cargosController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { requireStepUp } from '../middleware/stepUp.js';

const router = express.Router();

// Public
router.post('/register', register);
router.post('/login',    login);

// Own user
router.get('/me',  authenticate, getMe);
router.put('/me',  authenticate, updateMe);

// Step-up re-auth (§14.4) — own user, no extra permission needed
router.post('/step-up',         authenticate, stepUp);
router.post('/change-password', authenticate, changePassword);

// Permissions catalog — any authenticated user
router.get('/permissions-catalog', authenticate, getPermissionsCatalog);

// User management — list deleted BEFORE :id routes to avoid shadowing
router.get('/users/deleted',      authenticate, requirePermission('users', 'read'),         listDeletedUsers);
router.post('/users/:id/restore', authenticate, requirePermission('users', 'update'),       restoreUser);
router.delete('/users/:id',       authenticate, requirePermission('users', 'delete'), requireStepUp, deleteUser);

router.get('/users',              authenticate, requirePermission('users', 'read'),         listUsers);
router.post('/users',             authenticate, requirePermission('users', 'create'),       createUser);
router.get('/users/:id/roles',    authenticate, requirePermission('user_access', 'manage'), getUserRoles);
router.put('/users/:id/roles',    authenticate, requirePermission('user_access', 'manage'), updateUserRoles);
router.put('/users/:id/timeout',  authenticate, requirePermission('user_access', 'manage'), updateUserTimeout);

// Admin password reset — requires step-up (§14.3)
router.post('/users/:id/reset-password', authenticate, requirePermission('users', 'update'), requireStepUp, resetUserPassword);

// Permission overrides (§14.6)
router.get('/users/:id/overrides',               authenticate, requirePermission('user_access', 'manage'), getUserOverrides);
router.post('/users/:id/overrides',              authenticate, requirePermission('user_access', 'manage'), setUserOverride);
router.delete('/users/:id/overrides/:overrideId', authenticate, requirePermission('user_access', 'manage'), deleteUserOverride);

// Effective permissions (§15.1)
router.get('/users/:id/effective-permissions', authenticate, requirePermission('user_access', 'manage'), getEffectivePermissions);

// Bulk assign role (§15.3)
router.post('/users/bulk-assign-role', authenticate, requirePermission('user_access', 'manage'), bulkAssignRole);

router.put('/users/:id', authenticate, requirePermission('users', 'update'), updateUser);

// Cargos — catálogo gerenciado por admin (mesma permissão do gerenciamento de usuários).
// Listagem permitida a qualquer autenticado para popular o dropdown no form de usuário.
router.get('/cargos',         authenticate,                                              listCargos);
router.post('/cargos',        authenticate, requirePermission('user_access', 'manage'), createCargo);
router.put('/cargos/:id',     authenticate, requirePermission('user_access', 'manage'), updateCargo);
router.delete('/cargos/:id',  authenticate, requirePermission('user_access', 'manage'), deleteCargo);

// Role management
router.get('/roles',      authenticate, requirePermission('roles', 'read'),   listRoles);
router.post('/roles',     authenticate, requirePermission('roles', 'create'), createRole);
router.put('/roles/:id',  authenticate, requirePermission('roles', 'update'), updateRole);

// Access audit
router.get('/access-audit', authenticate, requirePermission('access_audit', 'read'), listAccessAudit);

export default router;
