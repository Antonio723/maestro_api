import pool from '../config/database.js';

const TIPOS_VALIDOS = ['VIDRO', 'AÇO', 'MANTA', 'TENSYLON', 'SUP.VIDRO'];

function parseEspessura(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// GET /api/materials?onlyActive=true
export const listarMateriais = async (req, res) => {
  try {
    const { onlyActive } = req.query;
    const where = String(onlyActive || '').toLowerCase() === 'true' ? 'WHERE ativo = true' : '';
    const result = await pool.query(`
      SELECT id, nome, tipo, espessura_mm, descricao, ativo, created_at, updated_at
        FROM maestro.materials
        ${where}
       ORDER BY nome ASC
    `);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Erro ao listar materiais:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/materials
export const criarMaterial = async (req, res) => {
  try {
    const nome = String(req.body?.nome || '').trim();
    const tipo = req.body?.tipo ? String(req.body.tipo).toUpperCase().trim() : null;
    const espessura_mm = parseEspessura(req.body?.espessura_mm);
    const descricao = req.body?.descricao ? String(req.body.descricao).trim() : null;

    if (!nome) {
      return res.status(400).json({ success: false, message: 'Nome é obrigatório.' });
    }
    if (tipo && !TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({ success: false, message: `Tipo inválido. Use: ${TIPOS_VALIDOS.join(', ')}.` });
    }
    if (espessura_mm !== null && tipo !== 'AÇO') {
      return res.status(400).json({ success: false, message: 'Espessura só pode ser informada quando o tipo for AÇO.' });
    }

    const result = await pool.query(
      `INSERT INTO maestro.materials (nome, tipo, espessura_mm, descricao) VALUES ($1, $2, $3, $4)
         RETURNING id, nome, tipo, espessura_mm, descricao, ativo, created_at, updated_at`,
      [nome, tipo, espessura_mm, descricao]
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um material com esse nome.' });
    }
    console.error('❌ Erro ao criar material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/materials/:id
export const atualizarMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    const fields = {};
    if (req.body?.nome !== undefined) fields.nome = String(req.body.nome).trim();
    if (req.body?.tipo !== undefined) {
      fields.tipo = req.body.tipo === null || req.body.tipo === ''
        ? null
        : String(req.body.tipo).toUpperCase().trim();
    }
    if (req.body?.espessura_mm !== undefined) {
      fields.espessura_mm = parseEspessura(req.body.espessura_mm);
    }
    if (req.body?.descricao !== undefined) {
      fields.descricao = req.body.descricao === null || req.body.descricao === ''
        ? null
        : String(req.body.descricao).trim();
    }
    if (req.body?.ativo !== undefined) fields.ativo = !!req.body.ativo;

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }
    if (fields.nome === '') {
      return res.status(400).json({ success: false, message: 'Nome não pode ser vazio.' });
    }
    if (fields.tipo && !TIPOS_VALIDOS.includes(fields.tipo)) {
      return res.status(400).json({ success: false, message: `Tipo inválido. Use: ${TIPOS_VALIDOS.join(', ')}.` });
    }

    // Se mudou tipo p/ algo diferente de AÇO, zera espessura para não violar o CHECK.
    if (fields.tipo !== undefined && fields.tipo !== 'AÇO' && fields.espessura_mm === undefined) {
      fields.espessura_mm = null;
    }

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(id);

    const result = await pool.query(
      `UPDATE maestro.materials
          SET ${setClauses}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING id, nome, tipo, espessura_mm, descricao, ativo, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Material não encontrado.' });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um material com esse nome.' });
    }
    if (error.code === '23514') {
      return res.status(400).json({ success: false, message: 'Espessura só é permitida quando o tipo for AÇO.' });
    }
    console.error('❌ Erro ao atualizar material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// DELETE /api/materials/:id
export const excluirMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM maestro.materials WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Material não encontrado.' });
    }
    return res.status(200).json({ success: true, message: 'Material excluído.' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        success: false,
        message: 'Material está em uso por certificados — desative em vez de excluir.',
      });
    }
    console.error('❌ Erro ao excluir material:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
