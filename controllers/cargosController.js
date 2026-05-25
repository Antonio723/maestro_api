import { query } from '../config/database.js';

const NAME_MIN = 2;
const NAME_MAX = 120;

const validNome = (s) => typeof s === 'string'
  && s.trim().length >= NAME_MIN
  && s.trim().length <= NAME_MAX;

export const listCargos = async (_req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.nome, c.created_at, c.updated_at,
              COUNT(u.id)::int AS usuarios_count
       FROM maestro.cargos c
       LEFT JOIN maestro.users u ON u.cargo_id = c.id AND u.deleted_at IS NULL
       GROUP BY c.id
       ORDER BY c.nome`,
    );
    res.json({ success: true, data: { cargos: result.rows } });
  } catch (error) {
    console.error('listCargos error:', error);
    res.status(500).json({ success: false });
  }
};

export const createCargo = async (req, res) => {
  try {
    const nome = req.body?.nome?.trim();
    if (!validNome(nome)) {
      return res.status(400).json({
        success: false,
        message: `Nome do cargo deve ter ${NAME_MIN}-${NAME_MAX} caracteres.`,
      });
    }

    const exists = await query(
      'SELECT id FROM maestro.cargos WHERE lower(nome) = lower($1)',
      [nome],
    );
    if (exists.rows.length) {
      return res.status(400).json({ success: false, message: 'Cargo já cadastrado.' });
    }

    const result = await query(
      `INSERT INTO maestro.cargos (nome) VALUES ($1)
       RETURNING id, nome, created_at, updated_at`,
      [nome],
    );
    res.status(201).json({ success: true, data: { cargo: result.rows[0] } });
  } catch (error) {
    console.error('createCargo error:', error);
    res.status(500).json({ success: false });
  }
};

export const updateCargo = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const nome = req.body?.nome?.trim();
    if (!validNome(nome)) {
      return res.status(400).json({
        success: false,
        message: `Nome do cargo deve ter ${NAME_MIN}-${NAME_MAX} caracteres.`,
      });
    }

    const conflict = await query(
      'SELECT id FROM maestro.cargos WHERE lower(nome) = lower($1) AND id <> $2',
      [nome, id],
    );
    if (conflict.rows.length) {
      return res.status(400).json({ success: false, message: 'Outro cargo já usa esse nome.' });
    }

    const result = await query(
      `UPDATE maestro.cargos
       SET nome = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, nome, created_at, updated_at`,
      [nome, id],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Cargo não encontrado.' });
    }
    res.json({ success: true, data: { cargo: result.rows[0] } });
  } catch (error) {
    console.error('updateCargo error:', error);
    res.status(500).json({ success: false });
  }
};

export const deleteCargo = async (req, res) => {
  try {
    const id = Number(req.params.id);

    // FK ON DELETE SET NULL em users.cargo_id já cuida do reset automático.
    // Aqui retornamos quantos usuários ficaram desvinculados, para o front
    // poder confirmar com o admin antes / mostrar feedback.
    const usage = await query(
      'SELECT COUNT(*)::int AS n FROM maestro.users WHERE cargo_id = $1 AND deleted_at IS NULL',
      [id],
    );

    const result = await query(
      'DELETE FROM maestro.cargos WHERE id = $1 RETURNING id',
      [id],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Cargo não encontrado.' });
    }

    res.json({
      success: true,
      data: { usuariosDesvinculados: usage.rows[0].n },
    });
  } catch (error) {
    console.error('deleteCargo error:', error);
    res.status(500).json({ success: false });
  }
};
