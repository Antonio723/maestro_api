import pool from '../config/database.js';

// Substitui a aba "Notas Recebidas" da planilha "Fábrica de Opaco - Rev2.xlsx".
// Etapa 1 da SPEC-faturamento-paineis.md: CRUD puro + saldo derivado.
// consumed_m2 e reserved_m2 são mantidos pelas Etapas 3 (vínculo apontamento)
// e 4 (reservas) — nesta etapa permanecem em 0.

function parseM2(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseLayers(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// consumed_m2 vem de panel_consumptions (alocações ativas — Etapa 7).
// reserved_m2 vem de panel_reservations ativas (Etapa 4).
// validation_status retorna 'NEGATIVE' quando saldo < 0 (regra automática),
// caso contrário o valor persistido ('AUTO' ou 'VALIDATED'). A coluna
// pr.consumed_m2 da tabela permanece como 0 (legado); a verdade vem do JOIN.
const BASE_SELECT = `
  SELECT
    pr.id,
    pr.supplier,
    pr.external_batch,
    pr.invoice_number,
    pr.layers,
    pr.received_m2,
    COALESCE(cns.total, 0) AS consumed_m2,
    COALESCE(rsv.total, 0) AS reserved_m2,
    (pr.received_m2 - COALESCE(cns.total, 0) - COALESCE(rsv.total, 0)) AS balance_m2,
    CASE
      WHEN (pr.received_m2 - COALESCE(cns.total, 0) - COALESCE(rsv.total, 0)) < 0 THEN 'NEGATIVE'
      ELSE pr.validation_status
    END AS effective_status,
    pr.validation_status,
    pr.validated_by,
    pr.validated_at,
    pr.received_at,
    pr.notes,
    pr.created_by,
    pr.created_at,
    pr.updated_at,
    vu.name AS validated_by_name
  FROM maestro.panel_receipts pr
  LEFT JOIN LATERAL (
    SELECT SUM(reserved_m2) AS total
      FROM maestro.panel_reservations
     WHERE panel_receipt_id = pr.id
       AND consumed_at IS NULL
       AND cancelled_at IS NULL
  ) rsv ON true
  LEFT JOIN LATERAL (
    SELECT SUM(used_m2) AS total
      FROM maestro.panel_consumptions
     WHERE panel_receipt_id = pr.id
       AND cancelled_at IS NULL
  ) cns ON true
  LEFT JOIN maestro.users vu ON vu.id = pr.validated_by
`;

// GET /api/panel-receipts
export const listar = async (req, res) => {
  try {
    const { supplier, batch, dateFrom, dateTo, hasBalance, onlyNegative } = req.query;
    const wheres = [];
    const values = [];

    if (supplier) {
      values.push(supplier);
      wheres.push(`pr.supplier ILIKE '%' || $${values.length} || '%'`);
    }
    if (batch) {
      values.push(batch);
      wheres.push(`pr.external_batch ILIKE '%' || $${values.length} || '%'`);
    }
    if (dateFrom) {
      values.push(dateFrom);
      wheres.push(`pr.received_at >= $${values.length}`);
    }
    if (dateTo) {
      values.push(dateTo);
      wheres.push(`pr.received_at <= $${values.length}`);
    }

    // Filtros derivados (precisam recalcular reserved_m2 e consumed_m2)
    const balanceExpr = `(pr.received_m2 - COALESCE((
      SELECT SUM(used_m2) FROM maestro.panel_consumptions
       WHERE panel_receipt_id = pr.id
         AND cancelled_at IS NULL
    ), 0) - COALESCE((
      SELECT SUM(reserved_m2) FROM maestro.panel_reservations
       WHERE panel_receipt_id = pr.id
         AND consumed_at IS NULL
         AND cancelled_at IS NULL
    ), 0))`;

    if (String(hasBalance || '').toLowerCase() === 'true') {
      wheres.push(`${balanceExpr} > 0`);
    }
    if (String(onlyNegative || '').toLowerCase() === 'true') {
      wheres.push(`${balanceExpr} < 0`);
    }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const result = await pool.query(
      `${BASE_SELECT} ${where} ORDER BY pr.received_at DESC, pr.id DESC`,
      values,
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Erro ao listar recebimentos de painel:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/panel-receipts/:id
export const obter = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const result = await pool.query(`${BASE_SELECT} WHERE pr.id = $1`, [id]);
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Recebimento não encontrado.' });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao obter recebimento de painel:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/panel-receipts
export const criar = async (req, res) => {
  try {
    const supplier      = String(req.body?.supplier || '').trim();
    const externalBatch = String(req.body?.externalBatch || req.body?.external_batch || '').trim();
    const invoiceRaw    = req.body?.invoiceNumber ?? req.body?.invoice_number;
    const invoiceNumber = invoiceRaw == null ? null : String(invoiceRaw).trim() || null;
    const layers        = parseLayers(req.body?.layers);
    const receivedM2    = parseM2(req.body?.receivedM2 ?? req.body?.received_m2);
    const receivedAt    = parseDate(req.body?.receivedAt ?? req.body?.received_at);
    const notes         = req.body?.notes ? String(req.body.notes).trim() || null : null;

    const missing = [];
    if (!supplier)         missing.push('supplier');
    if (!externalBatch)    missing.push('externalBatch');
    if (layers === null)   missing.push('layers');
    if (receivedM2 === null) missing.push('receivedM2');
    if (!receivedAt)       missing.push('receivedAt');
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Campos obrigatórios faltando ou inválidos: ${missing.join(', ')}`,
      });
    }

    const result = await pool.query(
      `INSERT INTO maestro.panel_receipts
         (supplier, external_batch, invoice_number, layers, received_m2, received_at, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [supplier, externalBatch, invoiceNumber, layers, receivedM2, receivedAt, notes, req.user?.id || null],
    );

    const created = await pool.query(`${BASE_SELECT} WHERE pr.id = $1`, [result.rows[0].id]);
    return res.status(201).json({ success: true, data: created.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Já existe um recebimento com este fornecedor + lote + NF.',
      });
    }
    console.error('❌ Erro ao criar recebimento de painel:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PUT /api/panel-receipts/:id
export const atualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }

    const fields = {};
    if (req.body?.supplier !== undefined) {
      const v = String(req.body.supplier).trim();
      if (!v) return res.status(400).json({ success: false, message: 'supplier não pode ser vazio.' });
      fields.supplier = v;
    }
    if (req.body?.externalBatch !== undefined || req.body?.external_batch !== undefined) {
      const v = String(req.body?.externalBatch ?? req.body?.external_batch).trim();
      if (!v) return res.status(400).json({ success: false, message: 'externalBatch não pode ser vazio.' });
      fields.external_batch = v;
    }
    if (req.body?.invoiceNumber !== undefined || req.body?.invoice_number !== undefined) {
      const raw = req.body?.invoiceNumber ?? req.body?.invoice_number;
      fields.invoice_number = raw == null || String(raw).trim() === '' ? null : String(raw).trim();
    }
    if (req.body?.layers !== undefined) {
      const v = parseLayers(req.body.layers);
      if (v === null) return res.status(400).json({ success: false, message: 'layers inválido.' });
      fields.layers = v;
    }
    if (req.body?.receivedM2 !== undefined || req.body?.received_m2 !== undefined) {
      const v = parseM2(req.body?.receivedM2 ?? req.body?.received_m2);
      if (v === null) return res.status(400).json({ success: false, message: 'receivedM2 inválido.' });
      fields.received_m2 = v;
    }
    if (req.body?.receivedAt !== undefined || req.body?.received_at !== undefined) {
      const v = parseDate(req.body?.receivedAt ?? req.body?.received_at);
      if (!v) return res.status(400).json({ success: false, message: 'receivedAt inválido.' });
      fields.received_at = v;
    }
    if (req.body?.notes !== undefined) {
      const raw = req.body.notes;
      fields.notes = raw == null || String(raw).trim() === '' ? null : String(raw).trim();
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(id);

    const result = await pool.query(
      `UPDATE maestro.panel_receipts
          SET ${setClauses}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING id`,
      values,
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Recebimento não encontrado.' });
    }
    const updated = await pool.query(`${BASE_SELECT} WHERE pr.id = $1`, [id]);
    return res.status(200).json({ success: true, data: updated.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Já existe um recebimento com este fornecedor + lote + NF.',
      });
    }
    console.error('❌ Erro ao atualizar recebimento de painel:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// DELETE /api/panel-receipts/:id
// Bloqueia se houver consumo persistido (Etapa 7) ou reserva ativa (Etapa 4).
export const excluir = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }

    const usage = await pool.query(
      `SELECT
         COALESCE((
           SELECT SUM(used_m2) FROM maestro.panel_consumptions
            WHERE panel_receipt_id = pr.id
              AND cancelled_at IS NULL
         ), 0) AS active_consumed,
         COALESCE((
           SELECT SUM(reserved_m2) FROM maestro.panel_reservations
            WHERE panel_receipt_id = pr.id
              AND consumed_at IS NULL
              AND cancelled_at IS NULL
         ), 0) AS active_reserved
       FROM maestro.panel_receipts pr
       WHERE pr.id = $1`,
      [id],
    );
    if (!usage.rows.length) {
      return res.status(404).json({ success: false, message: 'Recebimento não encontrado.' });
    }
    const { active_consumed, active_reserved } = usage.rows[0];
    if (Number(active_consumed) > 0) {
      return res.status(409).json({
        success: false,
        message: 'Recebimento já tem consumo apontado — não pode ser excluído.',
      });
    }
    if (Number(active_reserved) > 0) {
      return res.status(409).json({
        success: false,
        message: 'Recebimento tem reserva ativa — cancele as reservas antes de excluir.',
      });
    }

    await pool.query('DELETE FROM maestro.panel_receipts WHERE id = $1', [id]);
    return res.status(200).json({ success: true, message: 'Recebimento excluído.' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        success: false,
        message: 'Recebimento está em uso e não pode ser excluído.',
      });
    }
    console.error('❌ Erro ao excluir recebimento de painel:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/panel-receipts/:id/validate
// Marca como "saldo conferido pelo faturista". Saldo negativo é derivado do
// CASE no BASE_SELECT — o status persistido nunca é NEGATIVE.
export const validar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }

    const result = await pool.query(
      `UPDATE maestro.panel_receipts
          SET validation_status = 'VALIDATED',
              validated_by      = $2,
              validated_at      = now(),
              updated_at        = now()
        WHERE id = $1
        RETURNING id`,
      [id, req.user?.id || null],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Recebimento não encontrado.' });
    }
    const updated = await pool.query(`${BASE_SELECT} WHERE pr.id = $1`, [id]);
    return res.status(200).json({ success: true, data: updated.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao validar recebimento de painel:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/panel-receipts/lookup?supplier=&batch=
// Autocomplete usado pelo mainCorte.jsx ao apontar consumo externo.
// Retorna ordenado por received_at ASC (regra "queima lote antigo primeiro")
// e apenas recebimentos com saldo > 0.
export const lookup = async (req, res) => {
  try {
    const supplier = String(req.query.supplier || '').trim();
    const batch    = String(req.query.batch || '').trim();
    if (!supplier) {
      return res.status(400).json({ success: false, message: 'supplier é obrigatório.' });
    }

    const values = [supplier];
    let where = `pr.supplier ILIKE $1`;
    if (batch) {
      values.push(batch);
      where += ` AND pr.external_batch ILIKE '%' || $${values.length} || '%'`;
    }
    where += ` AND (pr.received_m2 - pr.consumed_m2 - COALESCE((
                SELECT SUM(reserved_m2) FROM maestro.panel_reservations
                 WHERE panel_receipt_id = pr.id
                   AND consumed_at IS NULL
                   AND cancelled_at IS NULL
              ), 0)) > 0`;

    const result = await pool.query(
      `${BASE_SELECT} WHERE ${where} ORDER BY pr.received_at ASC, pr.id ASC LIMIT 50`,
      values,
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Erro no lookup de recebimentos de painel:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
