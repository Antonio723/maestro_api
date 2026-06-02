import pool from '../config/database.js';
import { findTensylonCardByOs } from '../services/jiraCardLookup.js';

// Controle de ENFESTO do Tensylon. Módulo próprio: o fluxo difere da aramida
// (enfesto -> corte -> bolsa de vácuo -> autoclave -> kit) e os dados coletados
// também (sem placas/camadas/plástico). Grava em public.tensylon_enfesto +
// public.tensylon_enfesto_lote (1 enfesto -> N lotes de material).

const ENFESTO_COLUMNS = `
  e.id,
  to_char(e.enfesto_date, 'YYYY-MM-DD') AS "enfestoDate",
  e.order_number          AS "orderNumber",
  e.jira_key              AS "jiraKey",
  e.material_variant_id   AS "materialVariantId",
  e.material_variant_nome AS "materialVariantNome",
  e.fornecedor,
  e.comprimento,
  e.lote_impresso         AS "loteImpresso",
  e.creation_date         AS "creationDate",
  e.change_date           AS "changeDate"
`;

// Lotes da filha como json_agg — mantém o mesmo formato em list/getById.
const LOTES_SUBQUERY = `
  COALESCE((
    SELECT json_agg(json_build_object('id', l.id, 'lote', l.lote) ORDER BY l.id ASC)
      FROM public.tensylon_enfesto_lote l
     WHERE l.enfesto_id = e.id
  ), '[]'::json)
`;

function parseDate(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function parseComprimento(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('comprimento inválido (deve ser maior que zero).');
  }
  return n;
}

// Normaliza a lista de lotes: aceita ['A','B'] ou [{lote:'A'}], remove vazios/dups.
function normalizeLotes(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const lote = String(typeof item === 'object' && item !== null ? item.lote : item || '').trim();
    if (lote && !seen.has(lote)) {
      seen.add(lote);
      out.push(lote);
    }
  }
  return out;
}

function mapEnfesto(row) {
  return {
    ...row,
    id: Number(row.id),
    materialVariantId: row.materialVariantId === null ? null : Number(row.materialVariantId),
    comprimento: row.comprimento === null ? null : Number(row.comprimento),
    lotes: Array.isArray(row.lotes) ? row.lotes.map((l) => ({ id: Number(l.id), lote: l.lote })) : [],
  };
}

async function fetchEnfestoById(client, id) {
  const { rows } = await client.query(
    `SELECT ${ENFESTO_COLUMNS}, ${LOTES_SUBQUERY} AS lotes
       FROM public.tensylon_enfesto e
      WHERE e.id = $1`,
    [id],
  );
  return rows[0] ? mapEnfesto(rows[0]) : null;
}

// Agrupa por data (mais recente primeiro), espelhando o enfesto da aramida.
async function listGroupedWhere(whereSql = '', params = []) {
  const { rows } = await pool.query(
    `
      SELECT
        to_char(e.enfesto_date, 'YYYY-MM-DD') AS "enfestoDate",
        COUNT(*)::int AS "totalEnfestos",
        json_agg(
          json_build_object(
            'id', e.id,
            'enfestoDate', to_char(e.enfesto_date, 'YYYY-MM-DD'),
            'orderNumber', e.order_number,
            'jiraKey', e.jira_key,
            'materialVariantId', e.material_variant_id,
            'materialVariantNome', e.material_variant_nome,
            'fornecedor', e.fornecedor,
            'comprimento', e.comprimento,
            'loteImpresso', e.lote_impresso,
            'creationDate', e.creation_date,
            'changeDate', e.change_date,
            'lotes', ${LOTES_SUBQUERY}
          )
          ORDER BY e.id DESC
        ) AS "enfestos"
      FROM public.tensylon_enfesto e
      ${whereSql}
      GROUP BY e.enfesto_date
      ORDER BY e.enfesto_date DESC
    `,
    params,
  );

  return rows.map((row) => ({
    enfestoDate: row.enfestoDate,
    totalEnfestos: Number(row.totalEnfestos),
    enfestos: (row.enfestos || []).map(mapEnfesto),
  }));
}

