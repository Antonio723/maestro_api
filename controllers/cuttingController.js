import pool from '../config/database.js';
import { resolveJiraCardForCutting } from '../services/jiraCardLookup.js';
import { backfillCuttingJiraKeys } from '../services/cuttingJiraBackfill.js';

// Enums espelhados do Spring (cutting/enums/*). Mantém ordem dos values() —
// o front popula selects com essa ordem.
const SUPPLIERS = ['OPERA', 'COMTEC', 'PROTECTA'];
const LAYERS = ['8', '9', '11'];
const MATERIALS = ['ARAMIDA', 'TENSYLON_30A', 'TENSYLON_40A'];
// Typo DESENVOLIVMENTO preservado (R-2 do SPEC).
const KIT_TYPES = ['KIT_COMUM', 'AVULSA', 'REBLINDAGEM', 'DESENVOLIVMENTO', 'CORPO_DE_PROVA'];
const TENSYLON_TYPES = ['30A', '40A'];

const isAramida = (material) => material === 'ARAMIDA';
const isOpera = (supplier) => supplier === 'OPERA';

// Extrai YYYY-MM-DD de qualquer forma plausível ("2026-05-28",
// "2026-05-28T00:00:00.000Z", Date). Retorna null se não conseguir parsear.
// Usado para evitar shift de TZ na coluna production_date (TIMESTAMP s/ TZ).
function extractDateOnly(value) {
  if (value == null || value === '') return null;
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function todayLocalDateString() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Subquery JSON dos consumos de um cutting_record. Cada consumption traz
// plateId (FK p/ Plates), workorderLote (via JOIN p/ exibir lote no front)
// e listas aninhadas invoices/splits (correlated subqueries com pc.id).
// Evita N+1 do Spring (que usava batch-load + groupingBy no service).
const CONSUMPTIONS_JSON_SUB = `
  COALESCE((
    SELECT json_agg(json_build_object(
      'id',               pc.id,
      'usedMetrage',      pc.used_metrage::float8,
      'supplier',         pc.supplier,
      'layerQuantity',    pc.layer_quantity,
      'manualBatch',      pc.manual_batch,
      'batchNumber',      pc.batch_number,
      'plateId',          pc.plate_id,
      'plateBatchNumber', w.lote,
      'invoices', COALESCE((
        SELECT json_agg(json_build_object(
          'number',      i.invoice_number,
          'usedMetrage', pci.used_metrage::float8
        ) ORDER BY pci.id)
        FROM public.plate_consumption_invoices pci
        JOIN public.invoices i ON i.id = pci.invoice_id
        WHERE pci.plate_consumption_id = pc.id
      ), '[]'::json),
      'splits', COALESCE((
        SELECT json_agg(json_build_object(
          'id',          cs.id,
          'usedMetrage', cs.used_metrage::float8,
          'invoice',     json_build_object(
            'number',      i2.invoice_number,
            'usedMetrage', cs.used_metrage::float8
          )
        ) ORDER BY cs.id)
        FROM public.consumption_splits cs
        JOIN public.invoices i2 ON i2.id = cs.invoice_id
        WHERE cs.plate_consumption_id = pc.id
      ), '[]'::json)
    ) ORDER BY pc.id)
    FROM public.plate_consumptions pc
    LEFT JOIN public.plates p ON p.id = pc.plate_id
    LEFT JOIN public.workorder_table w ON w.id = p.workorderid
    WHERE pc.cutting_record_id = cr.id
  ), '[]'::json) AS consumptions
`;

const CUTTING_SELECT = `
  SELECT
    cr.id,
    cr.production_date    AS "productionDate",
    cr.order_number       AS "orderNumber",
    cr.order_description  AS "orderDescription",
    cr.created_at         AS "createdAt",
    cr.material,
    cr.kit_type           AS "kitType",
    cr.seal,
    cr.jira_key           AS "jiraKey",
    ${CONSUMPTIONS_JSON_SUB}
  FROM public.cutting_records cr
`;

function mapCuttingRecord(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    productionDate: row.productionDate,
    orderNumber: row.orderNumber,
    orderDescription: row.orderDescription,
    createdAt: row.createdAt,
    material: row.material,
    kitType: row.kitType,
    seal: row.seal,
    jiraKey: row.jiraKey ?? null,
    consumptions: (row.consumptions || []).map((c) => ({
      id: c.id == null ? null : Number(c.id),
      usedMetrage: c.usedMetrage == null ? null : Number(c.usedMetrage),
      supplier: c.supplier,
      layerQuantity: c.layerQuantity,
      manualBatch: c.manualBatch,
      batchNumber: c.batchNumber,
      plateId: c.plateId == null ? null : Number(c.plateId),
      plateBatchNumber: c.plateBatchNumber ?? null,
      invoices: c.invoices || [],
      splits: c.splits || [],
    })),
  };
}

