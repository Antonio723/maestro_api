import pool from '../config/database.js';
import { computeGs1CheckDigit } from '../shared/gs1.js';
import axios from 'axios';
import { readFile, mkdir, writeFile, rename, access } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRINT_SERVICE_URL = (process.env.PRINT_SERVICE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const RASTREABILIDADE_REPORT_PATH = path.resolve(__dirname, '../reports/rastreabilidade_etiquetas.jrxml');
const LABEL_CNPJ = process.env.RASTREABILIDADE_LABEL_CNPJ || '22.811.775/0002-60';
const LABEL_NIVEL = process.env.RASTREABILIDADE_LABEL_NIVEL || 'IIIA';
// PDFs de rastreabilidade gerados na criação ficam aqui (mesma base /opt/applicationStorage/orquestra
// dos demais arquivos persistidos). Default relativo p/ dev quando a env não está setada.
const RASTREABILIDADE_PDF_DIR =
  process.env.RASTREABILIDADE_PDF_DIR || path.resolve(__dirname, '../storage/rastreabilidades');

// Nome de arquivo determinístico a partir do código da rastreabilidade (sem coluna no banco).
function pdfFilenameFor(item) {
  const codigo = String(item.codigo_rastreabilidade || item.id || '').replace(/[^\w.-]/g, '_');
  return `rastreabilidade-${codigo}.pdf`;
}

function pdfPathFor(item) {
  return path.join(RASTREABILIDADE_PDF_DIR, pdfFilenameFor(item));
}

// Renderiza o PDF no Spring. Usado APENAS na criação (e no fallback p/ registros antigos);
// o download normal serve o arquivo já gravado, sem recompilar o relatório.
async function renderRastreabilidadePdf(item) {
  const jrxml = await readFile(RASTREABILIDADE_REPORT_PATH, 'utf8');
  const springRes = await axios.post(
    `${PRINT_SERVICE_URL}/render`,
    { jrxml, params: {}, data: buildLabelData(item) },
    { responseType: 'arraybuffer', timeout: 30_000, headers: { 'Content-Type': 'application/json' } }
  );
  return Buffer.from(springRes.data);
}

// Escrita atômica (.tmp → rename): o registro nunca aponta para um PDF truncado.
async function generateAndSavePdf(item) {
  const buffer = await renderRastreabilidadePdf(item);
  await mkdir(RASTREABILIDADE_PDF_DIR, { recursive: true });
  const finalPath = pdfPathFor(item);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, buffer);
  await rename(tmpPath, finalPath);
  return finalPath;
}

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

// ─── Composição do sequencial (6 dígitos) ────────────────────────────────────
// Layout: material(1) + fornecedor(2) + dia da impressão(2) + bobina(1).
//   - material  : código numérico do material (cadastro de materiais)
//   - fornecedor: código numérico do fornecedor (cadastro de fornecedores)
//   - dia       : dia da impressão (01-31)
//   - bobina    : nº da bobina impressa naquele material/fornecedor/dia (1-9)
// Os dois primeiros blocos vêm automáticos do certificado; dia/bobina são
// informados na emissão (bobina é auto-sugerida pelo próximo disponível).

// Erro de validação (vira HTTP 400 no handler) sem cair no catch genérico 500.
function seqError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Carrega os códigos de rastreabilidade do material e do fornecedor do certificado.
async function loadCertificateCodes(certificateId, client = pool) {
  const { rows } = await client.query(
    `SELECT m.nome  AS material_nome,  m.codigo_rastreabilidade  AS material_codigo,
            fs.name AS supplier_nome,  fs.codigo_rastreabilidade AS supplier_codigo
       FROM maestro.conformity_certificates c
       JOIN maestro.materials m              ON m.id = c.material_id
       LEFT JOIN maestro.fabric_supplier fs  ON fs.id = c.fabric_supplier_id
      WHERE c.id = $1`,
    [certificateId],
  );
  return rows[0] || null;
}

