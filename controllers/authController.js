import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../config/database.js';
import { invalidateCache } from '../services/jiraService.js';
import {
  ALL_PERMISSIONS, ROUTE_PERMISSIONS, PERMISSION_DESCRIPTIONS,
  MODULES, RESOURCE_LABELS, ACTION_LABELS,
} from '../shared/permissions.js';

/**
 * =========================
 * CONFIG CRYPTO (JIRA TOKEN)
 * =========================
 */
const ALGORITHM = 'aes-256-gcm';
const SECRET = process.env.JIRA_TOKEN_SECRET; // precisa ter 32 bytes
const IV_LENGTH = 12;

if (!SECRET || SECRET.length !== 64) {
  throw new Error('JIRA_TOKEN_SECRET must be 64 hex characters (32 bytes)');
}

const encrypt = (text) => {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(SECRET, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

const decrypt = (text) => {
  try {
    if (!text) return null;

    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      Buffer.from(SECRET, 'hex'),
      iv
    );

    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString();
  } catch (err) {
    console.error('Erro ao descriptografar token:', err);
    return null;
  }
};

/**
 * =========================
 * MAP USER (NUNCA EXPOR TOKEN)
 * =========================
 */
const mapUser = (user) => ({
  id: user.id,
  name: user.name,
  username: user.username || null,
  email: user.email,
  cargoId: user.cargo_id ?? null,
  cargoNome: user.cargo_nome ?? null,
  isMaster: user.is_master ?? false,
  idleTimeoutEnabled: user.idle_timeout_enabled ?? false,
  idleTimeoutMinutes: user.idle_timeout_minutes ?? 30,
  mustChangePassword: user.must_change_password ?? false,
  lastLoginAt: user.last_login_at || null,
  jiraTokenExpiresAt: user.jira_token_expires_at || null,
  createdAt: user.created_at,
  updatedAt: user.updated_at,
  deletedAt: user.deleted_at || null,
});

/**
 * Calcula status do token Jira para banner no front:
 *   - missing:  sem token cadastrado
 *   - unknown:  token presente mas sem data de expiração informada
 *   - expired:  expires_at no passado
 *   - expiring: expires_at em até 5 dias
 *   - ok:       expires_at em mais de 5 dias
 *
 * daysRemaining vem nulo nos status missing/unknown.
 */
const JIRA_TOKEN_WARN_DAYS = 5;

const jiraTokenStatus = (user) => {
  if (!user.api_token) return { status: 'missing', daysRemaining: null, expiresAt: null };
  if (!user.jira_token_expires_at) return { status: 'unknown', daysRemaining: null, expiresAt: null };

  const expiresAt = new Date(user.jira_token_expires_at);
  const today = new Date();
  // Comparação em dias inteiros para evitar oscilações por hora.
  const msPerDay = 1000 * 60 * 60 * 24;
  const days = Math.floor((expiresAt.setHours(23, 59, 59, 999) - today.getTime()) / msPerDay);

  let status;
  if (days < 0) status = 'expired';
  else if (days <= JIRA_TOKEN_WARN_DAYS) status = 'expiring';
  else status = 'ok';

  return { status, daysRemaining: days, expiresAt: user.jira_token_expires_at };
};

/**
 * =========================
 * REGISTER
 * =========================
 */
export const register = async (req, res) => {
  try {
    const { name, username, email, password, jiraToken, jiraTokenExpiresAt, cargoId } = req.body;

    if (!name || !username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Preencha todos os campos obrigatórios'
      });
    }

    const usernameClean = String(username).trim();
    if (!/^[a-zA-Z0-9._-]{3,60}$/.test(usernameClean)) {
      return res.status(400).json({
        success: false,
        message: 'Username deve ter 3-60 caracteres (letras, números, ponto, underline ou hífen).'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'E-mail inválido'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Senha deve ter no mínimo 6 caracteres'
      });
    }

    const conflict = await query(
      'SELECT id FROM maestro.users WHERE email = $1 OR lower(username) = lower($2)',
      [email, usernameClean]
    );

    if (conflict.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'E-mail ou username já cadastrado'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const encryptedToken = encrypt(jiraToken);

    const result = await query(
      `INSERT INTO maestro.users
       (name, username, email, password, api_token, jira_token_expires_at, cargo_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, username, email, cargo_id, created_at`,
      [name, usernameClean, email, hashedPassword, encryptedToken, jiraTokenExpiresAt || null, cargoId || null]
    );

    const user = result.rows[0];

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'Usuário criado com sucesso',
      data: {
        user: mapUser(user),
        token
      }
    });

  } catch (error) {
    console.error('Erro register:', error);
    res.status(500).json({ success: false, message: 'Erro ao registrar usuário' });
  }
};

