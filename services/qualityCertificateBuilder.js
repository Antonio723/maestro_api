import pool from '../config/database.js';

// Helpers para o fluxo "gerar certificado de qualidade a partir do registro de
// corte" (POST /api/quality/from-cutting). Centraliza a resolução dos campos
// que dependem de tabelas externas (jira_cards, project, placas, conformity)
// para que o controller fique só com orquestração.

const ARAMIDA_LAYER_KEYS = { '8': '8C', '9': '9C', '11': '11C' };

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Soma os m² por camada usando o cutting_plans do projeto do Jira. Retorna
// { total, perLayer, warnings, project }. Se o projeto não existir no DB
// (cutting_plan ausente), perLayer fica vazio — caller decide se isso é
// fatal ou só warning.
export async function resolveMetragemFromMirror(jiraCard, cuttingRecord, client = pool) {
  const warnings = [];

  if (!jiraCard || !jiraCard.project) {
    warnings.push('Card Jira sem numeroProjeto — metragem não pôde ser resolvida via espelho.');
    return { total: 0, perLayer: {}, warnings, project: null };
  }

  const projectCode = sanitizeText(jiraCard.project).toUpperCase();
  const { rows } = await client.query(
    `
      SELECT
        p.id, p.project, p.material_type,
        COALESCE(json_agg(json_build_object(
          'square_meters', cp.square_meters
        )) FILTER (WHERE cp.id IS NOT NULL), '[]'::json) AS plans
      FROM maestro.project p
      LEFT JOIN maestro.cutting_plan cp ON cp.project_id = p.id
      WHERE UPPER(p.project) = $1
      GROUP BY p.id
      LIMIT 1
    `,
    [projectCode],
  );

  if (rows.length === 0) {
    warnings.push(`Projeto "${projectCode}" não encontrado no espelho — metragem não foi pré-preenchida.`);
    return { total: 0, perLayer: {}, warnings, project: null };
  }

  const project = rows[0];
  const isTensylon = String(project.material_type || '').toUpperCase() === 'TENSYLON';

  // Agrega: primeira ocorrência não vazia vence (igual mirrorsController e
  // appendFirstPage). Evita duplicar quando há vários cutting_plans no mesmo
  // projeto/dimensão.
  const perLayer = {};
  for (const plan of project.plans || []) {
    for (const [key, value] of Object.entries(plan.square_meters || {})) {
      if (perLayer[key] !== undefined) continue;
      const n = parseNumber(value);
      if (n !== null && n > 0) perLayer[key] = n;
    }
  }

  if (isTensylon) {
    if (perLayer.tensylon == null) {
      warnings.push('Projeto Tensylon sem m² preenchido em cutting_plan.tensylon.');
    }
  } else {
    // Para Aramida, só interessam as camadas realmente consumidas no corte.
    const camadasUsadas = new Set(
      (cuttingRecord.consumptions || [])
        .map((c) => String(c.layerQuantity || c.layer_quantity || '').trim())
        .map((l) => ARAMIDA_LAYER_KEYS[l] || null)
        .filter(Boolean),
    );
    for (const key of Object.keys(perLayer)) {
      if (key !== 'tensylon' && !camadasUsadas.has(key)) delete perLayer[key];
    }
    if (camadasUsadas.size > 0 && Object.keys(perLayer).length === 0) {
      warnings.push(`Projeto não tem m² para as camadas usadas no corte (${[...camadasUsadas].join(', ')}).`);
    }
  }

  const total = Object.values(perLayer).reduce((s, v) => s + (Number(v) || 0), 0);
  return { total, perLayer, warnings, project };
}

// Extrai a variante de Tensylon a partir do material do cutting_record:
//   TENSYLON_30A -> "30A" | TENSYLON_40A -> "40A" | qualquer outro -> null
function extractTensylonVariant(material) {
  const m = String(material || '').toUpperCase();
  if (!m.startsWith('TENSYLON')) return null;
  const parts = m.split('_');
  return parts[1] || null;
}

