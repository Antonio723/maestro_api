import pool from '../config/database.js';

// Etapa 4 da SPEC-faturamento-paineis.md — reservas de saldo (campo
// "Metragem Reservada" da planilha "Fábrica de Opaco - Rev2.xlsx").
// reserved_m2 do panel_receipt é derivado por SUM em SELECT no
// panelReceiptsController.BASE_SELECT, então estes endpoints só precisam
// manter a tabela panel_reservations consistente.

function parseM2(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const RESERVATION_SELECT = `
  SELECT
    r.id,
    r.panel_receipt_id,
    r.order_number,
    r.reserved_m2,
    r.notes,
    r.reserved_by,
    r.reserved_at,
    r.consumed_at,
    r.cancelled_at,
    r.cancelled_by,
    ru.name AS reserved_by_name,
    cu.name AS cancelled_by_name,
    CASE
      WHEN r.consumed_at  IS NOT NULL THEN 'CONSUMED'
      WHEN r.cancelled_at IS NOT NULL THEN 'CANCELLED'
      ELSE 'ACTIVE'
    END AS status
  FROM maestro.panel_reservations r
  LEFT JOIN maestro.users ru ON ru.id = r.reserved_by
  LEFT JOIN maestro.users cu ON cu.id = r.cancelled_by
`;

// GET /api/panel-receipts/:id/reservations
export const listarReservas = async (req, res) => {
  try {
    const receiptId = Number(req.params.id);
    if (!Number.isFinite(receiptId)) {
      return res.status(400).json({ success: false, message: 'id do recebimento inválido.' });
    }

    const result = await pool.query(
      `${RESERVATION_SELECT} WHERE r.panel_receipt_id = $1 ORDER BY r.reserved_at DESC`,
      [receiptId],
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Erro ao listar reservas:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/panel-receipts/:id/reservations
export const criarReserva = async (req, res) => {
  const client = await pool.connect();
  try {
    const receiptId = Number(req.params.id);
    if (!Number.isFinite(receiptId)) {
      return res.status(400).json({ success: false, message: 'id do recebimento inválido.' });
    }
    const orderNumber = String(req.body?.orderNumber ?? req.body?.order_number ?? '').trim();
    const reservedM2  = parseM2(req.body?.reservedM2 ?? req.body?.reserved_m2);
    const notes       = req.body?.notes ? String(req.body.notes).trim() || null : null;

    const missing = [];
    if (!orderNumber)        missing.push('orderNumber');
    if (reservedM2 === null) missing.push('reservedM2');
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Campos obrigatórios faltando ou inválidos: ${missing.join(', ')}`,
      });
    }

    // Não permitir reservar mais do que o saldo livre. Cálculo em transação
    // para evitar corrida entre reservas concorrentes.
    await client.query('BEGIN');

    const saldoRes = await client.query(
      `SELECT
         pr.received_m2,
         pr.consumed_m2,
         COALESCE((
           SELECT SUM(reserved_m2) FROM maestro.panel_reservations
            WHERE panel_receipt_id = pr.id
              AND consumed_at IS NULL
              AND cancelled_at IS NULL
         ), 0) AS reserved_total
       FROM maestro.panel_receipts pr
       WHERE pr.id = $1
       FOR UPDATE OF pr`,
      [receiptId],
    );
    if (!saldoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Recebimento não encontrado.' });
    }
    const { received_m2, consumed_m2, reserved_total } = saldoRes.rows[0];
    const freeBalance = Number(received_m2) - Number(consumed_m2) - Number(reserved_total);
    if (reservedM2 > freeBalance + 1e-6) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Saldo livre insuficiente. Disponível: ${freeBalance.toFixed(2)} m².`,
      });
    }

    const ins = await client.query(
      `INSERT INTO maestro.panel_reservations
         (panel_receipt_id, order_number, reserved_m2, notes, reserved_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [receiptId, orderNumber, reservedM2, notes, req.user?.id || null],
    );
    await client.query('COMMIT');

    const created = await pool.query(
      `${RESERVATION_SELECT} WHERE r.id = $1`,
      [ins.rows[0].id],
    );
    return res.status(201).json({ success: true, data: created.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23503') {
      return res.status(404).json({ success: false, message: 'Recebimento não encontrado.' });
    }
    console.error('❌ Erro ao criar reserva:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// DELETE /api/panel-reservations/:id  (cancela; nunca apaga)
export const cancelarReserva = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }

    const result = await pool.query(
      `UPDATE maestro.panel_reservations
          SET cancelled_at = now(),
              cancelled_by = $2
        WHERE id = $1
          AND consumed_at  IS NULL
          AND cancelled_at IS NULL
        RETURNING id`,
      [id, req.user?.id || null],
    );
    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Reserva não encontrada ou já consumida/cancelada.',
      });
    }
    const updated = await pool.query(`${RESERVATION_SELECT} WHERE r.id = $1`, [id]);
    return res.status(200).json({ success: true, data: updated.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao cancelar reserva:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
