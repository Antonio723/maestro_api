import pool from '../config/database.js';

// Etapa 7 — alocações de consumo em recebimentos de painel.
// Tabela-ponte que liga consumos do backend CarbonProduction (referência
// fraca via cutting_record_id / cutting_consumption_id / cutting_split_id)
// ao recebimento maestro.panel_receipts. consumed_m2 do recebimento é
// derivado da soma destas linhas (cancelled_at IS NULL) — ver BASE_SELECT
// em panelReceiptsController.

function parseM2(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

const BASE_SELECT = `
  SELECT
    pc.id,
    pc.panel_receipt_id,
    pc.cutting_record_id,
    pc.cutting_consumption_id,
    pc.cutting_split_id,
    pc.order_number,
    pc.invoice_number,
    pc.used_m2,
    pc.supplier,
    pc.external_batch,
    pc.created_by,
    pc.created_at,
    pc.cancelled_at,
    pc.cancelled_by,
    pr.supplier         AS receipt_supplier,
    pr.external_batch   AS receipt_external_batch,
    pr.invoice_number   AS receipt_invoice_number,
    pr.received_at      AS receipt_received_at,
    pr.layers           AS receipt_layers
  FROM maestro.panel_consumptions pc
  JOIN maestro.panel_receipts pr ON pr.id = pc.panel_receipt_id
`;

// GET /api/panel-consumptions?orderNumber=&invoiceNumber=&cuttingRecordId=
export const listar = async (req, res) => {
  try {
    const { orderNumber, invoiceNumber, cuttingRecordId, includeCancelled } = req.query;
    const wheres = [];
    const values = [];

    if (orderNumber) {
      values.push(String(orderNumber).trim());
      wheres.push(`pc.order_number = $${values.length}`);
    }
    if (invoiceNumber) {
      values.push(String(invoiceNumber).trim());
      wheres.push(`pc.invoice_number = $${values.length}`);
    }
    if (cuttingRecordId) {
      values.push(Number(cuttingRecordId));
      wheres.push(`pc.cutting_record_id = $${values.length}`);
    }
    if (String(includeCancelled || '').toLowerCase() !== 'true') {
      wheres.push(`pc.cancelled_at IS NULL`);
    }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const result = await pool.query(
      `${BASE_SELECT} ${where} ORDER BY pc.created_at DESC, pc.id DESC`,
      values,
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Erro ao listar panel_consumptions:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/panel-consumptions  — body: { panelReceiptId, usedM2, orderNumber, invoiceNumber?, cuttingRecordId?, cuttingConsumptionId?, cuttingSplitId?, supplier?, externalBatch? }
// Valida em transação FOR UPDATE que há saldo livre suficiente.
export const criar = async (req, res) => {
  const client = await pool.connect();
  try {
    const panelReceiptId      = parseIntOrNull(req.body?.panelReceiptId ?? req.body?.panel_receipt_id);
    const usedM2              = parseM2(req.body?.usedM2 ?? req.body?.used_m2);
    const orderNumber         = req.body?.orderNumber  ? String(req.body.orderNumber).trim()  : null;
    const invoiceNumber       = req.body?.invoiceNumber ? String(req.body.invoiceNumber).trim() : null;
    const cuttingRecordId     = parseIntOrNull(req.body?.cuttingRecordId);
    const cuttingConsumptionId = parseIntOrNull(req.body?.cuttingConsumptionId);
    const cuttingSplitId      = parseIntOrNull(req.body?.cuttingSplitId);
    const supplier            = req.body?.supplier      ? String(req.body.supplier).trim()      : null;
    const externalBatch       = req.body?.externalBatch ? String(req.body.externalBatch).trim() : null;

    const missing = [];
    if (panelReceiptId === null) missing.push('panelReceiptId');
    if (usedM2 === null)         missing.push('usedM2');
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Campos obrigatórios faltando ou inválidos: ${missing.join(', ')}`,
      });
    }

    await client.query('BEGIN');

    const saldoRes = await client.query(
      `SELECT
         pr.received_m2,
         COALESCE((
           SELECT SUM(used_m2) FROM maestro.panel_consumptions
            WHERE panel_receipt_id = pr.id
              AND cancelled_at IS NULL
         ), 0) AS consumed_total,
         COALESCE((
           SELECT SUM(reserved_m2) FROM maestro.panel_reservations
            WHERE panel_receipt_id = pr.id
              AND consumed_at IS NULL
              AND cancelled_at IS NULL
         ), 0) AS reserved_total
       FROM maestro.panel_receipts pr
       WHERE pr.id = $1
       FOR UPDATE OF pr`,
      [panelReceiptId],
    );
    if (!saldoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Recebimento não encontrado.' });
    }
    const { received_m2, consumed_total, reserved_total } = saldoRes.rows[0];
    const freeBalance = Number(received_m2) - Number(consumed_total) - Number(reserved_total);

    // Não bloqueia se exceder — apenas alerta. A planilha original permite
    // saldo negativo e o faturista resolve depois (aba "Itens Negativos").
    const warning = usedM2 > freeBalance + 1e-6
      ? `Alocação ${usedM2.toFixed(2)} m² excede saldo livre ${freeBalance.toFixed(2)} m² — recebimento ficará negativo.`
      : null;

    const ins = await client.query(
      `INSERT INTO maestro.panel_consumptions
         (panel_receipt_id, cutting_record_id, cutting_consumption_id, cutting_split_id,
          order_number, invoice_number, used_m2, supplier, external_batch, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [panelReceiptId, cuttingRecordId, cuttingConsumptionId, cuttingSplitId,
       orderNumber, invoiceNumber, usedM2, supplier, externalBatch, req.user?.id || null],
    );
    await client.query('COMMIT');

    const created = await pool.query(`${BASE_SELECT} WHERE pc.id = $1`, [ins.rows[0].id]);
    return res.status(201).json({ success: true, data: created.rows[0], warning });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23503') {
      return res.status(404).json({ success: false, message: 'Recebimento não encontrado.' });
    }
    console.error('❌ Erro ao criar panel_consumption:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// PUT /api/panel-consumptions/by-record/:cuttingRecordId
// Substitui o conjunto de alocações de um cutting_record por um novo conjunto
// (idempotente). Útil quando o frontend reaponta NFs ou re-divide consumos.
// body: {
//   allocations: [{ panelReceiptId, usedM2, ... }],
//   orderNumber?,
//   stage?: 'apontamento' | 'faturamento'   (default 'faturamento')
// }
//
// stage='apontamento' (Etapa 3): cancela só linhas SEM invoice_number — as
//   linhas faturadas (com NF) permanecem ativas. Usado em mainCorte.jsx
//   quando o usuário salva apenas o corte sem faturar ainda.
// stage='faturamento' (Etapa 7): cancela TODAS — usado no invoicing.jsx
//   quando o faturista re-divide a NF entre recebimentos.
export const replaceByRecord = async (req, res) => {
  const client = await pool.connect();
  try {
    const cuttingRecordId = parseIntOrNull(req.params.cuttingRecordId);
    if (cuttingRecordId === null) {
      return res.status(400).json({ success: false, message: 'cuttingRecordId inválido.' });
    }
    const allocations = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    const orderNumber = req.body?.orderNumber ? String(req.body.orderNumber).trim() : null;
    const stage = String(req.body?.stage || 'faturamento').toLowerCase();
    if (!['apontamento', 'faturamento'].includes(stage)) {
      return res.status(400).json({ success: false, message: "stage deve ser 'apontamento' ou 'faturamento'." });
    }

    await client.query('BEGIN');

    // Soft-cancel: 'apontamento' só toca em linhas sem NF; 'faturamento'
    // cancela todas as ativas do corte (o invoicing manda a verdade nova).
    const cancelWhere = stage === 'apontamento'
      ? `cutting_record_id = $1 AND cancelled_at IS NULL AND invoice_number IS NULL`
      : `cutting_record_id = $1 AND cancelled_at IS NULL`;
    await client.query(
      `UPDATE maestro.panel_consumptions
          SET cancelled_at = now(), cancelled_by = $2
        WHERE ${cancelWhere}`,
      [cuttingRecordId, req.user?.id || null],
    );

    const created = [];
    for (const alloc of allocations) {
      const panelReceiptId = parseIntOrNull(alloc?.panelReceiptId ?? alloc?.panel_receipt_id);
      const usedM2 = parseM2(alloc?.usedM2 ?? alloc?.used_m2);
      if (panelReceiptId === null || usedM2 === null) continue;
      const ins = await client.query(
        `INSERT INTO maestro.panel_consumptions
           (panel_receipt_id, cutting_record_id, cutting_consumption_id, cutting_split_id,
            order_number, invoice_number, used_m2, supplier, external_batch, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          panelReceiptId,
          cuttingRecordId,
          parseIntOrNull(alloc.cuttingConsumptionId),
          parseIntOrNull(alloc.cuttingSplitId),
          alloc.orderNumber ? String(alloc.orderNumber).trim() : orderNumber,
          alloc.invoiceNumber ? String(alloc.invoiceNumber).trim() : null,
          usedM2,
          alloc.supplier      ? String(alloc.supplier).trim()      : null,
          alloc.externalBatch ? String(alloc.externalBatch).trim() : null,
          req.user?.id || null,
        ],
      );
      created.push(ins.rows[0].id);
    }

    await client.query('COMMIT');

    const result = await pool.query(
      `${BASE_SELECT} WHERE pc.cutting_record_id = $1 AND pc.cancelled_at IS NULL ORDER BY pc.id`,
      [cuttingRecordId],
    );
    return res.status(200).json({ success: true, data: result.rows, replaced: created.length });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23503') {
      return res.status(400).json({ success: false, message: 'Recebimento referenciado não existe.' });
    }
    console.error('❌ Erro ao substituir panel_consumptions por record:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// DELETE /api/panel-consumptions/:id  (soft cancel)
export const cancelar = async (req, res) => {
  try {
    const id = parseIntOrNull(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const result = await pool.query(
      `UPDATE maestro.panel_consumptions
          SET cancelled_at = now(), cancelled_by = $2
        WHERE id = $1 AND cancelled_at IS NULL
        RETURNING id`,
      [id, req.user?.id || null],
    );
    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Alocação não encontrada ou já cancelada.',
      });
    }
    const updated = await pool.query(`${BASE_SELECT} WHERE pc.id = $1`, [id]);
    return res.status(200).json({ success: true, data: updated.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao cancelar panel_consumption:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
