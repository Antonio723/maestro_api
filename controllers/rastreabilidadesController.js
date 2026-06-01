import pool from '../config/database.js';
import { computeGs1CheckDigit } from '../shared/gs1.js';
import axios from 'axios';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRINT_SERVICE_URL = (process.env.PRINT_SERVICE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const RASTREABILIDADE_REPORT_PATH = path.resolve(__dirname, '../reports/rastreabilidade_etiquetas.jrxml');
const LABEL_CNPJ = process.env.RASTREABILIDADE_LABEL_CNPJ || '22.811.775/0002-60';
const LABEL_NIVEL = process.env.RASTREABILIDADE_LABEL_NIVEL || 'IIIA';

const SELECT_FIELDS = `
  r.id,
  r.certificate_id,
  c.numero          AS certificate_numero,
  c.nome_comercial  AS certificate_nome_comercial,
  c.material_variant_id,
  mv.nome           AS material_variant_nome,
  c.fabric_supplier_id,
  fs.name           AS fabric_supplier_nome,
  COALESCE((
    SELECT json_agg(
      json_build_object(
        'id',       mt.id,
        'nome',     mt.nome,
        'unidade',  mt.unidade,
        'valor',    c.medidas->>(mt.id::text)
      ) ORDER BY mt.nome
    )
      FROM maestro.material_measure_type_map mm
      JOIN maestro.material_measure_types mt ON mt.id = mm.measure_type_id
     WHERE mm.material_id = c.material_id AND mt.ativo = true
  ), '[]'::json) AS certificate_medidas,
  m.nome            AS material_nome,
  r.tipo_material,
  r.tr,
  r.mes,
  r.ano,
  r.sequencial,
  r.iis_tipo_embalagem,
  r.iis_pais,
  r.iis_cep,
  r.iis_dv,
  r.codigo_rastreabilidade,
  r.codigo_iis,
  r.created_by,
  r.created_at,
  r.updated_at
`;

const BASE_QUERY = `
  FROM maestro.rastreabilidades r
  JOIN maestro.conformity_certificates c ON c.id = r.certificate_id
  JOIN maestro.materials m                ON m.id = c.material_id
  LEFT JOIN maestro.material_variants mv  ON mv.id = c.material_variant_id
  LEFT JOIN maestro.fabric_supplier fs    ON fs.id = c.fabric_supplier_id
`;

async function findRastreabilidade(id) {
  const result = await pool.query(
    `SELECT ${SELECT_FIELDS} ${BASE_QUERY} WHERE r.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

function formatCertificateLabel(numero) {
  const value = String(numero || '').trim();
  if (!value) return '';
  return value.toUpperCase().startsWith('CC') ? value.toUpperCase() : `CC${value}`;
}

function formatIisLabel(item) {
  const codigo = String(item.codigo_iis || '').trim();
  const dv = String(item.iis_dv || '').trim();
  if (!codigo) return '';
  if (dv && codigo.endsWith(dv)) return `${codigo.slice(0, -1)} ${dv}`;
  return codigo;
}

function formatLayersLabel(medidas = []) {
  const camada = medidas.find((m) => String(m?.nome || '').toLowerCase().includes('camada'));
  const valor = String(camada?.valor ?? '').trim();
  if (!valor) return '';
  return `${valor.replace('.', ',')} Layers`;
}

function buildLabelData(item) {
  return [{
    line1: LABEL_CNPJ,
    line2: formatCertificateLabel(item.certificate_numero),
    line3: LABEL_NIVEL,
    line4: formatIisLabel(item),
    line5: `${item.codigo_rastreabilidade || ''}\n${formatLayersLabel(item.certificate_medidas)}`,
  }];
}

async function loadProductionConfig(client = pool) {
  const result = await client.query(
    `SELECT key, value FROM maestro.production_config
      WHERE key IN ('tr_numero','iis_tipo_embalagem','iis_pais','iis_cep')`
  );
  const cfg = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
  for (const key of ['tr_numero', 'iis_tipo_embalagem', 'iis_pais', 'iis_cep']) {
    if (!cfg[key]) {
      throw new Error(`production_config.${key} ausente — configure antes de emitir rastreabilidade`);
    }
  }
  return cfg;
}

// GET /api/rastreabilidades
export const listarRastreabilidades = async (req, res) => {
  try {
    const { tipo_material, mes, ano, certificate_id } = req.query;
    const filters = [];
    const params = [];
    if (tipo_material) {
      params.push(String(tipo_material).toUpperCase());
      filters.push(`r.tipo_material = $${params.length}`);
    }
    if (mes) {
      params.push(String(mes).padStart(2, '0'));
      filters.push(`r.mes = $${params.length}`);
    }
    if (ano) {
      params.push(String(ano).padStart(2, '0').slice(-2));
      filters.push(`r.ano = $${params.length}`);
    }
    if (certificate_id) {
      params.push(Number(certificate_id));
      filters.push(`r.certificate_id = $${params.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT ${SELECT_FIELDS} ${BASE_QUERY} ${where} ORDER BY r.created_at DESC LIMIT 500`,
      params
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('❌ Erro ao listar rastreabilidades:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/rastreabilidades/next-sequencial?tipo_material=M&mes=05&ano=26
export const proximoSequencial = async (req, res) => {
  try {
    const tipo_material = String(req.query.tipo_material || '').toUpperCase();
    const mes = String(req.query.mes || '').padStart(2, '0');
    const ano = String(req.query.ano || '').padStart(2, '0').slice(-2);

    if (!['M', 'V'].includes(tipo_material)) {
      return res.status(400).json({ success: false, message: 'tipo_material inválido (use M ou V).' });
    }
    if (!/^(0[1-9]|1[0-2])$/.test(mes)) {
      return res.status(400).json({ success: false, message: 'mes inválido (01-12).' });
    }
    if (!/^[0-9]{2}$/.test(ano)) {
      return res.status(400).json({ success: false, message: 'ano inválido (2 dígitos).' });
    }

    const cfg = await loadProductionConfig();
    const result = await pool.query(
      `SELECT COALESCE(MAX(sequencial::int), 0) + 1 AS next_seq
         FROM maestro.rastreabilidades
        WHERE tipo_material = $1 AND tr = $2 AND mes = $3 AND ano = $4`,
      [tipo_material, cfg.tr_numero, mes, ano]
    );
    const next = String(result.rows[0].next_seq).padStart(6, '0');
    if (next.length > 6) {
      return res.status(409).json({
        success: false,
        message: 'Sequencial estourou 6 dígitos para este mês/ano/tipo.',
      });
    }
    return res.status(200).json({ success: true, data: { sequencial: next } });
  } catch (error) {
    console.error('❌ Erro ao calcular próximo sequencial:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/rastreabilidades
// Body: { certificate_id, tipo_material ('M'|'V'), mes, ano, sequencial? }
// Se sequencial não vier, calcula próximo disponível. Retry em caso de race.
export const criarRastreabilidade = async (req, res) => {
  try {
    const certificate_id = Number(req.body?.certificate_id);
    const tipo_material = String(req.body?.tipo_material || '').toUpperCase();
    const mes = String(req.body?.mes || '').padStart(2, '0');
    const ano = String(req.body?.ano || '').padStart(2, '0').slice(-2);
    const sequencialRaw = req.body?.sequencial;

    if (!Number.isFinite(certificate_id)) {
      return res.status(400).json({ success: false, message: 'certificate_id é obrigatório.' });
    }
    if (!['M', 'V'].includes(tipo_material)) {
      return res.status(400).json({ success: false, message: 'tipo_material inválido (M ou V).' });
    }
    if (!/^(0[1-9]|1[0-2])$/.test(mes)) {
      return res.status(400).json({ success: false, message: 'mes inválido (01-12).' });
    }
    if (!/^[0-9]{2}$/.test(ano)) {
      return res.status(400).json({ success: false, message: 'ano inválido (2 dígitos).' });
    }

    const cfg = await loadProductionConfig();

    // Tenta até 3 vezes para lidar com race no sequencial autocalculado.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let sequencial;
      if (sequencialRaw !== undefined && sequencialRaw !== null && sequencialRaw !== '') {
        const seqStr = String(sequencialRaw).padStart(6, '0');
        if (!/^[0-9]{6}$/.test(seqStr)) {
          return res.status(400).json({ success: false, message: 'sequencial inválido (6 dígitos).' });
        }
        sequencial = seqStr;
      } else {
        const seqResult = await pool.query(
          `SELECT COALESCE(MAX(sequencial::int), 0) + 1 AS next_seq
             FROM maestro.rastreabilidades
            WHERE tipo_material = $1 AND tr = $2 AND mes = $3 AND ano = $4`,
          [tipo_material, cfg.tr_numero, mes, ano]
        );
        sequencial = String(seqResult.rows[0].next_seq).padStart(6, '0');
        if (sequencial.length > 6) {
          return res.status(409).json({
            success: false,
            message: 'Sequencial estourou 6 dígitos para este mês/ano/tipo.',
          });
        }
      }

      // 23 dígitos do IIS antes do DV.
      const data23 =
        cfg.iis_tipo_embalagem + cfg.iis_pais + cfg.tr_numero + cfg.iis_cep + mes + ano + sequencial;
      const dv = String(computeGs1CheckDigit(data23));

      try {
        const insert = await pool.query(
          `INSERT INTO maestro.rastreabilidades
             (certificate_id, tipo_material, tr, mes, ano, sequencial,
              iis_tipo_embalagem, iis_pais, iis_cep, iis_dv, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
          [
            certificate_id, tipo_material, cfg.tr_numero, mes, ano, sequencial,
            cfg.iis_tipo_embalagem, cfg.iis_pais, cfg.iis_cep, dv, req.user?.id || null,
          ]
        );

        const full = await findRastreabilidade(insert.rows[0].id);
        return res.status(201).json({ success: true, data: full });
      } catch (err) {
        lastErr = err;
        // 23505 = unique violation no (tipo_material, tr, mes, ano, sequencial).
        // Se o sequencial veio do usuário, falha imediato; se foi auto, tenta de novo.
        if (err.code === '23505' && sequencialRaw === undefined) continue;
        if (err.code === '23505') {
          return res.status(409).json({
            success: false,
            message: 'Sequencial já existe para este tipo/mês/ano.',
          });
        }
        if (err.code === '23503') {
          return res.status(400).json({ success: false, message: 'Certificado inexistente.' });
        }
        throw err;
      }
    }

    console.error('❌ Race ao gerar sequencial:', lastErr);
    return res.status(503).json({
      success: false,
      message: 'Concorrência ao gerar sequencial — tente novamente.',
    });
  } catch (error) {
    console.error('❌ Erro ao criar rastreabilidade:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/rastreabilidades/:id
export const obterRastreabilidade = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await findRastreabilidade(id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Rastreabilidade não encontrada.' });
    }
    return res.status(200).json({ success: true, data: item });
  } catch (error) {
    console.error('❌ Erro ao obter rastreabilidade:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/rastreabilidades/:id/pdf
export const gerarPdfRastreabilidade = async (req, res) => {
  try {
    const item = await findRastreabilidade(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Rastreabilidade não encontrada.' });
    }

    const jrxml = await readFile(RASTREABILIDADE_REPORT_PATH, 'utf8');
    const springRes = await axios.post(
      `${PRINT_SERVICE_URL}/render`,
      { jrxml, params: {}, data: buildLabelData(item) },
      { responseType: 'arraybuffer', timeout: 30_000, headers: { 'Content-Type': 'application/json' } }
    );

    const filename = `rastreabilidade-${item.codigo_rastreabilidade}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(springRes.data));
  } catch (error) {
    const detail = error.response?.data
      ? Buffer.from(error.response.data).toString('utf8').slice(0, 500)
      : error.message;
    console.error('❌ Erro ao gerar PDF de rastreabilidade:', detail);
    return res.status(502).json({ success: false, message: `Falha ao gerar PDF: ${detail}` });
  }
};

// DELETE /api/rastreabilidades/:id
export const excluirRastreabilidade = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM maestro.rastreabilidades WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Rastreabilidade não encontrada.' });
    }
    return res.status(200).json({ success: true, message: 'Rastreabilidade excluída.' });
  } catch (error) {
    console.error('❌ Erro ao excluir rastreabilidade:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
