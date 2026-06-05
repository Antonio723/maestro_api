import pool from '../config/database.js';

// Código de rastreabilidade do fornecedor: até 2 dígitos (0-99) ou null para limpar.
// Aceita '', null e undefined como "não informado".
function parseCodigoRastreabilidade(value) {
  if (value === undefined) return undefined; // não mexe no campo
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw new Error('codigo_rastreabilidade inválido (use um inteiro entre 0 e 99).');
  }
  return n;
}

// GET /api/fabric-suppliers
export const listarFornecedores = async (req, res) => {
  try {
    const { onlyActive } = req.query;
    const where = String(onlyActive || '').toLowerCase() === 'true' ? 'WHERE active = true' : '';
    const result = await pool.query(`
      SELECT id, name, codigo_rastreabilidade, active, created_at, updated_at
        FROM maestro.fabric_supplier
        ${where}
        ORDER BY name ASC
    `);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Erro ao listar fornecedores de tecido:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/fabric-suppliers
export const criarFornecedor = async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Nome é obrigatório.' });
    }
    const codigo = parseCodigoRastreabilidade(req.body?.codigo_rastreabilidade);
    const result = await pool.query(
      `INSERT INTO maestro.fabric_supplier (name, codigo_rastreabilidade)
         VALUES ($1, $2)
         RETURNING id, name, codigo_rastreabilidade, active, created_at, updated_at`,
      [name, codigo === undefined ? null : codigo]
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (/codigo_rastreabilidade inválido/.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um fornecedor de tecido com esse nome.' });
    }
    console.error('❌ Erro ao criar fornecedor de tecido:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// PATCH /api/fabric-suppliers/:id
export const atualizarFornecedor = async (req, res) => {
  try {
    const { id } = req.params;
    const fields = {};
    if (req.body?.name !== undefined) fields.name = String(req.body.name).trim();
    if (req.body?.active !== undefined) fields.active = !!req.body.active;
    const codigo = parseCodigoRastreabilidade(req.body?.codigo_rastreabilidade);
    if (codigo !== undefined) fields.codigo_rastreabilidade = codigo;

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar.' });
    }
    if (fields.name === '') {
      return res.status(400).json({ success: false, message: 'Nome não pode ser vazio.' });
    }

    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(id);

    const result = await pool.query(
      `UPDATE maestro.fabric_supplier
          SET ${setClauses}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING id, name, codigo_rastreabilidade, active, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fornecedor de tecido não encontrado.' });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (/codigo_rastreabilidade inválido/.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um fornecedor de tecido com esse nome.' });
    }
    console.error('❌ Erro ao atualizar fornecedor de tecido:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// DELETE /api/fabric-suppliers/:id
export const excluirFornecedor = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM maestro.fabric_supplier WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fornecedor de tecido não encontrado.' });
    }
    return res.status(200).json({ success: true, message: 'Fornecedor de tecido excluído.' });
  } catch (error) {
    console.error('❌ Erro ao excluir fornecedor de tecido:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