// Resolve os certificados de conformidade a partir das placas usadas no corte.
// Caminho:
//   1. consumo com plate_id  -> placa -> workorder.fabric_supplier -> cert
//      filtrado por (fabric_supplier_id + quantidade_camadas [+ variant Tensylon]).
//   2. consumo externo (sem plate_id) -> cai no padrão antigo (supplier + camadas)
//      pra não perder os recebimentos de painel.
// Agrega `numero` únicos preservando ordem de descoberta.
export async function resolveConformityCertsFromPlates(cuttingRecord, client = pool) {
  const warnings = [];
  const seen = new Set();
  const numeros = [];
  const perCert = [];
  const fabricSuppliers = new Set();

  const consumptions = cuttingRecord.consumptions || [];
  if (consumptions.length === 0) {
    warnings.push('Corte sem consumos — nenhum cert. de conformidade resolvido.');
    return { numeros, perCert, warnings, fabricSuppliers: [] };
  }

  const variantName = extractTensylonVariant(cuttingRecord.material);
  let variantId = null;
  if (variantName) {
    const variantRow = await client.query(
      `SELECT mv.id
         FROM maestro.material_variants mv
         JOIN maestro.materials m ON m.id = mv.material_id
        WHERE UPPER(m.nome) = 'TENSYLON'
          AND UPPER(mv.nome) = UPPER($1)
          AND mv.ativo = true
        LIMIT 1`,
      [variantName],
    );
    if (variantRow.rows[0]) {
      variantId = variantRow.rows[0].id;
    } else {
      warnings.push(`Variante Tensylon "${variantName}" não cadastrada em maestro.material_variants — busca de cert ficará sem filtro de variante.`);
    }
  }

  for (const c of consumptions) {
    const camadas = parseNumber(c.layerQuantity || c.layer_quantity);
    if (!camadas) {
      warnings.push(`Consumo sem camadas válidas (layerQuantity="${c.layerQuantity ?? c.layer_quantity}").`);
      continue;
    }

    // Resolve o nome do fornecedor de tecido a usar como filtro.
    let supplierName = null;
    const plateId = c.plateId ?? c.plate_id;
    if (plateId) {
      const { rows: plateRows } = await client.query(
        `SELECT wo.fabric_supplier
           FROM public.plates p
           LEFT JOIN public.workorder_table wo ON wo.id = p.workorderid
          WHERE p.id = $1`,
        [plateId],
      );
      supplierName = sanitizeText(plateRows[0]?.fabric_supplier);
      if (!supplierName) {
        warnings.push(`Placa ${plateId} sem fabric_supplier no workorder — cert. de conformidade não pôde ser resolvido por esta placa.`);
      }
    } else {
      // Consumo externo (panel_receipt). Mantém comportamento atual: usa o
      // supplier do consumo como nome do fornecedor de tecido (mesma string).
      supplierName = sanitizeText(c.supplier);
    }

    if (!supplierName) continue;
    fabricSuppliers.add(supplierName);

    const dedupeKey = `${supplierName}|${camadas}|${variantId || ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const params = [supplierName, camadas];
    let variantFilter = '';
    if (variantId !== null) {
      params.push(variantId);
      variantFilter = `AND cc.material_variant_id = $${params.length}`;
    }

    const { rows: certRows } = await client.query(
      `SELECT cc.numero
         FROM maestro.conformity_certificates cc
         JOIN maestro.fabric_supplier fs ON fs.id = cc.fabric_supplier_id
        WHERE UPPER(fs.name) = UPPER($1)
          AND cc.quantidade_camadas = $2
          ${variantFilter}
          AND cc.ativo = true
        ORDER BY cc.created_at DESC
        LIMIT 1`,
      params,
    );

    if (certRows.length === 0) {
      const variantSuffix = variantName ? ` + variante ${variantName}` : '';
      warnings.push(`Nenhum cert. de conformidade ativo para "${supplierName}" + ${camadas} camadas${variantSuffix}.`);
      continue;
    }
    numeros.push(certRows[0].numero);
    perCert.push({
      numero: certRows[0].numero,
      supplier: supplierName,
      camadas,
      variantName,
    });
  }

  return { numeros, perCert, warnings, fabricSuppliers: [...fabricSuppliers] };
}

// Resolve a conformidade para cortes de TENSYLON, que não têm placa nem camadas
// (fluxo de enfesto próprio — ver tensylonEnfestoController). INTERIM: por
// decisão de negócio, todo certificado de Tensylon usa o cert. de conformidade
// ativo da variante 30A, independentemente da variante real do corte
// (TENSYLON_30A/40A). O fornecedor de tecido vem desse mesmo cert.
// TODO(revisão): casar pela variante real e/ou pelo public.tensylon_enfesto (OS).
// Retorna o mesmo shape de resolveConformityCertsFromPlates.
export async function resolveTensylonConformity(cuttingRecord, client = pool) {
  const warnings = [];
  const { rows } = await client.query(
    `SELECT cc.numero, fs.name AS fabric_supplier
       FROM maestro.conformity_certificates cc
       JOIN maestro.materials m ON m.id = cc.material_id
       JOIN maestro.material_variants mv ON mv.id = cc.material_variant_id
       LEFT JOIN maestro.fabric_supplier fs ON fs.id = cc.fabric_supplier_id
      WHERE UPPER(m.nome) = 'TENSYLON'
        AND UPPER(mv.nome) = '30A'
        AND cc.ativo = true
      ORDER BY cc.created_at DESC
      LIMIT 1`,
  );

  if (rows.length === 0) {
    warnings.push('Nenhum cert. de conformidade ativo do Tensylon 30A cadastrado — certificado sairá sem conformidade.');
    return { numeros: [], perCert: [], warnings, fabricSuppliers: [] };
  }

  const { numero, fabric_supplier: supplier } = rows[0];
  const supplierName = sanitizeText(supplier);
  return {
    numeros: [numero],
    perCert: [{ numero, supplier: supplierName, camadas: null, variantName: '30A' }],
    warnings,
    fabricSuppliers: supplierName ? [supplierName] : [],
  };
}

// Resolve o m² do cutting_plan.square_meters para a camada de um cert. de
// conformidade resolvido. Aramida → chave por camadas (ARAMIDA_LAYER_KEYS);
// Tensylon → chave fixa "tensylon". Retorna null se não encontrar (caller
// decide se vira string vazia ou warning).
export function getSquareMetersForCert(certInfo, perLayer, material) {
  if (!perLayer || !certInfo) return null;
  const isTensylon = String(material || '').toUpperCase().startsWith('TENSYLON');
  if (isTensylon) {
    return parseNumber(perLayer.tensylon);
  }
  const key = ARAMIDA_LAYER_KEYS[String(certInfo.camadas)];
  if (!key) return null;
  return parseNumber(perLayer[key]);
}

// Gera o próximo número de certificado de qualidade no padrão CQ-YYYY-NNNNNN.
// Sequencial anual. Idempotente em concorrência via UNIQUE(numero) — caso de
// race, o INSERT do controller pega 23505 e o caller retry'a com próximo seq.
export async function gerarProximoNumero(client = pool) {
  const year = new Date().getFullYear();
  const prefix = `CQ-${year}-`;
  const { rows } = await client.query(
    `
      SELECT COALESCE(
        MAX(NULLIF(regexp_replace(numero, '^' || $1 || '(\\d{6})$', '\\1'), numero)::int),
        0
      ) + 1 AS next_seq
      FROM maestro.quality_certificates
      WHERE numero LIKE $2
    `,
    [prefix, `${prefix}______`],
  );
  const seq = String(rows[0].next_seq).padStart(6, '0');
  return `${prefix}${seq}`;
}