// GET /autoclave is occupied; cutting lives on /cutting (mounted in server.js).
//
// O vínculo de jira_key é responsabilidade primária do cron `backfill_jira_keys`
// (roda a cada 5 min, independente da UI — ver migrateLegacyJobs.js). Aqui só
// disparamos um top-up best-effort e NÃO-BLOQUEANTE: o GET nunca espera por
// escrita (removido o antigo UPDATE síncrono no caminho de leitura). É só uma
// rede de segurança caso o cron esteja parado.
export const getAllCuttingRecords = async (_req, res) => {
  try {
    backfillCuttingJiraKeys({ limit: 50 }).catch((err) =>
      console.warn('[Cutting] backfill best-effort no list falhou:', err.message),
    );
    const { rows } = await pool.query(`${CUTTING_SELECT} ORDER BY cr.id DESC`);
    return res.json(rows.map(mapCuttingRecord));
  } catch (error) {
    console.error('[Cutting] getAll error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /cutting/backfill-jira-keys — backfill explícito (admin/manual).
// Body: { limit?: number (default 1000), reconcile?: boolean (default false) }.
// reconcile=true também re-resolve keys com board errado (ex.: Tensylon→MANTA).
// Retorna contadores antes/depois + scanned/filled/reconciled do serviço.
export const backfillJiraKeys = async (req, res) => {
  try {
    const requested = Number(req.body?.limit ?? 1000);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(5000, requested)) : 1000;
    const reconcile = req.body?.reconcile === true || req.body?.reconcile === 'true';

    const before = await pool.query(
      'SELECT COUNT(*)::int AS n FROM public.cutting_records WHERE jira_key IS NULL',
    );
    const result = await backfillCuttingJiraKeys({ limit, reconcile });
    const after = await pool.query(
      'SELECT COUNT(*)::int AS n FROM public.cutting_records WHERE jira_key IS NULL',
    );

    return res.json({
      success: true,
      data: {
        nullBefore: before.rows[0].n,
        nullAfter: after.rows[0].n,
        filled: result.filled,
        reconciled: result.reconciled,
        scanned: result.scanned,
        limit,
        reconcile,
      },
    });
  } catch (error) {
    console.error('[Cutting] backfillJiraKeys error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getCuttingRecordById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const { rows } = await pool.query(`${CUTTING_SELECT} WHERE cr.id = $1`, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: `Cutting record not found with id: ${id}` });
    }
    return res.json(mapCuttingRecord(rows[0]));
  } catch (error) {
    console.error('[Cutting] getById error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Status em que a placa pode ser consumida pelo corte (§5.3 da spec).
const CONSUMABLE_STATUSES = new Set(['EM_ESTOQUE', 'CONSUMO_PARCIAL']);

// Recalcula status da placa a partir do saldo. Espelha §5.3 da spec:
//   actual_size <= 0           → CONSUMO_TOTAL
//   0 < actual_size < init_size → CONSUMO_PARCIAL
//   actual_size >= init_size   → EM_ESTOQUE (placa restaurada após reverter)
function deriveStatusFromSize(actualSize, initSize) {
  const a = Number(actualSize);
  const i = Number(initSize);
  if (!Number.isFinite(a) || a <= 0) return 'CONSUMO_TOTAL';
  if (Number.isFinite(i) && a >= i) return 'EM_ESTOQUE';
  return 'CONSUMO_PARCIAL';
}

// ── Validação + criação dos consumos ─────────────────────────────────────────
// Espelha o validateConsumption do Spring (CuttingRecordService.java#L110) e
// adiciona as validações §5.3 da spec ausentes no Java original:
//   - saldo suficiente em actual_size
//   - status da placa em EM_ESTOQUE ou CONSUMO_PARCIAL
async function validateAndNormalize(client, consumption, material) {
  const aramida = isAramida(material);
  const opera = isOpera(consumption.supplier);

  // Lote (batch_number) é obrigatório para TODO consumo (ARAMIDA e Tensylon) —
  // sem ele o consumo entra no relatório de corte sem lote. Camadas continua
  // obrigatório só para ARAMIDA (Tensylon não tem camadas de enfesto).
  {
    const batch = (consumption.batchNumber ?? '').toString().trim();
    if (!batch) {
      const err = new Error('Lote é obrigatório para o consumo.');
      err.status = 400;
      throw err;
    }
  }

  if (aramida && opera && consumption.plateId != null) {
    const { rows } = await client.query(
      'SELECT layers, status, actual_size, init_size FROM public.plates WHERE id = $1 FOR UPDATE',
      [consumption.plateId],
    );
    if (rows.length === 0) {
      const err = new Error(`Plate not found with id: ${consumption.plateId}`);
      err.status = 404;
      throw err;
    }
    const plate = rows[0];
    if (!CONSUMABLE_STATUSES.has(plate.status)) {
      const err = new Error(
        `Placa ${consumption.plateId} está em ${plate.status} — só pode ser consumida em EM_ESTOQUE ou CONSUMO_PARCIAL.`,
      );
      err.status = 400;
      throw err;
    }

    const used = Number(consumption.usedMetrage);
    if (!Number.isFinite(used) || used <= 0) {
      const err = new Error('Used metrage must be greater than zero');
      err.status = 400;
      throw err;
    }
    const available = Number(plate.actual_size ?? 0);
    if (used > available) {
      const err = new Error(
        `Consumo (${used}) excede saldo disponível da placa ${consumption.plateId} (${available}).`,
      );
      err.status = 400;
      throw err;
    }
    // Camadas vêm da placa. Se a placa não tem layers definido, o consumo
    // ficaria sem camada — bloqueia em vez de gravar "null"/vazio.
    if (plate.layers == null || String(plate.layers).trim() === '') {
      const err = new Error(`Placa ${consumption.plateId} não tem camadas definidas.`);
      err.status = 400;
      throw err;
    }
    consumption.layerQuantity = String(plate.layers);
  } else {
    consumption.plateId = null;
    const m = Number(consumption.usedMetrage);
    if (!Number.isFinite(m) || m <= 0) {
      const err = new Error('Used metrage must be greater than zero');
      err.status = 400;
      throw err;
    }
    // ARAMIDA manual (não-OPERA, ou OPERA sem placa): camadas é obrigatório e
    // deve ser numérico. Tensylon segue isento.
    if (aramida) {
      const layers = (consumption.layerQuantity ?? '').toString().trim();
      if (!/^[0-9]+$/.test(layers)) {
        const err = new Error('Camadas é obrigatório (numérico) para consumos de ARAMIDA.');
        err.status = 400;
        throw err;
      }
    }
  }
}

// Cria o registro plate_consumptions + (quando aplica) plate_event USO_CORTE,
// decremento de actual_size e reavaliação do status da placa.
async function insertConsumption(client, consumption, recordId, material) {
  const aramida = isAramida(material);
  const opera = isOpera(consumption.supplier);
  // Spring marca manualBatch como true se NÃO for OPERA+ARAMIDA.
  const manualBatch = !opera || !aramida;
  const plateId = aramida && opera && consumption.plateId != null
    ? Number(consumption.plateId)
    : null;

  const { rows } = await client.query(
    `INSERT INTO public.plate_consumptions
      (used_metrage, batch_number, supplier, layer_quantity, manual_batch, plate_id, cutting_record_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      Number(consumption.usedMetrage),
      consumption.batchNumber || null,
      consumption.supplier,
      consumption.layerQuantity,
      manualBatch,
      plateId,
      recordId,
    ],
  );
  const consumptionId = Number(rows[0].id);

  if (aramida && opera && plateId != null) {
    await client.query(
      `INSERT INTO public.plate_event
        (plate_id, event_type, event_date, consumed_area, description, consumption_reference_id)
       VALUES ($1, 'USO_CORTE', now(), $2, $3, $4)`,
      [
        plateId,
        Number(consumption.usedMetrage),
        `Consumo em corte - Apontamento: ${recordId}, Consumo: ${consumptionId}`,
        consumptionId,
      ],
    );
    const updated = await client.query(
      `UPDATE public.plates
          SET actual_size = COALESCE(actual_size, 0) - $1
        WHERE id = $2
        RETURNING actual_size, init_size`,
      [Number(consumption.usedMetrage), plateId],
    );
    const { actual_size, init_size } = updated.rows[0];
    const nextStatus = deriveStatusFromSize(actual_size, init_size);
    await client.query(
      'UPDATE public.plates SET status = $1 WHERE id = $2',
      [nextStatus, plateId],
    );
  }
  return consumptionId;
}

// Restaura actual_size + recalcula status + emite plate_event
// CANCELAMENTO_DE_CONSUMO mantendo a trilha de auditoria do USO_CORTE original
// (não apagar o evento — §5.3 da spec exige histórico). Usado em update + delete.
async function revertConsumptions(client, recordId) {
  const { rows } = await client.query(
    `SELECT id, plate_id, used_metrage
       FROM public.plate_consumptions
      WHERE cutting_record_id = $1`,
    [recordId],
  );
  for (const c of rows) {
    if (c.plate_id != null) {
      const updated = await client.query(
        `UPDATE public.plates
            SET actual_size = COALESCE(actual_size, 0) + $1
          WHERE id = $2
          RETURNING actual_size, init_size`,
        [Number(c.used_metrage), c.plate_id],
      );
      const { actual_size, init_size } = updated.rows[0];
      const nextStatus = deriveStatusFromSize(actual_size, init_size);
      await client.query(
        'UPDATE public.plates SET status = $1 WHERE id = $2',
        [nextStatus, c.plate_id],
      );
      await client.query(
        `INSERT INTO public.plate_event
          (plate_id, event_type, event_date, consumed_area, description, consumption_reference_id)
         VALUES ($1, 'CANCELAMENTO_DE_CONSUMO', now(), $2, $3, $4)`,
        [
          c.plate_id,
          Number(c.used_metrage),
          `Cancelamento de consumo - Apontamento: ${recordId}, Consumo: ${c.id}`,
          c.id,
        ],
      );
    }
  }
  await client.query(
    `DELETE FROM public.plate_consumptions WHERE cutting_record_id = $1`,
    [recordId],
  );
}

// Bloqueia revert/delete se algum consumo do record tem NF apontada via
// plate_consumption_invoices ou consumption_splits (§5.3 da spec — exige
// cancelar NF antes). Retorna lista de invoice_numbers para a mensagem.
async function assertNoInvoiceBound(client, recordId) {
  const { rows } = await client.query(
    `
      SELECT DISTINCT i.invoice_number
        FROM public.plate_consumptions pc
        LEFT JOIN public.plate_consumption_invoices pci ON pci.plate_consumption_id = pc.id
        LEFT JOIN public.consumption_splits cs           ON cs.plate_consumption_id = pc.id
        JOIN public.invoices i ON i.id = COALESCE(pci.invoice_id, cs.invoice_id)
       WHERE pc.cutting_record_id = $1
    `,
    [recordId],
  );
  if (rows.length > 0) {
    const numbers = rows.map((r) => r.invoice_number).join(', ');
    const err = new Error(
      `Corte possui NF apontada (${numbers}). Cancele o apontamento antes de alterar/excluir.`,
    );
    err.status = 409;
    throw err;
  }
}

// POST /cutting
export const createCuttingRecord = async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.orderNumber || !body.orderDescription) {
      return res.status(400).json({ success: false, message: 'orderNumber e orderDescription são obrigatórios.' });
    }

    await client.query('BEGIN');

    // productionDate é conceitualmente uma DATA (sem hora). O frontend manda
    // "2026-05-28" ou "2026-05-28T00:00:00.000Z" — em ambos casos só interessa
    // o YYYY-MM-DD. Não usar `new Date(...)` porque ele interpreta string
    // pura como UTC, e o pg depois faz shift p/ TZ da sessão na coluna
    // TIMESTAMP (sem TZ) — vira 2026-05-27 21:00 em -03:00. Passar string
    // direto deixa o Postgres parsear como wall-clock e armazenar 00:00:00.
    let prodDate = extractDateOnly(body.productionDate) || todayLocalDateString();

    const actor = req.user?.email || req.user?.username || null;

    // Resolve o card Jira antes do INSERT — se o board mapeado (MANTA/TENSYLON)
    // tem entrada com esta OS, congela o key. NULL é OK: corte sem card é
    // legítimo, e o backfill lazy do listing tenta de novo depois.
    const { key: jiraKey } = await resolveJiraCardForCutting(
      { orderNumber: body.orderNumber, material: body.material, kitType: body.kitType },
      client,
    );

    const { rows } = await client.query(
      `INSERT INTO public.cutting_records
        (production_date, order_number, order_description, created_at, created_by, material, kit_type, seal, jira_key)
       VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        prodDate,
        body.orderNumber,
        body.orderDescription,
        actor,
        body.material || null,
        body.kitType || null,
        body.seal || null,
        jiraKey,
      ],
    );
    const recordId = Number(rows[0].id);

    for (const c of body.consumptions || []) {
      await validateAndNormalize(client, c, body.material);
      await insertConsumption(client, c, recordId, body.material);
    }

    await client.query('COMMIT');

    const { rows: out } = await pool.query(`${CUTTING_SELECT} WHERE cr.id = $1`, [recordId]);
    return res.status(201).json(mapCuttingRecord(out[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Cutting] create error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// PUT /cutting/:id — reverte tudo e regrava (mesmo padrão do Spring update).
export const updateCuttingRecord = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const body = req.body || {};

    await client.query('BEGIN');

    const exists = await client.query(
      'SELECT id, order_number, material, kit_type, jira_key FROM public.cutting_records WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (exists.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `Cutting record not found with id: ${id}` });
    }

    await assertNoInvoiceBound(client, id);
    await revertConsumptions(client, id);

    // Mesma lógica do create: extrai só YYYY-MM-DD para evitar shift de TZ
    // no TIMESTAMP. Mantém null quando o body não tem productionDate (COALESCE
    // preserva o valor atual).
    const prodDate = extractDateOnly(body.productionDate);

    // Recalcula jira_key apenas se OS/material/kit mudaram (preserva o link
    // congelado se o usuário só editou descrição/data/lacre). Se o link
    // existente continuar válido, mantemos — evita perder referência ao
    // anexar o certificado depois.
    const prev = exists.rows[0];
    const osChanged = body.orderNumber && body.orderNumber !== prev.order_number;
    const materialChanged = (body.material || null) !== prev.material;
    const kitChanged = (body.kitType || null) !== prev.kit_type;
    let jiraKey = prev.jira_key;
    if (osChanged || materialChanged || kitChanged) {
      const resolved = await resolveJiraCardForCutting(
        { orderNumber: body.orderNumber, material: body.material, kitType: body.kitType },
        client,
      );
      jiraKey = resolved.key;
    }

    await client.query(
      `UPDATE public.cutting_records SET
        production_date   = COALESCE($2, production_date),
        order_number      = $3,
        order_description = $4,
        material          = $5,
        kit_type          = $6,
        seal              = $7,
        jira_key          = $8
       WHERE id = $1`,
      [
        id,
        prodDate,
        body.orderNumber,
        body.orderDescription,
        body.material || null,
        body.kitType || null,
        body.seal || null,
        jiraKey,
      ],
    );

    for (const c of body.consumptions || []) {
      await validateAndNormalize(client, c, body.material);
      await insertConsumption(client, c, id, body.material);
    }

    await client.query('COMMIT');

    const { rows: out } = await pool.query(`${CUTTING_SELECT} WHERE cr.id = $1`, [id]);
    return res.json(mapCuttingRecord(out[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Cutting] update error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// DELETE /cutting/:id — reverte consumos antes do delete (FK CASCADE removeria
// as linhas, mas precisamos restaurar actual_size das placas OPERA antes).
export const deleteCuttingRecord = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }

    await client.query('BEGIN');

    const exists = await client.query(
      'SELECT id FROM public.cutting_records WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (exists.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `Cutting record not found with id: ${id}` });
    }

    await assertNoInvoiceBound(client, id);
    await revertConsumptions(client, id);
    await client.query('DELETE FROM public.cutting_records WHERE id = $1', [id]);

    await client.query('COMMIT');
    return res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Cutting] delete error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// CTE base + calc do relatório de corte (cálculo de m² com e sem taxa de aramida
// — espelha a query de fechamento do PCP). As condições de filtro são
// parametrizadas ($1, $2, ...) e injetadas no WHERE da CTE `base`. Reaproveitada
// tanto pela agregação por OS quanto pelo resumo por camadas.
function cuttingReportCte(whereConds) {
  const whereClause = whereConds.length ? `WHERE ${whereConds.join(' AND ')}` : '';
  return `
    WITH base AS (
      SELECT
        cr.order_number                          AS os,
        cr.order_description                     AS descricao,
        cr.seal                                  AS lacre,
        cr.material,
        cr.production_date                       AS data_producao,
        pc.id                                    AS consumo_id,
        pc.supplier                              AS fornecedor,
        pc.batch_number                          AS lote,
        w.lote                                   AS lote_placa,
        pc.layer_quantity                        AS camadas,
        pc.used_metrage                          AS metragem_mm,
        CASE
          WHEN upper(pc.supplier) = 'COMTEC' THEN 1.5
          ELSE 1.6
        END AS largura_m
      FROM public.cutting_records cr
      JOIN public.plate_consumptions pc
        ON pc.cutting_record_id = cr.id
      LEFT JOIN public.plates p
        ON p.id = pc.plate_id
      LEFT JOIN public.workorder_table w
        ON w.id = p.workorderid
      ${whereClause}
    ),
    calc AS (
      SELECT
        *,
        round(
          (COALESCE(metragem_mm, 0) / 1000.0 * largura_m)::numeric,
          3
        ) AS m2_sem_taxa,
        round((
          COALESCE(metragem_mm, 0) / 1000.0 * largura_m
          + CASE
              WHEN upper(material) <> 'ARAMIDA' THEN 0
              WHEN upper(fornecedor) = 'COMTEC' THEN
                CASE
                  WHEN metragem_mm < 2490 THEN 0.0075
                  WHEN metragem_mm < 4980 THEN 0.0225
                  WHEN metragem_mm < 7470 THEN 0.0375
                  WHEN metragem_mm < 9690 THEN 0.0525
                  ELSE 0
                END
              ELSE
                CASE
                  WHEN metragem_mm < 2990  THEN 0.008
                  WHEN metragem_mm < 5980  THEN 0.024
                  WHEN metragem_mm < 8970  THEN 0.040
                  WHEN metragem_mm < 11960 THEN 0.056
                  WHEN metragem_mm < 14950 THEN 0.064
                  ELSE 0
                END
            END
        )::numeric, 3) AS m2_com_taxa
      FROM base
    )
  `;
}

// Query principal: linhas agregadas por OS. `camadas_m2` traz o m² da OS quebrado
// por camada (objeto JSON { "8": 1.5, "9": 10.469, ... }) — o front usa isso para
// montar as colunas dinâmicas "8C m²", "9C m²", etc.
function buildCuttingReportSql(whereConds) {
  return `
    ${cuttingReportCte(whereConds)},
    por_os_camada AS (
      SELECT
        os, descricao, lacre, material, data_producao,
        COALESCE(camadas, 'N/D') AS camada_key,
        SUM(m2_sem_taxa)         AS m2_camada
      FROM calc
      GROUP BY os, descricao, lacre, material, data_producao, COALESCE(camadas, 'N/D')
    )
    SELECT
      c.os,
      c.descricao,
      c.lacre,
      c.material,
      to_char(c.data_producao, 'DD/MM/YYYY') AS data_producao,
      STRING_AGG(DISTINCT c.fornecedor, ' | ' ORDER BY c.fornecedor) AS fornecedor,
      STRING_AGG(
        c.lote || ' - ' || c.m2_sem_taxa || ' - ' || c.camadas,
        '; '
        ORDER BY c.consumo_id
      ) AS lotes_m2,
      SUM(c.m2_sem_taxa) AS total_m2,
      SUM(c.m2_com_taxa) AS total_m2_com_taxa,
      (
        SELECT jsonb_object_agg(p.camada_key, p.m2_camada)
        FROM por_os_camada p
        WHERE p.os           IS NOT DISTINCT FROM c.os
          AND p.descricao    IS NOT DISTINCT FROM c.descricao
          AND p.lacre        IS NOT DISTINCT FROM c.lacre
          AND p.material     IS NOT DISTINCT FROM c.material
          AND p.data_producao IS NOT DISTINCT FROM c.data_producao
      ) AS camadas_m2
    FROM calc c
    GROUP BY
      c.os,
      c.descricao,
      c.lacre,
      c.material,
      c.data_producao
    ORDER BY
      c.os
  `;
}

// Resumo por camadas: camadas são extraídas dinamicamente dos consumos (não
// hardcoded), com a quantidade de consumos e o m² total de cada camada.
// Ordena numericamente quando a camada é número (8, 9, 11), demais ao final.
function buildCamadasSummarySql(whereConds) {
  return `
    ${cuttingReportCte(whereConds)}
    SELECT
      camadas,
      COUNT(*)          AS quantidade,
      SUM(m2_sem_taxa)  AS total_m2
    FROM calc
    GROUP BY camadas
    ORDER BY
      CASE WHEN camadas ~ '^[0-9]+$' THEN camadas::int ELSE 2147483647 END,
      camadas
  `;
}

// GET /cutting/relatorio-comtec — relatório de corte agregado por OS.
// Query params (todos opcionais):
//   startDate / endDate — YYYY-MM-DD, filtra production_date (inclusive).
//   suppliers           — lista CSV de fornecedores; vazio = todos.
//   lote                — filtra um lote (batch_number) específico.
// Retorna { success, data, resumoCamadas, camadas }; o front monta o Excel
// (aba DADOS com colunas dinâmicas de m² por camada + aba de resumo).
export const getComtecCuttingReport = async (req, res) => {
  try {
    const { startDate, endDate, suppliers, lote } = req.query;
    const params = [];
    const conds = [];

    const supplierList = suppliers
      ? String(suppliers).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (supplierList.length > 0) {
      params.push(supplierList.map((s) => s.toUpperCase()));
      conds.push(`upper(pc.supplier) = ANY($${params.length})`);
    }
    if (startDate) {
      params.push(startDate);
      conds.push(`cr.production_date::date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      conds.push(`cr.production_date::date <= $${params.length}`);
    }
    if (lote && String(lote).trim()) {
      params.push(String(lote).trim());
      conds.push(`upper(pc.batch_number) = upper($${params.length})`);
    }

    const [main, resumo] = await Promise.all([
      pool.query(buildCuttingReportSql(conds), params),
      pool.query(buildCamadasSummarySql(conds), params),
    ]);

    const data = main.rows.map((r) => ({
      os: r.os,
      descricao: r.descricao,
      lacre: r.lacre,
      material: r.material,
      dataProducao: r.data_producao,
      fornecedor: r.fornecedor,
      lotesM2: r.lotes_m2,
      totalM2: r.total_m2 == null ? 0 : Number(r.total_m2),
      totalM2ComTaxa: r.total_m2_com_taxa == null ? 0 : Number(r.total_m2_com_taxa),
      // { "8": 1.5, "9": 10.469, ... } → m² da OS por camada
      camadasM2: Object.fromEntries(
        Object.entries(r.camadas_m2 || {}).map(([k, v]) => [k, Number(v)]),
      ),
    }));

    const resumoCamadas = resumo.rows.map((r) => ({
      camadas: r.camadas == null ? 'N/D' : String(r.camadas),
      quantidade: Number(r.quantidade),
      totalM2: r.total_m2 == null ? 0 : Number(r.total_m2),
    }));

    // Lista ordenada de camadas distintas — define a ordem das colunas no Excel.
    const camadas = resumoCamadas.map((r) => r.camadas);

    return res.json({ success: true, data, resumoCamadas, camadas });
  } catch (error) {
    console.error('[Cutting] getComtecCuttingReport error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /cutting/relatorio-comtec/filters — opções para o popup de filtros do
// relatório: fornecedores distintos presentes nos consumos de placa.
export const getCuttingReportFilters = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT upper(supplier) AS supplier
         FROM public.plate_consumptions
        WHERE supplier IS NOT NULL AND btrim(supplier) <> ''
        ORDER BY 1`,
    );
    return res.json({ success: true, data: { suppliers: rows.map((r) => r.supplier) } });
  } catch (error) {
    console.error('[Cutting] getCuttingReportFilters error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /cutting/metadata — chaves espelham o JSON gerado pelo Spring após Jackson:
// os campos do DTO eram `Material`/`TensylonTypes`, mas Lombok+@Data publicava
// getters getMaterial()/getTensylonTypes(), o que serializa como
// material/tensylonTypes. Frontend usa metadata.material/.tensylonTypes.
export const getMetadata = (_req, res) => {
  return res.json({
    suppliers: SUPPLIERS,
    layers: LAYERS,
    kitType: KIT_TYPES,
    material: MATERIALS,
    tensylonTypes: TENSYLON_TYPES,
  });
};