// Monta o prefixo de 5 dígitos: material(1) + fornecedor(2) + dia(2).
function buildSeqPrefix(codes, dia) {
  if (!codes) throw seqError('Certificado inexistente.');
  if (codes.material_codigo === null || codes.material_codigo === undefined) {
    throw seqError(`Material "${codes.material_nome}" sem código de rastreabilidade — defina no cadastro de materiais.`);
  }
  if (codes.supplier_codigo === null || codes.supplier_codigo === undefined) {
    throw seqError(`Fornecedor "${codes.supplier_nome || 'do certificado'}" sem código de rastreabilidade — defina no cadastro de fornecedores.`);
  }
  const mat = String(codes.material_codigo);
  if (mat.length !== 1) throw seqError('Código do material deve ter 1 dígito (0-9).');
  const sup = String(codes.supplier_codigo).padStart(2, '0');
  if (sup.length !== 2) throw seqError('Código do fornecedor deve ter no máximo 2 dígitos.');
  const d = String(dia || '').padStart(2, '0');
  if (!/^(0[1-9]|[12][0-9]|3[01])$/.test(d)) throw seqError('dia inválido (01-31).');
  return mat + sup + d; // 5 dígitos
}

// Próxima bobina disponível (1-9) para o prefixo dentro do grupo tipo/tr/mês/ano.
async function nextBobina(prefix, { tipo_material, tr, mes, ano }, client = pool) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(RIGHT(sequencial, 1)::int), 0) + 1 AS next
       FROM maestro.rastreabilidades
      WHERE tipo_material = $1 AND tr = $2 AND mes = $3 AND ano = $4
        AND LEFT(sequencial, 5) = $5`,
    [tipo_material, tr, mes, ano, prefix],
  );
  return rows[0].next;
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

// GET /api/rastreabilidades/next-sequencial?certificate_id=1&tipo_material=M&mes=05&ano=26&dia=03
// Sugere o sequencial completo (material+fornecedor+dia+bobina) com a próxima
// bobina disponível. material/fornecedor vêm automáticos do certificado.
export const proximoSequencial = async (req, res) => {
  try {
    const certificate_id = Number(req.query.certificate_id);
    const tipo_material = String(req.query.tipo_material || '').toUpperCase();
    const mes = String(req.query.mes || '').padStart(2, '0');
    const ano = String(req.query.ano || '').padStart(2, '0').slice(-2);
    const dia = String(req.query.dia || '').padStart(2, '0');

    if (!Number.isFinite(certificate_id)) {
      return res.status(400).json({ success: false, message: 'certificate_id é obrigatório.' });
    }
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
    const codes = await loadCertificateCodes(certificate_id);
    const prefix = buildSeqPrefix(codes, dia); // valida dia e códigos

    const bobina = await nextBobina(prefix, { tipo_material, tr: cfg.tr_numero, mes, ano });
    if (bobina > 9) {
      return res.status(409).json({
        success: false,
        message: 'Bobinas (1-9) esgotadas para este material/fornecedor/dia. Ajuste o dia da impressão.',
      });
    }
    const sequencial = prefix + String(bobina);
    return res.status(200).json({
      success: true,
      data: {
        sequencial,
        bobina,
        prefix,
        material_codigo: String(codes.material_codigo),
        fornecedor_codigo: String(codes.supplier_codigo).padStart(2, '0'),
        dia,
      },
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('❌ Erro ao calcular próximo sequencial:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// POST /api/rastreabilidades
// Body: { certificate_id, tipo_material ('M'|'V'), mes, ano, dia, bobina?, sequencial? }
// O sequencial (6 díg.) é composto por material(1)+fornecedor(2)+dia(2)+bobina(1):
//   - material/fornecedor vêm automáticos do certificado;
//   - dia é o dia da impressão; bobina, se omitida, usa a próxima disponível.
// `sequencial` (6 díg. cru) ainda é aceito como override manual. Retry em race.
export const criarRastreabilidade = async (req, res) => {
  try {
    const certificate_id = Number(req.body?.certificate_id);
    const tipo_material = String(req.body?.tipo_material || '').toUpperCase();
    const mes = String(req.body?.mes || '').padStart(2, '0');
    const ano = String(req.body?.ano || '').padStart(2, '0').slice(-2);
    const dia = String(req.body?.dia || '').padStart(2, '0');
    const sequencialRaw = req.body?.sequencial;
    const bobinaRaw = req.body?.bobina;

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

    // Override manual: sequencial cru de 6 dígitos (não recalcula bobina no retry).
    const manualSeq =
      sequencialRaw !== undefined && sequencialRaw !== null && sequencialRaw !== ''
        ? String(sequencialRaw).padStart(6, '0')
        : null;
    if (manualSeq !== null && !/^[0-9]{6}$/.test(manualSeq)) {
      return res.status(400).json({ success: false, message: 'sequencial inválido (6 dígitos).' });
    }

    // Modo composto: resolve o prefixo (material+fornecedor+dia) do certificado.
    let prefix = null;
    if (manualSeq === null) {
      const codes = await loadCertificateCodes(certificate_id);
      prefix = buildSeqPrefix(codes, dia); // valida dia e códigos (lança 400)
    }

    // Bobina informada (override) — 1 dígito.
    const bobinaFixed =
      manualSeq === null && bobinaRaw !== undefined && bobinaRaw !== null && bobinaRaw !== ''
        ? String(bobinaRaw)
        : null;
    if (bobinaFixed !== null && !/^[0-9]$/.test(bobinaFixed)) {
      return res.status(400).json({ success: false, message: 'bobina inválida (1 dígito 0-9).' });
    }

    // Tenta até 3 vezes para lidar com race na bobina autocalculada.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let sequencial;
      if (manualSeq !== null) {
        sequencial = manualSeq;
      } else if (bobinaFixed !== null) {
        sequencial = prefix + bobinaFixed;
      } else {
        const bobina = await nextBobina(prefix, { tipo_material, tr: cfg.tr_numero, mes, ano });
        if (bobina > 9) {
          return res.status(409).json({
            success: false,
            message: 'Bobinas (1-9) esgotadas para este material/fornecedor/dia. Ajuste o dia da impressão.',
          });
        }
        sequencial = prefix + String(bobina);
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

        // Gera e grava o PDF junto da criação para ficar disponível p/ download no registro.
        // Best-effort: o registro já existe; se o Spring falhar, não derruba a criação
        // (o download faz fallback de geração sob demanda).
        try {
          await generateAndSavePdf(full);
        } catch (pdfErr) {
          const detail = pdfErr.response?.data
            ? Buffer.from(pdfErr.response.data).toString('utf8').slice(0, 300)
            : pdfErr.message;
          console.error(`⚠️ Rastreabilidade ${full.id} criada, mas falha ao gerar/salvar PDF:`, detail);
        }

        return res.status(201).json({ success: true, data: full });
      } catch (err) {
        lastErr = err;
        // 23505 = unique violation no (tipo_material, tr, mes, ano, sequencial).
        // Se a bobina foi auto-calculada, tenta de novo; se foi fixada/manual, falha.
        const autoBobina = manualSeq === null && bobinaFixed === null;
        if (err.code === '23505' && autoBobina) continue;
        if (err.code === '23505') {
          return res.status(409).json({
            success: false,
            message: 'Já existe rastreabilidade com essa bobina para este material/fornecedor/dia.',
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
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
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
// Serve o PDF gravado na criação — não recompila o relatório. Fallback: registros
// criados antes desta mudança (ou cuja geração falhou) são gerados uma única vez e salvos.
export const gerarPdfRastreabilidade = async (req, res) => {
  try {
    const item = await findRastreabilidade(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Rastreabilidade não encontrada.' });
    }

    const finalPath = pdfPathFor(item);
    const filename = pdfFilenameFor(item);

    let exists = true;
    try {
      await access(finalPath, fsConstants.R_OK);
    } catch {
      exists = false;
    }
    if (!exists) {
      await generateAndSavePdf(item);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.sendFile(finalPath, (err) => {
      if (err && !res.headersSent) {
        console.error('❌ Erro ao enviar PDF de rastreabilidade:', err.message);
        res.status(500).json({ success: false, message: `Falha ao enviar PDF: ${err.message}` });
      }
    });
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
