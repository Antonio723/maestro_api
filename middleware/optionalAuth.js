import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';

// ============================================================================
// ⚠️  HOTFIX — ACESSO ABERTO ÀS TELAS DO ORQUESTRA (chão de fábrica)
// ----------------------------------------------------------------------------
// As telas do Orquestra (Início, Enfesto, Autoclave, Corte, Criar OT, PCP
// Estoque) foram liberadas para operar SEM login. Este middleware é aplicado
// SOMENTE nas rotas que servem essas telas — as rotas do Maestro continuam
// usando `authenticate` (estrito).
//
// openAuth NUNCA rejeita a requisição:
//   • se vier um token válido, usa-o (preserva a identidade real do usuário);
//   • caso contrário, injeta uma identidade-padrão (um usuário MASTER do banco)
//     para que `req.user.id` continue válido. Isso é necessário porque vários
//     controllers usam req.user.id (Jira resolve credenciais por usuário,
//     auditoria, FKs em created_by) — sem isso, trocaríamos 401 por crash 500.
//
// Opcional: KIOSK_USER_EMAIL aponta para um usuário específico (de preferência
// master e com token Jira configurado). Sem ele, pega-se o primeiro master.
//
// Para REVERTER: trocar `openAuth` de volta por `authenticate` +
// `requirePermission(...)` nas rotas do Orquestra (ver git da migração).
// ============================================================================

let cachedFallback = null;
let pendingLookup = null;

async function getFallbackUser() {
  if (cachedFallback) return cachedFallback;
  if (pendingLookup) return pendingLookup;

  const email = process.env.KIOSK_USER_EMAIL || null;
  pendingLookup = query(
    `SELECT id, email
       FROM maestro.users
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR email = $1)
      ORDER BY (email = $1) DESC NULLS LAST, is_master DESC, created_at ASC
      LIMIT 1`,
    [email],
  )
    .then((r) => {
      cachedFallback = r.rows[0] || null;
      pendingLookup = null;
      return cachedFallback;
    })
    .catch((err) => {
      console.error('openAuth: falha ao resolver usuário padrão:', err.message);
      pendingLookup = null;
      return null;
    });

  return pendingLookup;
}

export const openAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const parts = authHeader ? authHeader.split(' ') : [];

    // Usa o token se vier num formato válido "Bearer TOKEN".
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
      try {
        req.user = jwt.verify(parts[1], process.env.JWT_SECRET);
        return next();
      } catch {
        // token inválido/expirado não bloqueia: cai para a identidade-padrão
      }
    }

    const fallback = await getFallbackUser();
    if (fallback) {
      req.user = { id: fallback.id, email: fallback.email };
    }
    // Se não houver usuário master no banco, segue sem req.user; controllers
    // das telas de chão de fábrica que leem req.user usam optional chaining.
    return next();
  } catch (err) {
    console.error('❌ Erro no openAuth:', err);
    return next();
  }
};