/**
 * =========================
 * LOGIN
 * =========================
 */
export const login = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Aceita o campo `username` (novo) ou `email` (legado, durante transição).
    const loginId = (username ?? email ?? '').trim();
    if (!loginId || !password) {
      return res.status(400).json({ success: false, message: 'Credenciais inválidas' });
    }

    const result = await query(
      `SELECT id, name, username, email, password, cargo_id, is_master,
              idle_timeout_enabled, idle_timeout_minutes, must_change_password,
              locked_until, failed_attempts, last_failed_at, last_login_at
       FROM maestro.users
       WHERE (lower(username) = lower($1) OR lower(email) = lower($1))
         AND deleted_at IS NULL`,
      [loginId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
    }

    const user = result.rows[0];

    // Check lockout
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remaining = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return res.status(429).json({
        success: false,
        code: 'ACCOUNT_LOCKED',
        message: `Conta bloqueada. Tente novamente em ${remaining} minuto(s).`,
        lockedUntil: user.locked_until,
      });
    }

    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      const now = Date.now();
      const withinWindow =
        user.last_failed_at &&
        now - new Date(user.last_failed_at).getTime() < 15 * 60 * 1000;
      const attempts = withinWindow ? user.failed_attempts + 1 : 1;

      let lockedUntil = null;
      if (attempts >= 10) {
        lockedUntil = new Date(now + 60 * 60 * 1000);
      } else if (attempts >= 5) {
        lockedUntil = new Date(now + 15 * 60 * 1000);
      }

      await query(
        `UPDATE maestro.users
         SET failed_attempts = $1, last_failed_at = now(), locked_until = $2
         WHERE id = $3`,
        [attempts, lockedUntil, user.id],
      );

      return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
    }

    // Reset lockout counters and record last login
    await query(
      `UPDATE maestro.users
       SET failed_attempts = 0, last_failed_at = NULL, locked_until = NULL,
           last_login_at = now()
       WHERE id = $1`,
      [user.id],
    );

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      data: {
        user: mapUser(user),
        token
      }
    });

  } catch (error) {
    console.error('Erro login:', error);
    res.status(500).json({ success: false, message: 'Erro no login' });
  }
};

/**
 * =========================
 * GET ME
 * =========================
 */
