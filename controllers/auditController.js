import pool from '../config/database.js';
import {
  deleteJiraAttachment,
  listJiraIssueAttachments,
  transitionJiraIssue,
  updateJiraIssueFields,
} from '../services/jiraService.js';

const MAX_LIMIT = 200;
const ARAMIDA_SQM_FIELDS = [
  'customfield_13625',
  'customfield_13626',
  'customfield_13627',
  'customfield_13631',
  'customfield_13632',
  'customfield_13633',
];
const TENSYLON_SQM_FIELDS = [
  'customfield_13636', // Tensylon M²
  'customfield_13634', // Tensylon M² real
];

function parseLimitOffset(query) {
  const limit  = Math.min(Math.max(Number(query.limit)  || 50, 1), MAX_LIMIT);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

// ─── GET /api/audit/projects ────────────────────────────────────────────────
//
// Query params (todos opcionais):
//   action      'CREATE' | 'UPDATE' | 'CLONE'
//   user_id     integer
//   project_id  integer
//   search      texto (busca em project_code e actor_email, ILIKE)
//   from        ISO date — created_at >=
//   to          ISO date — created_at <=
//   limit       1..200 (default 50)
//   offset      0+ (default 0)
//
// Response: { success, data: [...], total, limit, offset }
//
export const listProjectAudit = async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req.query);
    const conds  = [];
    const params = [];

    if (req.query.action) {
      params.push(String(req.query.action).toUpperCase());
      conds.push(`action = $${params.length}`);
    }
    if (req.query.user_id) {
      const n = Number(req.query.user_id);
      if (Number.isFinite(n)) {
        params.push(n);
        conds.push(`actor_user_id = $${params.length}`);
      }
    }
    if (req.query.project_id) {
      const n = Number(req.query.project_id);
      if (Number.isFinite(n)) {
        params.push(n);
        conds.push(`project_id = $${params.length}`);
      }
    }
    if (req.query.search?.trim()) {
      params.push(`%${req.query.search.trim()}%`);
      conds.push(`(project_code ILIKE $${params.length} OR actor_email ILIKE $${params.length})`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      conds.push(`created_at >= $${params.length}`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conds.push(`created_at <= $${params.length}`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const totalResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM maestro.project_audit ${where}`,
      params
    );

    const dataParams = [...params, limit, offset];
    const dataResult = await pool.query(
      `SELECT id, created_at, actor_user_id, actor_email, action,
              project_id, project_code, "before", "after", metadata,
              request_id, ip
         FROM maestro.project_audit
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    return res.json({
      success: true,
      data:  dataResult.rows,
      total: totalResult.rows[0].total,
      limit, offset,
    });
  } catch (error) {
    console.error('[Audit] listProjectAudit error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/audit/os-generation ───────────────────────────────────────────
//
// Query params (todos opcionais):
//   user_id     integer
//   request_id  uuid
//   search      texto (em actor_email)
//   from / to   ISO date
//   limit       1..200 (default 50)
//   offset      0+
//
export const listOsGenerationAudit = async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req.query);
    const conds  = [];
    const params = [];

    if (req.query.user_id) {
      const n = Number(req.query.user_id);
      if (Number.isFinite(n)) {
        params.push(n);
        conds.push(`actor_user_id = $${params.length}`);
      }
    }
    if (req.query.request_id) {
      params.push(req.query.request_id);
      conds.push(`request_id = $${params.length}`);
    }
    if (req.query.search?.trim()) {
      params.push(`%${req.query.search.trim()}%`);
      conds.push(`actor_email ILIKE $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      conds.push(`created_at >= $${params.length}`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conds.push(`created_at <= $${params.length}`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const totalResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM maestro.os_generation_audit ${where}`,
      params
    );

    const dataParams = [...params, limit, offset];
    const dataResult = await pool.query(
      `SELECT id, created_at, actor_user_id, actor_email, request_id,
              total_requested, total_success, total_failed, total_field_warnings,
              entries, ip, user_agent
         FROM maestro.os_generation_audit
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    return res.json({
      success: true,
      data:  dataResult.rows,
      total: totalResult.rows[0].total,
      limit, offset,
    });
  } catch (error) {
    console.error('[Audit] listOsGenerationAudit error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

function isGeneratedOsPdf(attachment) {
  const filename = String(attachment?.filename || '').trim();
  const mimeType = String(attachment?.mimeType || '').toLowerCase();
  return /^os-.*\.pdf$/i.test(filename) || (filename.toLowerCase().startsWith('os-') && mimeType === 'application/pdf');
}

function fieldsToClear(entry, projectById) {
  const project = projectById.get(Number(entry.project_id));
  const material = String(project?.material_type || '').toUpperCase();

  if (material === 'TENSYLON' || String(entry.jiraKey || '').toUpperCase().startsWith('TENSYLON')) {
    return TENSYLON_SQM_FIELDS;
  }

  return ARAMIDA_SQM_FIELDS;
}

// ─── POST /api/audit/os-generation/:id/rollback ─────────────────────────────
//
// Reverte os efeitos de Jira da geração de OS registrada no audit:
//   - remove anexos PDF cujo nome comeca com "OS-"
//   - limpa os custom fields de m2 preenchidos durante a geracao
//   - devolve o card de "Liberado Engenharia" para "A Produzir"
//
export const rollbackOsGenerationAudit = async (req, res) => {
  try {
    const auditId = Number(req.params.id);
    if (!Number.isFinite(auditId)) {
      return res.status(400).json({ success: false, message: 'ID de auditoria invalido.' });
    }

    const { rows } = await pool.query(
      `SELECT id, entries
         FROM maestro.os_generation_audit
        WHERE id = $1`,
      [auditId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Registro de auditoria nao encontrado.' });
    }

    const entries = Array.isArray(rows[0].entries) ? rows[0].entries : [];
    const successEntries = entries.filter((entry) => entry?.status === 'success' && entry?.jiraKey);

    if (successEntries.length === 0) {
      return res.status(422).json({ success: false, message: 'Este registro nao possui OS gerada com sucesso para rollback.' });
    }

    const projectIds = [
      ...new Set(successEntries.map((entry) => Number(entry.project_id)).filter(Number.isFinite)),
    ];
    const projectById = new Map();

    if (projectIds.length) {
      const projectRes = await pool.query(
        `SELECT id, material_type
           FROM maestro.project
          WHERE id = ANY($1::int[])`,
        [projectIds]
      );
      for (const project of projectRes.rows) {
        projectById.set(Number(project.id), project);
      }
    }

    const results = [];
    for (const entry of successEntries) {
      const result = {
        jiraKey: entry.jiraKey,
        os_number: entry.os_number || null,
        deletedAttachments: [],
        clearedFields: [],
        statusTransition: null,
        errors: [],
      };

      try {
        const attachments = await listJiraIssueAttachments(req.user.id, entry.jiraKey);
        const generatedPdfs = attachments.filter(isGeneratedOsPdf);

        for (const attachment of generatedPdfs) {
          try {
            await deleteJiraAttachment(req.user.id, attachment.id);
            result.deletedAttachments.push({ id: attachment.id, filename: attachment.filename });
          } catch (error) {
            result.errors.push(`Falha ao remover anexo ${attachment.filename || attachment.id}: ${error.message}`);
          }
        }
      } catch (error) {
        result.errors.push(`Falha ao listar anexos: ${error.message}`);
      }

      const fieldIds = fieldsToClear(entry, projectById);
      if (fieldIds.length) {
        try {
          const clearPayload = Object.fromEntries(fieldIds.map((fieldId) => [fieldId, null]));
          await updateJiraIssueFields(req.user.id, entry.jiraKey, clearPayload);
          result.clearedFields = fieldIds;
        } catch (error) {
          const msg = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
          result.errors.push(`Falha ao limpar custom fields: ${msg}`);
        }
      }

      try {
        const tr = await transitionJiraIssue(req.user.id, entry.jiraKey, 'A Produzir', 'Liberado Engenharia');
        result.statusTransition = tr;
        if (!tr.changed && tr.reason === 'unexpected-source-status') {
          result.errors.push(`Card nao movido: status atual "${tr.from}" (esperado: "Liberado Engenharia" ou "A Produzir")`);
        }
      } catch (error) {
        const msg = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
        result.errors.push(`Falha ao devolver status para A Produzir: ${msg}`);
      }

      results.push(result);
    }

    const deletedAttachments = results.reduce((sum, item) => sum + item.deletedAttachments.length, 0);
    const clearedFields = results.reduce((sum, item) => sum + item.clearedFields.length, 0);
    const movedCards = results.filter((item) => item.statusTransition?.changed).length;
    const errors = results.flatMap((item) => item.errors.map((message) => ({ jiraKey: item.jiraKey, message })));

    return res.json({
      success: errors.length === 0,
      message: errors.length
        ? 'Rollback concluido com avisos.'
        : 'Rollback concluido.',
      data: {
        audit_id: auditId,
        total_cards: results.length,
        deleted_attachments: deletedAttachments,
        cleared_fields: clearedFields,
        moved_cards: movedCards,
        errors,
        results,
      },
    });
  } catch (error) {
    console.error('[Audit] rollbackOsGenerationAudit error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
