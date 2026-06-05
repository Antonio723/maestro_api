import pool from '../config/database.js';

// Código de rastreabilidade do material: 1 dígito (0-9) ou null para limpar.
// Aceita '', null e undefined como "não informado" (=> null).
function parseCodigoRastreabilidade(value, { max = 9 } = {}) {
  if (value === undefined) return undefined; // não mexe no campo
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new Error(`codigo_rastreabilidade inválido (use um inteiro entre 0 e ${max}).`);
  }
  return n;
}

const normalizeMeasureIds = (value) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((v) => Number(typeof v === 'object' ? v.id : v))
      .filter((v) => Number.isInteger(v) && v > 0),
  )];
};

async function replaceMaterialMeasures(client, materialId, measureIds) {
  await client.query('DELETE FROM maestro.material_measure_type_map WHERE material_id = $1', [materialId]);
  for (const measureId of measureIds) {
    await client.query(
      `INSERT INTO maestro.material_measure_type_map (material_id, measure_type_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [materialId, measureId],
    );
  }
}

// GET /api/materials?onlyActive=true
export const listarMateriais = async (req, res) => {
  try {
    const { onlyActive } = req.query;
    const where = String(onlyActive || '').toLowerCase() === 'true' ? 'WHERE m.ativo = true' : '';
    const result = await pool.query(`
      SELECT
        m.id,
        m.nome,
        m.tipo,
        m.codigo_rastreabilidade,
        m.ativo,
        m.created_at,
        m.updated_at,
        COALESCE(
          json_agg(
            json_build_object('id', mt.id, 'nome', mt.nome, 'unidade', mt.unidade, 'ativo', mt.ativo)
            ORDER BY mt.nome
          ) FILTER (WHERE mt.id IS NOT NULL),
          '[]'::json
        ) AS medidas,
        COALESCE((
          SELECT json_agg(
            json_build_object('id', mv.id, 'nome', mv.nome, 'ativo', mv.ativo)
            ORDER BY mv.nome
          )
          FROM maestro.material_variants mv
          WHERE mv.material_id = m.id
        ), '[]'::json) AS variacoes
      FROM maestro.materials m
      LEFT JOIN maestro.material_measure_type_map mm ON mm.material_id = m.id
      LEFT JOIN maestro.material_measure_types mt ON mt.id = mm.measure_type_id
      ${where}
      GROUP BY m.id
      ORDER BY m.nome ASC
    `);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erro ao listar materiais:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/materials
export const criarMaterial = async (req, res) => {
  const client = await pool.connect();
  try {
    const nome = String(req.body?.nome || '').trim();
    const medidaIds = normalizeMeasureIds(req.body?.medidas);
    const codigo = parseCodigoRastreabilidade(req.body?.codigo_rastreabilidade);

    if (!nome) {
      return res.status(400).json({ success: false, message: 'Nome é obrigatório.' });
    }

    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO maestro.materials (nome, tipo, codigo_rastreabilidade) VALUES ($1, NULL, $2)
       RETURNING id, nome, tipo, codigo_rastreabilidade, ativo, created_at, updated_at`,
      [nome, codigo === undefined ? null : codigo],
    );
    await replaceMaterialMeasures(client, result.rows[0].id, medidaIds);
    await client.query('COMMIT');
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (/codigo_rastreabilidade inválido/.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um material com esse nome.' });
    }
    console.error('Erro ao criar material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// PATCH /api/materials/:id
export const atualizarMaterial = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const fields = {};
    if (req.body?.nome !== undefined) fields.nome = String(req.body.nome).trim();
    if (req.body?.ativo !== undefined) fields.ativo = !!req.body.ativo;
    const codigo = parseCodigoRastreabilidade(req.body?.codigo_rastreabilidade);
    if (codigo !== undefined) fields.codigo_rastreabilidade = codigo;

    if (fields.nome === '') {
      return res.status(400).json({ success: false, message: 'Nome não pode ser vazio.' });
    }

    await client.query('BEGIN');

    let updated = null;
    if (Object.keys(fields).length > 0) {
      const keys = Object.keys(fields);
      const values = Object.values(fields);
      const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      values.push(id);

      const result = await client.query(
        `UPDATE maestro.materials
            SET ${setClauses}, updated_at = now()
          WHERE id = $${values.length}
          RETURNING id, nome, tipo, codigo_rastreabilidade, ativo, created_at, updated_at`,
        values,
      );
      updated = result.rows[0];
    } else {
      const result = await client.query(
        'SELECT id, nome, tipo, codigo_rastreabilidade, ativo, created_at, updated_at FROM maestro.materials WHERE id = $1',
        [id],
      );
      updated = result.rows[0];
    }

    if (!updated) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Material não encontrado.' });
    }

    if (req.body?.medidas !== undefined) {
      await replaceMaterialMeasures(client, id, normalizeMeasureIds(req.body.medidas));
    }

    await client.query('COMMIT');
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (/codigo_rastreabilidade inválido/.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um material com esse nome.' });
    }
    console.error('Erro ao atualizar material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  } finally {
    client.release();
  }
};

// DELETE /api/materials/:id
export const excluirMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM maestro.materials WHERE id = $1 RETURNING id',
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Material não encontrado.' });
    }
    return res.status(200).json({ success: true, message: 'Material excluído.' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        success: false,
        message: 'Material está em uso por certificados. Desative em vez de excluir.',
      });
    }
    console.error('Erro ao excluir material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const criarVariacaoMaterial = async (req, res) => {
  try {
    const materialId = Number(req.params.materialId);
    const nome = String(req.body?.nome || '').trim();
    if (!Number.isFinite(materialId)) return res.status(400).json({ success: false, message: 'Material inválido.' });
    if (!nome) return res.status(400).json({ success: false, message: 'Nome da variação é obrigatório.' });

    const result = await pool.query(
      `INSERT INTO maestro.material_variants (material_id, nome)
       VALUES ($1, $2)
       RETURNING id, material_id, nome, ativo, created_at, updated_at`,
      [materialId, nome],
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Já existe uma variação com esse nome para este material.' });
    if (error.code === '23503') return res.status(400).json({ success: false, message: 'Material inexistente.' });
    console.error('Erro ao criar variaÃ§Ã£o de material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const atualizarVariacaoMaterial = async (req, res) => {
  try {
    const materialId = Number(req.params.materialId);
    const variantId = Number(req.params.variantId);
    const fields = {};
    if (req.body?.nome !== undefined) fields.nome = String(req.body.nome).trim();
    if (req.body?.ativo !== undefined) fields.ativo = !!req.body.ativo;
    if (fields.nome === '') return res.status(400).json({ success: false, message: 'Nome da variação não pode ser vazio.' });
    if (!Number.isFinite(materialId) || !Number.isFinite(variantId)) return res.status(400).json({ success: false, message: 'Variação inválida.' });
    if (Object.keys(fields).length === 0) return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(materialId, variantId);

    const result = await pool.query(
      `UPDATE maestro.material_variants
          SET ${setClauses}, updated_at = now()
        WHERE material_id = $${values.length - 1} AND id = $${values.length}
        RETURNING id, material_id, nome, ativo, created_at, updated_at`,
      values,
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Variação não encontrada.' });
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Já existe uma variação com esse nome para este material.' });
    console.error('Erro ao atualizar variaÃ§Ã£o de material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const excluirVariacaoMaterial = async (req, res) => {
  try {
    const materialId = Number(req.params.materialId);
    const variantId = Number(req.params.variantId);
    const result = await pool.query(
      'DELETE FROM maestro.material_variants WHERE material_id = $1 AND id = $2 RETURNING id',
      [materialId, variantId],
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Variação não encontrada.' });
    return res.status(200).json({ success: true, message: 'Variação excluída.' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({ success: false, message: 'Variação está em uso por certificados. Desative em vez de excluir.' });
    }
    console.error('Erro ao excluir variaÃ§Ã£o de material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const listarTiposMedida = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nome, unidade, ativo, created_at, updated_at
      FROM maestro.material_measure_types
      ORDER BY nome ASC
    `);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erro ao listar tipos de medida:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

export const criarTipoMedida = async (req, res) => {
  try {
    const nome = String(req.body?.nome || '').trim();
    const unidade = req.body?.unidade ? String(req.body.unidade).trim() : null;
    if (!nome) return res.status(400).json({ success: false, message: 'Nome é obrigatório.' });

    const result = await pool.query(
      `INSERT INTO maestro.material_measure_types (nome, unidade)
       VALUES ($1, $2)
       RETURNING id, nome, unidade, ativo, created_at, updated_at`,
      [nome, unidade],
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe uma medida com esse nome.' });
    }
    console.error('Erro ao criar tipo de medida:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