export const getMe = async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.username, u.email, u.is_master,
              u.idle_timeout_enabled, u.idle_timeout_minutes,
              u.must_change_password, u.api_token, u.jira_token_expires_at,
              u.cargo_id, c.nome AS cargo_nome,
              u.created_at, u.updated_at
       FROM maestro.users u
       LEFT JOIN maestro.cargos c ON c.id = u.cargo_id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [req.user.id],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false });
    }

    const user = result.rows[0];

    let permissions;
    if (user.is_master) {
      permissions = ALL_PERMISSIONS.map((p) => `${p.resource}:${p.action}`);
    } else {
      const permRes = await query(
        `SELECT concat(p.resource, ':', p.action) AS perm
         FROM maestro.permissions p
         JOIN maestro.user_permission_overrides upo ON upo.permission_id = p.id
         WHERE upo.user_id = $1
           AND upo.effect = 'grant'
           AND (upo.expires_at IS NULL OR upo.expires_at > now())`,
        [req.user.id],
      );
      permissions = permRes.rows.map((r) => r.perm);
    }

    res.json({
      success: true,
      data: {
        user: {
          ...mapUser(user),
          isMaster: user.is_master,
          permissions,
          idleTimeout: {
            enabled: user.idle_timeout_enabled,
            minutes:  user.idle_timeout_minutes,
          },
          mustChangePassword: user.must_change_password,
          jiraTokenStatus: jiraTokenStatus(user),
        },
      },
    });

  } catch (error) {
    console.error('getMe error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * LIST USERS
 * =========================
 */
export const listUsers = async (_req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.username, u.email, u.is_master,
              u.created_at, u.updated_at,
              u.idle_timeout_enabled, u.idle_timeout_minutes, u.must_change_password,
              u.last_login_at, u.jira_token_expires_at,
              u.cargo_id, c.nome AS cargo_nome
       FROM maestro.users u
       LEFT JOIN maestro.cargos c ON c.id = u.cargo_id
       WHERE u.deleted_at IS NULL
       ORDER BY u.created_at DESC`,
    );

    res.json({
      success: true,
      data: { users: result.rows.map(mapUser) }
    });

  } catch (error) {
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * CREATE USER (ADMIN)
 * =========================
 */
export const createUser = async (req, res) => {
  try {
    const { name, username, email, password, jiraToken, jiraTokenExpiresAt, cargoId } = req.body;

    if (!name || !username || !email || !password) {
      return res.status(400).json({ success: false, message: 'Campos obrigatórios (name, username, email, password)' });
    }

    const usernameClean = String(username).trim();
    if (!/^[a-zA-Z0-9._-]{3,60}$/.test(usernameClean)) {
      return res.status(400).json({
        success: false,
        message: 'Username deve ter 3-60 caracteres (letras, números, ponto, underline ou hífen).'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'E-mail inválido'
      });
    }

    const conflict = await query(
      'SELECT id FROM maestro.users WHERE email = $1 OR lower(username) = lower($2)',
      [email, usernameClean]
    );

    if (conflict.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'E-mail ou username já cadastrado'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const encryptedToken = encrypt(jiraToken);

    const result = await query(
      `INSERT INTO maestro.users
       (name, username, email, password, api_token, jira_token_expires_at, cargo_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, username, email, cargo_id, jira_token_expires_at, created_at, updated_at`,
      [name, usernameClean, email, hashedPassword, encryptedToken, jiraTokenExpiresAt || null, cargoId || null]
    );

    res.status(201).json({
      success: true,
      data: { user: mapUser(result.rows[0]) }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * UPDATE SELF (senha + token Jira)
 * =========================
 */
export const updateMe = async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword, jiraToken, jiraTokenExpiresAt } = req.body;

    const existing = await query('SELECT * FROM maestro.users WHERE id = $1', [userId]);
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }
    const currentUser = existing.rows[0];

    const setClauses = [];
    const values = [];
    let idx = 1;
    let jiraTokenChanged = false;

    if (newPassword !== undefined && newPassword !== '') {
      if (!currentPassword) {
        return res.status(400).json({ success: false, message: 'Informe a senha atual para alterar a senha.' });
      }
      const isValid = await bcrypt.compare(currentPassword, currentUser.password);
      if (!isValid) {
        return res.status(400).json({ success: false, message: 'Senha atual incorreta.' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'A nova senha deve ter no mínimo 6 caracteres.' });
      }
      setClauses.push(`password = $${idx++}`);
      values.push(await bcrypt.hash(newPassword, 10));
    }

    if (jiraToken !== undefined && jiraToken !== '') {
      setClauses.push(`api_token = $${idx++}`);
      values.push(encrypt(jiraToken));
      jiraTokenChanged = true;
    }

    if (jiraTokenExpiresAt !== undefined) {
      setClauses.push(`jira_token_expires_at = $${idx++}`);
      values.push(jiraTokenExpiresAt || null);
    }

    if (!setClauses.length) {
      return res.status(400).json({ success: false, message: 'Nenhuma alteração enviada.' });
    }

    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userId);

    const result = await query(
      `UPDATE maestro.users SET ${setClauses.join(', ')} WHERE id = $${idx}
       RETURNING id, name, username, email, cargo_id, jira_token_expires_at, created_at, updated_at`,
      values
    );

    if (jiraTokenChanged) invalidateCache(userId);

    res.json({ success: true, message: 'Configurações atualizadas com sucesso.', data: { user: mapUser(result.rows[0]) } });

  } catch (error) {
    console.error('Erro updateMe:', error);
    res.status(500).json({ success: false, message: 'Erro ao atualizar configurações.' });
  }
};

/**
 * =========================
 * PERMISSIONS CATALOG
 * =========================
 */
export const getPermissionsCatalog = (_req, res) => {
  res.json({
    success: true,
    data: {
      ALL_PERMISSIONS,
      ROUTE_PERMISSIONS,
      PERMISSION_DESCRIPTIONS,
      MODULES,
      RESOURCE_LABELS,
      ACTION_LABELS,
    },
  });
};

/**
 * =========================
 * LIST ROLES
 * =========================
 */
export const listRoles = async (_req, res) => {
  try {
    const result = await query(
      `SELECT r.id, r.name, r.description, r.is_system, r.created_at, r.updated_at,
         COALESCE(
           json_agg(
             json_build_object('id', p.id, 'resource', p.resource, 'action', p.action)
           ) FILTER (WHERE p.id IS NOT NULL),
           '[]'
         ) AS permissions
       FROM maestro.roles r
       LEFT JOIN maestro.role_permissions rp ON rp.role_id = r.id
       LEFT JOIN maestro.permissions p ON p.id = rp.permission_id
       GROUP BY r.id
       ORDER BY r.name`,
    );
    res.json({ success: true, data: { roles: result.rows } });
  } catch (error) {
    console.error('listRoles error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * CREATE ROLE
 * =========================
 */
export const createRole = async (req, res) => {
  try {
    const { name, description, permissionIds } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'name obrigatório' });
    }

    const roleRes = await query(
      `INSERT INTO maestro.roles (name, description, is_system)
       VALUES ($1, $2, false)
       RETURNING id, name, description, is_system`,
      [name.trim(), description?.trim() || null],
    );
    const role = roleRes.rows[0];

    if (Array.isArray(permissionIds) && permissionIds.length) {
      for (const permId of permissionIds) {
        await query(
          `INSERT INTO maestro.role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role.id, Number(permId)],
        );
      }
    }

    await query(
      `INSERT INTO maestro.access_audit (user_id, user_email, event_type, details)
       VALUES ($1, $2, 'permission_changed', $3::jsonb)`,
      [req.user.id, req.user.email, JSON.stringify({ action: 'role_created', roleId: role.id, roleName: name })],
    );

    res.status(201).json({ success: true, data: { role } });
  } catch (error) {
    console.error('createRole error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * UPDATE ROLE
 * =========================
 */
export const updateRole = async (req, res) => {
  try {
    const roleId = Number(req.params.id);
    const { description, permissionIds } = req.body;

    if (description !== undefined) {
      await query(
        `UPDATE maestro.roles SET description = $1, updated_at = now() WHERE id = $2`,
        [description, roleId],
      );
    }

    if (Array.isArray(permissionIds)) {
      await query('DELETE FROM maestro.role_permissions WHERE role_id = $1', [roleId]);
      for (const permId of permissionIds) {
        await query(
          `INSERT INTO maestro.role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [roleId, Number(permId)],
        );
      }
    }

    await query(
      `INSERT INTO maestro.access_audit (user_id, user_email, event_type, details)
       VALUES ($1, $2, 'permission_changed', $3::jsonb)`,
      [req.user.id, req.user.email, JSON.stringify({ action: 'role_updated', roleId, permissionIds })],
    );

    const roleRes = await query(
      `SELECT r.id, r.name, r.description, r.is_system,
         COALESCE(
           json_agg(json_build_object('id', p.id, 'resource', p.resource, 'action', p.action))
           FILTER (WHERE p.id IS NOT NULL), '[]'
         ) AS permissions
       FROM maestro.roles r
       LEFT JOIN maestro.role_permissions rp ON rp.role_id = r.id
       LEFT JOIN maestro.permissions p ON p.id = rp.permission_id
       WHERE r.id = $1
       GROUP BY r.id`,
      [roleId],
    );

    res.json({ success: true, data: { role: roleRes.rows[0] } });
  } catch (error) {
    console.error('updateRole error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * GET USER ROLES
 * =========================
 */
export const getUserRoles = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const result = await query(
      `SELECT r.id, r.name, r.description, r.is_system,
              ur.granted_by, ur.expires_at, ur.created_at
       FROM maestro.roles r
       JOIN maestro.user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [userId],
    );
    res.json({ success: true, data: { roles: result.rows } });
  } catch (error) {
    console.error('getUserRoles error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * UPDATE USER ROLES
 * =========================
 */
export const updateUserRoles = async (req, res) => {
  try {
    const userId    = Number(req.params.id);
    const actorId   = req.user.id;
    const actorEmail = req.user.email;
    const { roleIds } = req.body;

    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ success: false, message: 'roleIds deve ser um array' });
    }

    const currentRes = await query(
      'SELECT role_id FROM maestro.user_roles WHERE user_id = $1',
      [userId],
    );
    const currentSet = new Set(currentRes.rows.map((r) => r.role_id));
    const newSet     = new Set(roleIds.map(Number));

    const toRemove = [...currentSet].filter((id) => !newSet.has(id));
    const toAdd    = [...newSet].filter((id) => !currentSet.has(id));

    for (const roleId of toRemove) {
      await query(
        'DELETE FROM maestro.user_roles WHERE user_id = $1 AND role_id = $2',
        [userId, roleId],
      );
      await query(
        `INSERT INTO maestro.access_audit (user_id, user_email, event_type, target_user_id, details)
         VALUES ($1, $2, 'role_revoked', $3, $4::jsonb)`,
        [actorId, actorEmail, userId, JSON.stringify({ roleId })],
      );
    }

    for (const roleId of toAdd) {
      await query(
        `INSERT INTO maestro.user_roles (user_id, role_id, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, roleId, actorId],
      );
      await query(
        `INSERT INTO maestro.access_audit (user_id, user_email, event_type, target_user_id, details)
         VALUES ($1, $2, 'role_granted', $3, $4::jsonb)`,
        [actorId, actorEmail, userId, JSON.stringify({ roleId })],
      );
    }

    const rolesRes = await query(
      `SELECT r.id, r.name, r.description FROM maestro.roles r
       JOIN maestro.user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1
       ORDER BY r.name`,
      [userId],
    );

    res.json({ success: true, data: { roles: rolesRes.rows } });
  } catch (error) {
    console.error('updateUserRoles error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * LIST ACCESS AUDIT
 * =========================
 */
export const listAccessAudit = async (req, res) => {
  try {
    const { event_type, user_id, limit = '100', offset = '0' } = req.query;
    const params = [];
    const conditions = [];
    let p = 1;

    if (event_type) { conditions.push(`aa.event_type = $${p++}`); params.push(event_type); }
    if (user_id)    { conditions.push(`aa.user_id = $${p++}`);    params.push(Number(user_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(Number(limit) || 100, 500));
    params.push(Math.max(Number(offset) || 0, 0));

    const result = await query(
      `SELECT aa.*, u.name AS actor_name, tu.name AS target_name
       FROM maestro.access_audit aa
       LEFT JOIN maestro.users u  ON u.id  = aa.user_id
       LEFT JOIN maestro.users tu ON tu.id = aa.target_user_id
       ${where}
       ORDER BY aa.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params,
    );

    res.json({ success: true, data: { events: result.rows } });
  } catch (error) {
    console.error('listAccessAudit error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * STEP-UP AUTH (§14.4)
 * Validate current password → return a short-lived step-up token (5 min).
 * =========================
 */
export const stepUp = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'Senha obrigatória' });

    const result = await query(
      'SELECT password FROM maestro.users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id],
    );
    if (!result.rows.length) return res.status(404).json({ success: false });

    const isValid = await bcrypt.compare(password, result.rows[0].password);
    if (!isValid) return res.status(401).json({ success: false, message: 'Senha incorreta' });

    const stepUpToken = jwt.sign(
      { id: req.user.id, stepUp: true },
      process.env.JWT_SECRET,
      { expiresIn: '5m' },
    );

    res.json({ success: true, data: { stepUpToken } });
  } catch (error) {
    console.error('stepUp error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * FORCE CHANGE PASSWORD (§14.3)
 * Called by user when must_change_password = true.
 * Does NOT require current password — admin already reset it.
 * =========================
 */
export const changePassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Senha deve ter no mínimo 6 caracteres' });
    }

    await query(
      `UPDATE maestro.users
       SET password = $1, must_change_password = false, updated_at = now()
       WHERE id = $2`,
      [await bcrypt.hash(newPassword, 10), req.user.id],
    );

    res.json({ success: true, message: 'Senha alterada com sucesso.' });
  } catch (error) {
    console.error('changePassword error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * RESET USER PASSWORD (ADMIN, §14.3)
 * Admin sets a temp password and marks must_change_password = true.
 * Requires step-up token.
 * =========================
 */
export const resetUserPassword = async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Senha deve ter no mínimo 6 caracteres' });
    }

    const result = await query(
      `UPDATE maestro.users
       SET password = $1, must_change_password = true, updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING id, name, email`,
      [await bcrypt.hash(newPassword, 10), targetId],
    );

    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Usuário não encontrado' });

    await query(
      `INSERT INTO maestro.access_audit (user_id, user_email, event_type, target_user_id, details)
       VALUES ($1, $2, 'password_reset', $3, $4::jsonb)`,
      [req.user.id, req.user.email, targetId, JSON.stringify({ trigger: 'admin_reset' })],
    );

    res.json({ success: true, message: 'Senha redefinida. Usuário deverá criar nova senha no próximo acesso.' });
  } catch (error) {
    console.error('resetUserPassword error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * UPDATE USER TIMEOUT (§14.1)
 * =========================
 */
export const updateUserTimeout = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { enabled, minutes } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'enabled deve ser boolean' });
    }

    const mins = enabled ? Math.max(1, Math.min(480, Number(minutes) || 30)) : null;

    await query(
      `UPDATE maestro.users
       SET idle_timeout_enabled = $1, idle_timeout_minutes = $2, updated_at = now()
       WHERE id = $3 AND deleted_at IS NULL`,
      [enabled, mins, userId],
    );

    res.json({ success: true });
  } catch (error) {
    console.error('updateUserTimeout error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * SOFT DELETE USER (§14.7)
 * Requires step-up token. Cannot delete yourself.
 * =========================
 */
export const deleteUser = async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (userId === req.user.id) {
      return res.status(400).json({ success: false, message: 'Não é possível excluir a própria conta.' });
    }

    const result = await query(
      `UPDATE maestro.users SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [userId],
    );

    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

    await query(
      `INSERT INTO maestro.access_audit (user_id, user_email, event_type, target_user_id, details)
       VALUES ($1, $2, 'user_deleted', $3, $4::jsonb)`,
      [req.user.id, req.user.email, userId, JSON.stringify({ trigger: 'admin_delete' })],
    );

    res.json({ success: true });
  } catch (error) {
    console.error('deleteUser error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * RESTORE USER (§14.7)
 * =========================
 */
export const restoreUser = async (req, res) => {
  try {
    const userId = Number(req.params.id);

    const result = await query(
      `UPDATE maestro.users SET deleted_at = NULL
       WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING id`,
      [userId],
    );

    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

    await query(
      `INSERT INTO maestro.access_audit (user_id, user_email, event_type, target_user_id, details)
       VALUES ($1, $2, 'user_restored', $3, $4::jsonb)`,
      [req.user.id, req.user.email, userId, JSON.stringify({ trigger: 'admin_restore' })],
    );

    res.json({ success: true });
  } catch (error) {
    console.error('restoreUser error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * LIST DELETED USERS (§14.7)
 * =========================
 */
export const listDeletedUsers = async (_req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.username, u.email, u.is_master,
              u.created_at, u.updated_at, u.deleted_at,
              u.idle_timeout_enabled, u.idle_timeout_minutes, u.must_change_password,
              u.last_login_at, u.jira_token_expires_at,
              u.cargo_id, c.nome AS cargo_nome
       FROM maestro.users u
       LEFT JOIN maestro.cargos c ON c.id = u.cargo_id
       WHERE u.deleted_at IS NOT NULL
       ORDER BY u.deleted_at DESC`,
    );
    res.json({ success: true, data: { users: result.rows.map(mapUser) } });
  } catch (error) {
    console.error('listDeletedUsers error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * GET USER PERMISSION OVERRIDES (§14.6)
 * =========================
 */
export const getUserOverrides = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const result = await query(
      `SELECT upo.id, p.resource, p.action, upo.effect, upo.expires_at, upo.created_at
       FROM maestro.user_permission_overrides upo
       JOIN maestro.permissions p ON p.id = upo.permission_id
       WHERE upo.user_id = $1
       ORDER BY p.resource, p.action`,
      [userId],
    );
    res.json({ success: true, data: { overrides: result.rows } });
  } catch (error) {
    console.error('getUserOverrides error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * SET USER PERMISSION OVERRIDE (§14.6)
 * Upserts a grant or deny override for a specific permission.
 * =========================
 */
export const setUserOverride = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { resource, action, effect, expiresAt } = req.body;

    if (!resource || !action || !['grant', 'deny'].includes(effect)) {
      return res.status(400).json({
        success: false,
        message: 'resource, action e effect (grant|deny) são obrigatórios',
      });
    }

    const permRes = await query(
      'SELECT id FROM maestro.permissions WHERE resource = $1 AND action = $2',
      [resource, action],
    );
    if (!permRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Permissão não encontrada' });
    }

    const permId = permRes.rows[0].id;

    // Delete existing override for this (user, permission) pair, then insert fresh
    await query(
      'DELETE FROM maestro.user_permission_overrides WHERE user_id = $1 AND permission_id = $2',
      [userId, permId],
    );
    const insertRes = await query(
      `INSERT INTO maestro.user_permission_overrides
         (user_id, permission_id, effect, expires_at, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, permId, effect, expiresAt || null, req.user.id],
    );

    await query(
      `INSERT INTO maestro.access_audit (user_id, user_email, event_type, target_user_id, details)
       VALUES ($1, $2, 'permission_changed', $3, $4::jsonb)`,
      [req.user.id, req.user.email, userId,
       JSON.stringify({ action: 'override_set', resource, perm_action: action, effect })],
    );

    res.json({ success: true, data: { id: insertRes.rows[0].id } });
  } catch (error) {
    console.error('setUserOverride error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * DELETE USER PERMISSION OVERRIDE (§14.6)
 * =========================
 */
export const deleteUserOverride = async (req, res) => {
  try {
    const userId     = Number(req.params.id);
    const overrideId = Number(req.params.overrideId);

    const result = await query(
      'DELETE FROM maestro.user_permission_overrides WHERE id = $1 AND user_id = $2 RETURNING id',
      [overrideId, userId],
    );

    if (!result.rows.length) return res.status(404).json({ success: false });

    res.json({ success: true });
  } catch (error) {
    console.error('deleteUserOverride error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * GET EFFECTIVE PERMISSIONS (§15.1)
 * Returns permissions directly granted to a user (no role layer).
 * Master users implicitly receive all permissions.
 * =========================
 */
export const getEffectivePermissions = async (req, res) => {
  try {
    const userId = Number(req.params.id);

    const userRes = await query(
      'SELECT is_master FROM maestro.users WHERE id = $1 AND deleted_at IS NULL',
      [userId],
    );
    if (!userRes.rows.length) return res.status(404).json({ success: false });

    if (userRes.rows[0].is_master) {
      const all = ALL_PERMISSIONS.map((p) => ({
        perm: `${p.resource}:${p.action}`,
        source: 'master',
      }));
      return res.json({ success: true, data: { isMaster: true, permissions: all } });
    }

    const grantRes = await query(
      `SELECT p.resource, p.action
       FROM maestro.permissions p
       JOIN maestro.user_permission_overrides upo ON upo.permission_id = p.id
       WHERE upo.user_id = $1 AND upo.effect = 'grant'
         AND (upo.expires_at IS NULL OR upo.expires_at > now())
       ORDER BY p.resource, p.action`,
      [userId],
    );

    const permissions = grantRes.rows.map((r) => ({
      perm: `${r.resource}:${r.action}`,
      source: 'direct',
    }));

    res.json({
      success: true,
      data: { isMaster: false, permissions },
    });
  } catch (error) {
    console.error('getEffectivePermissions error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * BULK ASSIGN ROLE (§15.3)
 * Assigns a single role to multiple users at once.
 * =========================
 */
export const bulkAssignRole = async (req, res) => {
  try {
    const { userIds, roleId } = req.body;

    if (!Array.isArray(userIds) || !userIds.length || !roleId) {
      return res.status(400).json({ success: false, message: 'userIds e roleId são obrigatórios' });
    }

    const actorId    = req.user.id;
    const actorEmail = req.user.email;

    for (const uid of userIds.map(Number)) {
      await query(
        `INSERT INTO maestro.user_roles (user_id, role_id, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [uid, Number(roleId), actorId],
      );
      await query(
        `INSERT INTO maestro.access_audit
           (user_id, user_email, event_type, target_user_id, details)
         VALUES ($1, $2, 'role_granted', $3, $4::jsonb)`,
        [actorId, actorEmail, uid, JSON.stringify({ roleId, trigger: 'bulk_assign' })],
      );
    }

    res.json({ success: true, message: `Role atribuída a ${userIds.length} usuário(s).` });
  } catch (error) {
    console.error('bulkAssignRole error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * =========================
 * UPDATE USER (ADMIN)
 * =========================
 */
export const updateUser = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { name, username, email, password, jiraToken, jiraTokenExpiresAt, cargoId } = req.body;

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'ID inválido'
      });
    }

    const existing = await query(
      'SELECT * FROM maestro.users WHERE id = $1',
      [userId]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Usuário não encontrado'
      });
    }

    const currentUser = existing.rows[0];

    const updatedName     = name?.trim()  || currentUser.name;
    const updatedEmail    = email?.trim() || currentUser.email;

    let updatedUsername = currentUser.username;
    if (username !== undefined && username !== null && String(username).trim() !== '') {
      const usernameClean = String(username).trim();
      if (!/^[a-zA-Z0-9._-]{3,60}$/.test(usernameClean)) {
        return res.status(400).json({
          success: false,
          message: 'Username deve ter 3-60 caracteres (letras, números, ponto, underline ou hífen).'
        });
      }
      updatedUsername = usernameClean;
    }

    const conflict = await query(
      `SELECT id FROM maestro.users
       WHERE id <> $1 AND (email = $2 OR lower(username) = lower($3))`,
      [userId, updatedEmail, updatedUsername]
    );

    if (conflict.rows.length) {
      return res.status(400).json({
        success: false,
        message: 'E-mail ou username já cadastrado'
      });
    }

    let updatedPassword = currentUser.password;
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'Senha deve ter no mínimo 6 caracteres'
        });
      }
      updatedPassword = await bcrypt.hash(password, 10);
    }

    // jira token: undefined ou '' = mantém. Caso contrário, recriptografa.
    let updatedJiraToken = currentUser.api_token;
    let jiraTokenChanged = false;
    if (jiraToken !== undefined && jiraToken !== '') {
      updatedJiraToken = encrypt(jiraToken);
      jiraTokenChanged = true;
    }

    // Data de expiração do token: aceita null/'' para limpar.
    let updatedExpires = currentUser.jira_token_expires_at;
    if (jiraTokenExpiresAt !== undefined) {
      updatedExpires = jiraTokenExpiresAt || null;
    }

    let updatedCargoId = currentUser.cargo_id;
    if (cargoId !== undefined) {
      updatedCargoId = cargoId === null || cargoId === '' ? null : Number(cargoId);
    }

    const result = await query(
      `UPDATE maestro.users
       SET name = $1,
           username = $2,
           email = $3,
           password = $4,
           api_token = $5,
           jira_token_expires_at = $6,
           cargo_id = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8
       RETURNING id, name, username, email, cargo_id, jira_token_expires_at, created_at, updated_at`,
      [updatedName, updatedUsername, updatedEmail, updatedPassword, updatedJiraToken, updatedExpires, updatedCargoId, userId]
    );

    if (jiraTokenChanged) {
      invalidateCache(userId);
    }

    res.json({
      success: true,
      message: 'Usuário atualizado com sucesso',
      data: {
        user: mapUser(result.rows[0])
      }
    });

  } catch (error) {
    console.error('Erro updateUser:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao atualizar usuário'
    });
  }
};