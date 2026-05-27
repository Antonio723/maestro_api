import pool from '../config/database.js';

const SELECT_FIELDS = `
  c.id,
  c.numero,
  c.nome_comercial,
  c.material_id,
  m.nome AS material_nome,
  m.tipo AS material_tipo,
  c.quantidade_camadas,
  c.espessura_mm,
  c.medidas,
  c.descricao,
  c.ativo,
  c.created_by,
  c.created_at,
  c.updated_at
`;

function parsePositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadMaterialMeasures(materialId) {
  const result = await pool.query(
    `SELECT mt.id, mt.nome, mt.unidade
       FROM maestro.material_measure_type_map mm
       JOIN maestro.material_measure_types mt ON mt.id = mm.measure_type_id
      WHERE mm.material_id = $1 AND mt.ativo = true
      ORDER BY mt.nome`,
    [materialId],
  );
  return result.rows;
}

function normalizeMedidas(raw, measureDefs) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const allowed = new Set(measureDefs.map((m) => String(m.id)));
  const medidas = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(String(key))) continue;
    const n = parsePositiveNumber(value);
    if (n !== null) medidas[String(key)] = n;
  }
  return medidas;
}

function legacyFromMedidas(medidas, measureDefs) {
  let quantidade_camadas = null;
  let espessura_mm = null;
  for (const def of measureDefs) {
    const value = medidas[String(def.id)];
    if (value == null) continue;
    const name = String(def.nome || '').toLowerCase();
    if (name.includes('camada')) quantidade_camadas = Number(value);
    if (name.includes('espessura')) espessura_mm = Number(value);
  }
  return { quantidade_camadas, espessura_mm };
}

async function getFullCertificate(id) {
  const full = await pool.query(
    `SELECT ${SELECT_FIELDS}
       FROM maestro.conformity_certificates c
       JOIN maestro.materials m ON m.id = c.material_id
      WHERE c.id = $1`,
    [id],
  );
  return full.rows[0];
}

export const listarCertificados = async (req, res) => {
  try {
    const { onlyActive } = req.query;
    const where = String(onlyActive || '').toLowerCase() === 'true' ? 'WHERE c.ativo = true' : '';
    const result = await pool.query(`
      SELECT ${SELECT_FIELDS}
        FROM maestro.conformity_certificates c
        JOIN maestro.materials m ON m.id = c.material_id
        ${where}
       ORDER BY c.numero DESC
    `);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erro ao listar certificados de conformidade:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const obterCertificado = async (req, res) => {
  try {
    const cert = await getFullCertificate(req.params.id);
    if (!cert) return res.status(404).json({ success: false, message: 'Certificado não encontrado.' });
    return res.status(200).json({ success: true, data: cert });
  } catch (error) {
    console.error('Erro ao obter certificado:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const criarCertificado = async (req, res) => {
  try {
    const numero = String(req.body?.numero || '').trim();
    const nome_comercial = String(req.body?.nome_comercial || '').trim();
    const material_id = Number(req.body?.material_id);
    const descricao = req.body?.descricao ? String(req.body.descricao).trim() : null;

    const missing = [];
    if (!numero) missing.push('numero');
    if (!nome_comercial) missing.push('nome_comercial');
    if (!Number.isFinite(material_id)) missing.push('material_id');
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Campos obrigatórios faltando ou inválidos: ${missing.join(', ')}`,
      });
    }

    const measureDefs = await loadMaterialMeasures(material_id);
    const medidas = normalizeMedidas(req.body?.medidas, measureDefs);
    const legacy = legacyFromMedidas(medidas, measureDefs);

    const inserted = await pool.query(
      `INSERT INTO maestro.conformity_certificates
         (numero, nome_comercial, material_id, quantidade_camadas, espessura_mm, medidas, descricao, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        numero,
        nome_comercial,
        material_id,
        legacy.quantidade_camadas,
        legacy.espessura_mm,
        JSON.stringify(medidas),
        descricao,
        req.user?.id || null,
      ],
    );

    return res.status(201).json({ success: true, data: await getFullCertificate(inserted.rows[0].id) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Já existe um certificado com esse número.' });
    if (error.code === '23503') return res.status(400).json({ success: false, message: 'Material inexistente.' });
    console.error('Erro ao criar certificado de conformidade:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const atualizarCertificado = async (req, res) => {
  try {
    const { id } = req.params;
    const fields = {};
    if (req.body?.numero !== undefined) fields.numero = String(req.body.numero).trim();
    if (req.body?.nome_comercial !== undefined) fields.nome_comercial = String(req.body.nome_comercial).trim();
    if (req.body?.material_id !== undefined) fields.material_id = Number(req.body.material_id);
    if (req.body?.descricao !== undefined) fields.descricao = req.body.descricao === null || req.body.descricao === ''
      ? null
      : String(req.body.descricao).trim();
    if (req.body?.ativo !== undefined) fields.ativo = !!req.body.ativo;

    if (fields.numero === '' || fields.nome_comercial === '') {
      return res.status(400).json({ success: false, message: 'Número e nome comercial não podem ser vazios.' });
    }

    if (req.body?.medidas !== undefined || fields.material_id !== undefined) {
      const current = await pool.query(
        'SELECT material_id FROM maestro.conformity_certificates WHERE id = $1',
        [id],
      );
      const materialId = fields.material_id || current.rows[0]?.material_id;
      const measureDefs = await loadMaterialMeasures(materialId);
      const medidas = normalizeMedidas(req.body?.medidas, measureDefs);
      const legacy = legacyFromMedidas(medidas, measureDefs);
      fields.medidas = JSON.stringify(medidas);
      fields.quantidade_camadas = legacy.quantidade_camadas;
      fields.espessura_mm = legacy.espessura_mm;
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(id);

    const updated = await pool.query(
      `UPDATE maestro.conformity_certificates
          SET ${setClauses}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING id`,
      values,
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Certificado não encontrado.' });
    }
    return res.status(200).json({ success: true, data: await getFullCertificate(id) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Já existe um certificado com esse número.' });
    if (error.code === '23503') return res.status(400).json({ success: false, message: 'Material inexistente.' });
    console.error('Erro ao atualizar certificado de conformidade:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const excluirCertificado = async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM maestro.conformity_certificates WHERE id = $1 RETURNING id',
      [req.params.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Certificado não encontrado.' });
    }
    return res.status(200).json({ success: true, message: 'Certificado excluído.' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        success: false,
        message: 'Certificado está em uso por rastreabilidades. Desative em vez de excluir.',
      });
    }
    console.error('Erro ao excluir certificado:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