// GET /api/tensylon-enfesto?start=&end=
export const listGrouped = async (req, res) => {
  const start = parseDate(req.query.start);
  const end = parseDate(req.query.end);
  try {
    let data;
    if (start && end) {
      data = await listGroupedWhere(
        'WHERE e.enfesto_date::date BETWEEN $1::date AND $2::date',
        [start, end],
      );
    } else {
      data = await listGroupedWhere();
    }
    return res.json(data);
  } catch (error) {
    console.error('[TensylonEnfesto] listGrouped error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/tensylon-enfesto/:id
export const getById = async (req, res) => {
  try {
    const item = await fetchEnfestoById(pool, Number(req.params.id));
    if (!item) {
      return res.status(404).json({ success: false, message: 'Enfesto não encontrado.' });
    }
    return res.json(item);
  } catch (error) {
    console.error('[TensylonEnfesto] getById error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/tensylon-enfesto
export const create = async (req, res) => {
  const client = await pool.connect();
  try {
    const enfestoDate = parseDate(req.body?.enfestoDate);
    if (!enfestoDate) {
      return res.status(400).json({ success: false, message: 'enfestoDate é obrigatório.' });
    }
    const comprimento = parseComprimento(req.body?.comprimento);
    const lotes = normalizeLotes(req.body?.lotes);
    if (lotes.length === 0) {
      return res.status(400).json({ success: false, message: 'Informe ao menos um lote de material.' });
    }

    const orderNumber = req.body?.orderNumber ? String(req.body.orderNumber).trim() : null;
    const materialVariantId = req.body?.materialVariantId ? Number(req.body.materialVariantId) : null;
    const materialVariantNome = req.body?.materialVariantNome
      ? String(req.body.materialVariantNome).trim()
      : null;
    const fornecedor = req.body?.fornecedor ? String(req.body.fornecedor).trim() : null;
    const loteImpresso = req.body?.loteImpresso ? String(req.body.loteImpresso).trim() : null;

    // Congela o card Jira do board TENSYLON no momento do cadastro. NULL é válido
    // (OS sem card sincronizado).
    let jiraKey = null;
    if (orderNumber) {
      const card = await findTensylonCardByOs(orderNumber, client);
      jiraKey = card?.key || null;
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `
        INSERT INTO public.tensylon_enfesto
          (enfesto_date, order_number, jira_key, material_variant_id,
           material_variant_nome, fornecedor, comprimento, lote_impresso)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `,
      [enfestoDate, orderNumber, jiraKey, materialVariantId, materialVariantNome, fornecedor, comprimento, loteImpresso],
    );
    const enfestoId = rows[0].id;

    for (const lote of lotes) {
      await client.query(
        'INSERT INTO public.tensylon_enfesto_lote (enfesto_id, lote) VALUES ($1, $2)',
        [enfestoId, lote],
      );
    }

    const created = await fetchEnfestoById(client, enfestoId);
    await client.query('COMMIT');
    return res.status(201).json(created);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[TensylonEnfesto] create error:', error);
    return res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// PUT /api/tensylon-enfesto/:id
export const update = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const enfestoDate = parseDate(req.body?.enfestoDate);
    if (!enfestoDate) {
      return res.status(400).json({ success: false, message: 'enfestoDate é obrigatório.' });
    }
    const comprimento = parseComprimento(req.body?.comprimento);
    const lotes = normalizeLotes(req.body?.lotes);
    if (lotes.length === 0) {
      return res.status(400).json({ success: false, message: 'Informe ao menos um lote de material.' });
    }

    const orderNumber = req.body?.orderNumber ? String(req.body.orderNumber).trim() : null;
    const materialVariantId = req.body?.materialVariantId ? Number(req.body.materialVariantId) : null;
    const materialVariantNome = req.body?.materialVariantNome
      ? String(req.body.materialVariantNome).trim()
      : null;
    const fornecedor = req.body?.fornecedor ? String(req.body.fornecedor).trim() : null;
    const loteImpresso = req.body?.loteImpresso ? String(req.body.loteImpresso).trim() : null;

    await client.query('BEGIN');
    const current = await client.query(
      'SELECT order_number, jira_key FROM public.tensylon_enfesto WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Enfesto não encontrado.' });
    }

    // Re-resolve o jira_key apenas se a OS mudou; senão preserva o congelado.
    let jiraKey = current.rows[0].jira_key;
    if (orderNumber !== (current.rows[0].order_number || null)) {
      jiraKey = null;
      if (orderNumber) {
        const card = await findTensylonCardByOs(orderNumber, client);
        jiraKey = card?.key || null;
      }
    }

    await client.query(
      `
        UPDATE public.tensylon_enfesto
           SET enfesto_date = $1,
               order_number = $2,
               jira_key = $3,
               material_variant_id = $4,
               material_variant_nome = $5,
               fornecedor = $6,
               comprimento = $7,
               lote_impresso = $8,
               change_date = now()
         WHERE id = $9
      `,
      [enfestoDate, orderNumber, jiraKey, materialVariantId, materialVariantNome, fornecedor, comprimento, loteImpresso, id],
    );

    // Substitui os lotes (DELETE + INSERT) dentro da transação.
    await client.query('DELETE FROM public.tensylon_enfesto_lote WHERE enfesto_id = $1', [id]);
    for (const lote of lotes) {
      await client.query(
        'INSERT INTO public.tensylon_enfesto_lote (enfesto_id, lote) VALUES ($1, $2)',
        [id, lote],
      );
    }

    const updated = await fetchEnfestoById(client, id);
    await client.query('COMMIT');
    return res.json(updated);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[TensylonEnfesto] update error:', error);
    return res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// DELETE /api/tensylon-enfesto/:id
export const remove = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'id inválido.' });
    }
    const result = await pool.query(
      'DELETE FROM public.tensylon_enfesto WHERE id = $1 RETURNING id',
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Enfesto não encontrado.' });
    }
    return res.json({ success: true, message: 'Enfesto excluído.' });
  } catch (error) {
    console.error('[TensylonEnfesto] remove error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/tensylon-enfesto/jira-lookup?os=
// Preview do card Jira (board TENSYLON) a partir da OS, usado na tela de cadastro.
export const jiraLookup = async (req, res) => {
  try {
    const os = String(req.query.os || '').trim();
    if (!os) {
      return res.status(400).json({ success: false, message: 'Parâmetro os é obrigatório.' });
    }
    const card = await findTensylonCardByOs(os);
    return res.json({
      success: true,
      data: card
        ? { key: card.key, veiculo: card.veiculo, resumo: card.resumo }
        : null,
    });
  } catch (error) {
    console.error('[TensylonEnfesto] jiraLookup error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/tensylon-enfesto/material-options
// Opções de "material" do enfesto = combinações (variação + fornecedor) que
// existem nos certificados de conformidade de Tensylon emitidos. É a fonte do
// dropdown de Material — todo certificado Tensylon tem variação e fornecedor.
export const materialOptions = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
        SELECT DISTINCT
          c.material_variant_id AS "materialVariantId",
          mv.nome               AS "variantNome",
          c.fabric_supplier_id  AS "fabricSupplierId",
          fs.name               AS "fornecedor"
          FROM maestro.conformity_certificates c
          JOIN maestro.materials m               ON m.id = c.material_id
          LEFT JOIN maestro.material_variants mv ON mv.id = c.material_variant_id
          LEFT JOIN maestro.fabric_supplier fs   ON fs.id = c.fabric_supplier_id
         WHERE m.nome ILIKE '%tensylon%'
         ORDER BY "variantNome", "fornecedor"
      `,
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[TensylonEnfesto] materialOptions error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/tensylon-enfesto/lotes-impressos?materialVariantId=&fabricSupplierId=
// Códigos de rastreabilidade (M0…) p/ o dropdown digitável, filtrados pelos
// certificados de conformidade da variação (+ fornecedor) selecionada.
export const lotesImpressos = async (req, res) => {
  try {
    const materialVariantId = req.query.materialVariantId
      ? Number(req.query.materialVariantId)
      : null;
    const fabricSupplierId = req.query.fabricSupplierId
      ? Number(req.query.fabricSupplierId)
      : null;

    if (!Number.isFinite(materialVariantId) || materialVariantId <= 0) {
      return res.json({ success: true, data: [] });
    }

    const { rows } = await pool.query(
      `
        SELECT DISTINCT r.codigo_rastreabilidade AS codigo
          FROM maestro.rastreabilidades r
          JOIN maestro.conformity_certificates c ON c.id = r.certificate_id
         WHERE c.material_variant_id = $1
           AND ($2::int IS NULL OR c.fabric_supplier_id = $2)
           AND r.codigo_rastreabilidade IS NOT NULL
         ORDER BY r.codigo_rastreabilidade DESC
         LIMIT 500
      `,
      [materialVariantId, Number.isFinite(fabricSupplierId) ? fabricSupplierId : null],
    );
    return res.json({ success: true, data: rows.map((r) => r.codigo) });
  } catch (error) {
    console.error('[TensylonEnfesto] lotesImpressos error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
