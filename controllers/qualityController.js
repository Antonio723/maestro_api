import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { query } from '../config/database.js';
import { resolveJiraCardForCutting } from '../services/jiraCardLookup.js';
import {
  resolveMetragemFromMirror,
  resolveConformityCertsFromPlates,
  resolveTensylonConformity,
  getSquareMetersForCert,
  gerarProximoNumero,
} from '../services/qualityCertificateBuilder.js';
import {
  attachToJiraIssue,
  deleteJiraAttachment,
  listJiraIssueAttachments,
} from '../services/jiraService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function resolveSignatureUserId(rawValue, fallbackUserId = null) {
  const candidate = rawValue === undefined || rawValue === null || rawValue === ''
    ? fallbackUserId
    : Number(rawValue);
  if (candidate === null || candidate === undefined || candidate === '') return null;
  const id = Number(candidate);
  if (!Number.isFinite(id)) {
    const err = new Error('Assinante inválido.');
    err.status = 400;
    throw err;
  }
  const { rows } = await query(
    `SELECT u.id
       FROM maestro.users u
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [id],
  );
  if (!rows[0]) {
    const err = new Error('Assinante não encontrado ou inativo.');
    err.status = 400;
    throw err;
  }
  return id;
}

async function getConfiguredSignatureUserId() {
  const { rows } = await query(
    `SELECT value
       FROM maestro.app_preferences
      WHERE key = 'quality_certificate_signature_user_id'
      LIMIT 1`,
  );
  const value = String(rows[0]?.value || '').trim();
  return value || null;
}

const CERTIFICATE_WITH_USERS_SELECT = `
  SELECT
    c.*,
    creator.name AS created_by_name,
    signer.name AS assinante_nome,
    cargo.nome AS assinante_cargo
  FROM maestro.quality_certificates c
  LEFT JOIN maestro.users creator ON creator.id = c.created_by
  LEFT JOIN maestro.users signer ON signer.id = COALESCE(c.signature_user_id, c.created_by)
  LEFT JOIN maestro.cargos cargo ON cargo.id = signer.cargo_id
`;

function formatConformityCertificateNumber(numero) {
  const value = String(numero || '').trim();
  if (!value) return '';
  return value.toUpperCase().startsWith('CC') ? value : `CC${value}`;
}

// ─── GET /api/quality ────────────────────────────────────────────────────────
export const listCertificates = async (req, res) => {
  const { search = '', limit = 50, offset = 0 } = req.query;
  try {
    const params = [];
    let where = '';
    if (search.trim()) {
      params.push(`%${search.trim()}%`);
      where = `WHERE (c.numero ILIKE $1 OR c.veiculo ILIKE $1 OR c.nota_fiscal ILIKE $1 OR c.certificado ILIKE $1)`;
    }
    params.push(Number(limit), Number(offset));
    const li = params.length - 1;
    const oi = params.length;

    const { rows } = await query(
      `${CERTIFICATE_WITH_USERS_SELECT}
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${li} OFFSET $${oi}`,
      params
    );

    const countParams = search.trim() ? [`%${search.trim()}%`] : [];
    const countWhere = search.trim()
      ? `WHERE (numero ILIKE $1 OR veiculo ILIKE $1 OR nota_fiscal ILIKE $1 OR certificado ILIKE $1)`
      : '';
    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM maestro.quality_certificates ${countWhere}`,
      countParams
    );

    return res.json({ success: true, data: rows, total: Number(countRows[0].count) });
  } catch (err) {
    console.error('[Quality] listCertificates error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET /api/quality/:id ─────────────────────────────────────────────────────
export const getCertificate = async (req, res) => {
  try {
    const { rows } = await query(
      `${CERTIFICATE_WITH_USERS_SELECT}
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Certificado não encontrado' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[Quality] getCertificate error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── POST /api/quality ────────────────────────────────────────────────────────
export const createCertificate = async (req, res) => {
  const {
    numero, certificado, paineis_balisticos, produtos, nota_fiscal,
    veiculo, data_emissao, material, norma, nivel,
    certificados_conformidade, garantia_anos, fornecedor_tecido, signature_user_id,
  } = req.body;

  if (!numero) return res.status(400).json({ success: false, message: '"numero" é obrigatório.' });

  try {
    const signatureUserId = await resolveSignatureUserId(signature_user_id, req.user?.id || null);
    const { rows } = await query(
      `INSERT INTO maestro.quality_certificates
         (numero, certificado, paineis_balisticos, produtos, nota_fiscal, veiculo,
           data_emissao, material, norma, nivel, certificados_conformidade,
           garantia_anos, fornecedor_tecido, created_by, signature_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        numero, certificado, paineis_balisticos,
        JSON.stringify(produtos || []),
        nota_fiscal, veiculo, data_emissao || null,
        material || 'Dupont Kevlar® S745GR',
        norma || 'ABNT NBR 15000:2020-2',
        nivel || 'III-A',
        JSON.stringify(certificados_conformidade || []),
        garantia_anos || 5,
        fornecedor_tecido || null,
        req.user?.id || null,
        signatureUserId,
      ]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[Quality] createCertificate error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PUT /api/quality/:id ─────────────────────────────────────────────────────
export const updateCertificate = async (req, res) => {
  const {
    numero, certificado, paineis_balisticos, produtos, nota_fiscal,
    veiculo, data_emissao, material, norma, nivel,
    certificados_conformidade, garantia_anos, fornecedor_tecido, signature_user_id,
  } = req.body;

  try {
    const signatureUserId = Object.prototype.hasOwnProperty.call(req.body, 'signature_user_id')
      ? await resolveSignatureUserId(signature_user_id, null)
      : undefined;
    const { rows } = await query(
      `UPDATE maestro.quality_certificates SET
         numero=$1, certificado=$2, paineis_balisticos=$3, produtos=$4,
         nota_fiscal=$5, veiculo=$6, data_emissao=$7, material=$8, norma=$9,
         nivel=$10, certificados_conformidade=$11, garantia_anos=$12,
         fornecedor_tecido=$13, signature_user_id=COALESCE($14, signature_user_id), updated_at=now()
       WHERE id=$15
       RETURNING *`,
      [
        numero, certificado, paineis_balisticos,
        JSON.stringify(produtos || []),
        nota_fiscal, veiculo, data_emissao || null,
        material || 'Dupont Kevlar® S745GR',
        norma || 'ABNT NBR 15000:2020-2',
        nivel || 'III-A',
        JSON.stringify(certificados_conformidade || []),
        garantia_anos || 5,
        fornecedor_tecido || null,
        signatureUserId,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Certificado não encontrado' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[Quality] updateCertificate error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── DELETE /api/quality/:id ──────────────────────────────────────────────────
export const deleteCertificate = async (req, res) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM maestro.quality_certificates WHERE id = $1`,
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'Certificado não encontrado' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[Quality] deleteCertificate error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── POST /api/quality/from-invoice ───────────────────────────────────────────
//
// Body: { invoice_number: string }
// Retorna { draft, warnings } — draft é um cert. pré-preenchido (NÃO persiste);
// usuário revisa e salva via POST /api/quality normal.
//
// Fluxo:
//   1. Consulta as tabelas Carbon/Spring diretamente no PostgreSQL.
//   2. Para cada consumo, parseia layer_quantity e busca cert. de conformidade
//      por (fabric_supplier_id, quantidade_camadas) — agrega únicos.
//   3. Extrai fornecedor_tecido do(s) workorder(s).
//   4. Devolve draft + warnings para o frontend exibir.
export const fromInvoice = async (req, res) => {
  const invoiceNumber = String(req.body?.invoice_number || '').trim();
  if (!invoiceNumber) {
    return res.status(400).json({ success: false, message: '"invoice_number" é obrigatório.' });
  }

  try {
    const source = await findQualitySourceByInvoice(invoiceNumber);

    const warnings = [];
    const draft = buildDraftFromQualitySource(source);

    // Cert. de Conformidade aplicável só para Aramida (Tensylon ainda sem rastreio).
    const material = String(source?.cuttingRecord?.material || '').toUpperCase();
    const isTensylon = material === 'TENSYLON';

    if (isTensylon) {
      warnings.push('Tensylon ainda não tem rastreabilidade — certificados de conformidade não foram pré-preenchidos.');
    } else {
      const certs = await lookupConformityCertificates(source?.consumptions || []);
      draft.certificados_conformidade = certs.numeros;
      warnings.push(...certs.warnings);
    }

    // Fornecedor de tecido: detecta divergência entre workorders.
    const fabricSuppliers = new Set();
    for (const c of source?.consumptions || []) {
      const fs = c?.workorder?.fabricSupplier;
      if (fs) fabricSuppliers.add(String(fs).trim());
    }
    if (fabricSuppliers.size === 0) {
      warnings.push('Nenhum workorder com fornecedor de tecido cadastrado — preencher manualmente.');
    } else if (fabricSuppliers.size > 1) {
      warnings.push(`Múltiplos fornecedores de tecido entre os enfestos: ${[...fabricSuppliers].join(', ')}. Foi usado o primeiro.`);
    }
    draft.fornecedor_tecido = [...fabricSuppliers][0] || '';

    return res.json({ success: true, data: { draft, warnings } });
  } catch (err) {
    if (err?.status === 404) {
      return res.status(404).json({
        success: false,
        message: err.message,
      });
    }
    console.error('[Quality] fromInvoice error:', err.message);
    return res.status(500).json({
      success: false,
      message: `Falha ao consultar dados da NF: ${err.message}`,
    });
  }
};

async function findQualitySourceByInvoice(invoiceNumber) {
  const { rows } = await query(
    `
      SELECT
        i.invoice_number,
        cr.id AS cr_id,
        cr.order_number,
        cr.order_description,
        cr.material,
        cr.kit_type,
        pc.supplier,
        pc.layer_quantity,
        pc.batch_number,
        pci.used_metrage AS invoiced_metrage,
        wo.id AS wo_id,
        wo.lote,
        wo.cloth_type,
        wo.cloth_batch,
        wo.fabric_supplier
      FROM public.invoices i
      JOIN public.plate_consumption_invoices pci ON pci.invoice_id = i.id
      JOIN public.plate_consumptions pc          ON pc.id = pci.plate_consumption_id
      JOIN public.cutting_records cr             ON cr.id = pc.cutting_record_id
      LEFT JOIN public.plates p                ON p.id = pc.plate_id
      LEFT JOIN public.workorder_table wo      ON wo.id = p.workorderid
      WHERE UPPER(i.invoice_number) = UPPER($1)
      ORDER BY pci.id ASC
    `,
    [invoiceNumber],
  );

  if (rows.length === 0) {
    const error = new Error(`NF ${invoiceNumber} não encontrada ou sem consumos vinculados.`);
    error.status = 404;
    throw error;
  }

  const first = rows[0];
  const total = rows.reduce((sum, row) => sum + Number(row.invoiced_metrage || 0), 0);
  return {
    invoiceNumber: first.invoice_number,
    cuttingRecord: {
      id: first.cr_id,
      orderNumber: first.order_number,
      orderDescription: first.order_description,
      material: first.material,
      kitType: first.kit_type,
    },
    totalSquareMeters: total,
    consumptions: rows.map((row) => ({
      supplier: row.supplier,
      layerQuantity: row.layer_quantity,
      batchNumber: row.batch_number,
      invoicedMetrage: row.invoiced_metrage,
      workorder: row.wo_id
        ? {
            id: row.wo_id,
            lote: row.lote,
            clothType: row.cloth_type,
            clothBatch: row.cloth_batch,
            fabricSupplier: row.fabric_supplier,
          }
        : null,
    })),
  };
}

function buildDraftFromQualitySource(source) {
  const cr = source?.cuttingRecord || {};
  const total = source?.totalSquareMeters
    ? Number(source.totalSquareMeters).toFixed(3).replace('.', ',')
    : '';
  return {
    numero: '',
    certificado: '',
    paineis_balisticos: 'Ópera Armouring Materials',
    produtos: [{ nome: cr.orderDescription || cr.orderNumber || '', quantidade_m2: total }],
    nota_fiscal: source?.invoiceNumber || '',
    veiculo: cr.orderDescription || '',
    data_emissao: new Date().toISOString().slice(0, 10),
    material: 'Dupont Kevlar® S745GR',
    norma: 'ABNT NBR 15000:2020-2',
    nivel: 'III-A',
    certificados_conformidade: [],
    fornecedor_tecido: '',
    garantia_anos: 5,
  };
}

// Parseia "8C", "9", "11C" etc. em número de camadas.
function parseCamadas(raw) {
  const m = String(raw || '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

async function lookupConformityCertificates(consumptions) {
  const warnings = [];
  const seen = new Set();
  const numeros = [];

  for (const c of consumptions) {
    const supplierName = String(c?.supplier || '').trim();
    const camadas = parseCamadas(c?.layerQuantity);
    if (!supplierName || !camadas) {
      warnings.push(`Consumo sem fornecedor ou camadas válidas (supplier="${c?.supplier}", layerQuantity="${c?.layerQuantity}").`);
      continue;
    }

    const key = `${supplierName}|${camadas}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { rows } = await query(
      `SELECT c.numero, c.nome_comercial
         FROM maestro.conformity_certificates c
         JOIN maestro.fabric_supplier fs ON fs.id = c.fabric_supplier_id
        WHERE UPPER(fs.name) = UPPER($1)
          AND c.quantidade_camadas = $2
          AND c.ativo = true
        ORDER BY c.created_at DESC
        LIMIT 1`,
      [supplierName, camadas]
    );

    if (rows.length === 0) {
      warnings.push(`Nenhum Cert. de Conformidade cadastrado para fornecedor "${supplierName}" + ${camadas} camadas.`);
      continue;
    }
    numeros.push(rows[0].numero);
  }

  return { numeros, warnings };
}

// ─── GET /api/quality/:id/pdf ─────────────────────────────────────────────────
export const generateCertificatePdf = async (req, res) => {
  try {
    const { rows } = await query(
      `${CERTIFICATE_WITH_USERS_SELECT}
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Certificado não encontrado' });

    const pdfBytes = await buildCertificatePdf(rows[0]);

    // Nome do arquivo segue o padrão do romaneio (`romaneio-{OS}.pdf`): identifica
    // pelo OS, mais natural pra anexo no Jira. Fallback no numero quando o cert
    // não tem order_number (não deveria acontecer hoje, mas segura legado).
    const fileSlug = String(rows[0].order_number || rows[0].numero || 'sem-id')
      .replace(/[^A-Za-z0-9_-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificado-qualidade-${fileSlug}.pdf"`);
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('[Quality] generateCertificatePdf error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PDF builder ──────────────────────────────────────────────────────────────
async function buildCertificatePdf(cert) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const page = doc.addPage([841.89, 595.28]); // A4 landscape
  const { width, height } = page.getSize();

  const fontBold = await doc.embedFont(
    StandardFonts.HelveticaBold
  );

  const font = await doc.embedFont(
    StandardFonts.Helvetica
  );

  // Serif (Times) usada na assinatura / texto sob a linha — equivalente
  // ao "LiberationSerif" do modelo de referência.
  const fontSerif = await doc.embedFont(
    StandardFonts.TimesRoman
  );

  const sacramentoPath = path.join(
    __dirname,
    '..',
    'scripts',
    'projetos',
    'Sacramento-Regular.ttf'
  );

  let sacramentoFont = null;

  if (fs.existsSync(sacramentoPath)) {
    try {
      const fontBytes =
        await fs.promises.readFile(
          sacramentoPath
        );

      sacramentoFont =
        await doc.embedFont(fontBytes);

    } catch (err) {
      console.error(
        'Erro fonte Sacramento:',
        err
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // COLORS
  // ──────────────────────────────────────────────────────────────────────────

  const dark = rgb(0.08, 0.08, 0.08);
  const gray = rgb(0.45, 0.45, 0.45);

  // ──────────────────────────────────────────────────────────────────────────
  // PATHS
  // ──────────────────────────────────────────────────────────────────────────

  const backendRoot = path.join(__dirname, '..');

  const logoPath = path.join(
    backendRoot,
    'scripts',
    'projetos',
    'logo.png'
  );

  const kevlarLogoPath = path.join(
    backendRoot,
    'scripts',
    'projetos',
    'logo_kevlar.png'
  );

  const garantiaLogoPath = path.join(
    backendRoot,
    'scripts',
    'projetos',
    '5anos.png'
  );

  const footerCandidates = [
    path.join(
      backendRoot,
      'scripts',
      'projetos',
      'logo-footer.png'
    ),

    path.join(
      backendRoot,
      'scripts',
      'projetos',
      'footer.png'
    ),
  ];

  const footerPath = footerCandidates.find(c =>
    fs.existsSync(c)
  );

  // ──────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  const embedImage = async filePath => {
    const bytes =
      await fs.promises.readFile(filePath);

    const ext = path
      .extname(filePath)
      .toLowerCase();

    if (
      ext === '.jpg' ||
      ext === '.jpeg'
    ) {
      return doc.embedJpg(bytes);
    }

    return doc.embedPng(bytes);
  };

  const truncateText = (
    text,
    maxWidth,
    fontRef,
    size
  ) => {
    if (
      fontRef.widthOfTextAtSize(
        text,
        size
      ) <= maxWidth
    ) {
      return text;
    }

    while (
      text.length > 0 &&
      fontRef.widthOfTextAtSize(
        `${text}...`,
        size
      ) > maxWidth
    ) {
      text = text.slice(0, -1);
    }

    return `${text}...`;
  };

  const wrapText = (
    text,
    maxW,
    fontRef,
    size
  ) => {
    const words = text.split(' ');

    const lines = [];

    let line = '';

    for (const word of words) {
      const test = line
        ? `${line} ${word}`
        : word;

      if (
        fontRef.widthOfTextAtSize(
          test,
          size
        ) > maxW &&
        line
      ) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }

    if (line) {
      lines.push(line);
    }

    return lines;
  };

  const drawWrapped = (
    text,
    fontRef,
    startY,
    size,
    maxWidth
  ) => {
    const lines = wrapText(
      text,
      maxWidth,
      fontRef,
      size
    );

    let y = startY;

    for (const line of lines) {
      page.drawText(line, {
        x: ml,
        y,
        size,
        font: fontRef,
        color: dark,
      });

      y -= size + 4;
    }

    return y;
  };

  // Versão com runs (texto + fonte [+ tamanho]) — permite bold inline e mistura
  // de tamanhos no meio do parágrafo. `runs`: [{ text, font, size? }]. Quebra
  // de linha greedy por palavra preservando fonte e tamanho de cada token; a
  // altura da linha respeita o maior tamanho usado dentro dela.
  const drawRichWrapped = (runs, startY, defaultSize, maxWidth) => {
    const words = [];
    for (const run of runs) {
      const parts = run.text.split(/\s+/);
      const runSize = run.size || defaultSize;
      for (const part of parts) {
        if (part) words.push({ text: part, font: run.font, size: runSize });
      }
    }

    let y = startY;
    let lineWords = [];
    let lineWidth = 0;

    const flushLine = () => {
      const lineMax = lineWords.reduce((m, w) => Math.max(m, w.size), defaultSize);
      let x = ml;
      for (let i = 0; i < lineWords.length; i++) {
        const w = lineWords[i];
        page.drawText(w.text, { x, y, size: w.size, font: w.font, color: dark });
        x += w.font.widthOfTextAtSize(w.text, w.size);
        if (i < lineWords.length - 1) {
          x += w.font.widthOfTextAtSize(' ', w.size);
        }
      }
      y -= lineMax + 4;
      lineWords = [];
      lineWidth = 0;
    };

    for (const w of words) {
      const wWidth = w.font.widthOfTextAtSize(w.text, w.size);
      const sepWidth = lineWords.length > 0
        ? lineWords[lineWords.length - 1].font.widthOfTextAtSize(' ', lineWords[lineWords.length - 1].size)
        : 0;
      if (lineWidth + sepWidth + wWidth > maxWidth && lineWords.length > 0) {
        flushLine();
        lineWords.push(w);
        lineWidth = wWidth;
      } else {
        lineWords.push(w);
        lineWidth += sepWidth + wWidth;
      }
    }
    if (lineWords.length > 0) flushLine();

    return y;
  };

  // ──────────────────────────────────────────────────────────────────────────
  // LAYOUT
  // ──────────────────────────────────────────────────────────────────────────

  const ml = 52;

  const contentWidth = width - ml * 2;

  // ──────────────────────────────────────────────────────────────────────────
  // HEADER
  // ──────────────────────────────────────────────────────────────────────────

  const headerTop = height - 42;

  let operaLogoHeight = 0;
  let operaLogoRight = ml;

  // OPERA

  if (fs.existsSync(logoPath)) {
    try {
      const logoImg =
        await embedImage(logoPath);

      const logoDim =
        logoImg.scale(1);

      const logoW = 120;

      const logoH =
        (logoDim.height /
          logoDim.width) *
        logoW;

      operaLogoHeight = logoH;
      operaLogoRight = ml + logoW;

      page.drawImage(logoImg, {
        x: ml,
        y: headerTop - logoH,
        width: logoW,
        height: logoH,
      });

    } catch (err) {
      console.error(
        'Erro logo Opera:',
        err
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TITLE — alinhado horizontalmente com a logo Ópera (mesma linha do header).
  // Estrutura: "CERTIFICADO DE QUALIDADE" (bold 22pt) + subtítulo "Nº ..."
  // em cinza menor logo abaixo — evita brigar com a logo e tira a duplicação
  // com o campo "Nº Certificado".
  // ──────────────────────────────────────────────────────────────────────────

  const title = 'CERTIFICADO DE QUALIDADE';
  const titleSize = 22;
  const titleW = fontBold.widthOfTextAtSize(title, titleSize);

  const subtitle = cert.numero ? `Nº ${cert.numero}` : '';
  const subtitleSize = 11;
  const subtitleW = font.widthOfTextAtSize(subtitle, subtitleSize);

  // Centralizado no espaço à direita da logo (entre logoRight+gap e margem direita),
  // pra não sobrepor a imagem da Ópera.
  const titleGap = 16;
  const titleZoneLeft = operaLogoRight + titleGap;
  const titleZoneRight = width - ml;

  // Bloco título+subtítulo centralizado verticalmente com a logo.
  const blockHeight = titleSize + 6 + subtitleSize;
  const blockTop = headerTop - (operaLogoHeight / 2) + (blockHeight / 2);
  const titleY = blockTop - titleSize;

  let titleX = titleZoneLeft + ((titleZoneRight - titleZoneLeft) - titleW) / 2;
  if (titleX < titleZoneLeft) titleX = titleZoneLeft;

  page.drawText(title, {
    x: titleX,
    y: titleY,
    size: titleSize,
    font: fontBold,
    color: dark,
  });

  if (subtitle) {
    let subtitleX = titleZoneLeft + ((titleZoneRight - titleZoneLeft) - subtitleW) / 2;
    if (subtitleX < titleZoneLeft) subtitleX = titleZoneLeft;
    page.drawText(subtitle, {
      x: subtitleX,
      y: titleY - subtitleSize - 6,
      size: subtitleSize,
      font,
      color: gray,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FIELDS (coluna única, alinhada à esquerda)
  // ──────────────────────────────────────────────────────────────────────────

  const fieldY0 = (headerTop - operaLogoHeight) - 32;

  const labelSize = 12;

  const rowGap = 16;

  const produtos = Array.isArray(
    cert.produtos
  )
    ? cert.produtos
    : [];

  const produtoQtds = produtos
    .map(p => p.quantidade_m2)
    .join('; ');

  // "Produto Ópera" = nome_comercial do(s) Cert. de Conformidade resolvido(s)
  // pelo par fornecedor+camadas. Mantém a mesma ordem de `certificados_conformidade`
  // (e, por consequência, de `produtos[].quantidade_m2`) — não deduplica aqui.
  const conformidadeCerts = Array.isArray(cert.certificados_conformidade)
    ? cert.certificados_conformidade.filter(Boolean)
    : [];

  let produtoNomes = '';
  if (conformidadeCerts.length > 0) {
    const { rows: ccRows } = await query(
      `SELECT numero, nome_comercial
         FROM maestro.conformity_certificates
        WHERE numero = ANY($1::text[])`,
      [conformidadeCerts],
    );
    const byNumero = new Map(ccRows.map(r => [r.numero, r.nome_comercial]));
    produtoNomes = conformidadeCerts
      .map(numero => (byNumero.get(numero) || '').trim() || numero)
      .join('; ');
  }

  const dataEmissao = cert.data_emissao
    ? new Date(
        cert.data_emissao
      ).toLocaleDateString(
        'pt-BR',
        {
          timeZone:
            'America/Sao_Paulo',
        }
      )
    : '';

  // Valores em fonte regular; labels (negrito) renderizados separadamente.
  // "Nº Certificado" removido — agora aparece como subtítulo do título principal.
  const fields = [
    ['OS:',                cert.order_number || '',       false],
    ['Produto Ópera:',     produtoNomes,                  false],
    ['Quantidade (m²):',   produtoQtds,                   false],
    ['Nota Fiscal:',       cert.nota_fiscal || '',        false],
    ['Veículo:',           cert.veiculo || '',            false],
    ['Data de Emissão:',   dataEmissao,                   false],
  ];

  const valueX = ml + 130;

  let lfY = fieldY0;

  for (const [label, value, isBold] of fields) {
    page.drawText(label, {
      x: ml,
      y: lfY,
      size: labelSize,
      font: fontBold,
      color: dark,
    });

    page.drawText(
      truncateText(
        String(value),
        width - valueX - ml,
        isBold ? fontBold : font,
        labelSize
      ),
      {
        x: valueX,
        y: lfY,
        size: labelSize,
        font: isBold ? fontBold : font,
        color: dark,
      }
    );

    lfY -= rowGap;
  }

  let fy = lfY - 18;

  // ──────────────────────────────────────────────────────────────────────────
  // BODY
  // ──────────────────────────────────────────────────────────────────────────

  const bodySize = 12;

  // Runs com bold inline: "Ópera Armouring Materials" em 14pt (nome da empresa)
  // e "nível III-A da norma ABNT NBR 15000:2020-2." em 12pt bold (ponto colado
  // no run bold pra evitar espaço fantasma entre "2020-2" e ".").
  const para1Runs = [
    { text: 'A ', font },
    { text: 'Ópera Armouring Materials', font: fontBold, size: 14 },
    { text: ' certifica que o produto acima especificado encontra-se em conformidade com o ', font },
    { text: 'nível III-A da norma ABNT NBR 15000:2020-2.', font: fontBold },
  ];

  fy = drawRichWrapped(para1Runs, fy, bodySize, contentWidth);

  const certs = Array.isArray(
    cert.certificados_conformidade
  )
    ? cert.certificados_conformidade
    : [];

  if (certs.length > 0) {
    fy -= 2;

    const para2 =
      `A conformidade foi comprovada por meio de ensaios realizados pelo CPRM, conforme certificados de conformidade ${certs.map(formatConformityCertificateNumber).join(' e ')}.`;

    fy = drawWrapped(
      para2,
      font,
      fy,
      bodySize,
      contentWidth
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GARANTIA IMAGE (centralizada, abaixo do corpo)
  // ──────────────────────────────────────────────────────────────────────────

  fy -= 10;

  if (
    fs.existsSync(garantiaLogoPath)
  ) {
    try {
      const garantiaImg =
        await embedImage(
          garantiaLogoPath
        );

      const garantiaDim =
        garantiaImg.scale(1);

      const gW = 175;

      const gH =
        (garantiaDim.height /
          garantiaDim.width) *
        gW;

      const garantiaY = fy - gH;

      page.drawImage(
        garantiaImg,
        {
          x: (width - gW) / 2,
          y: garantiaY,
          width: gW,
          height: gH,
        }
      );

      fy = garantiaY - 8;

    } catch (err) {
      console.error(
        'Erro garantia:',
        err
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ASSINATURA CURSIVA (fonte Sacramento)
  // ──────────────────────────────────────────────────────────────────────────

  const coordenadorNome =
    cert.assinante_nome ||
    cert.coordenador_nome ||
    cert.coordenador ||
    cert.created_by_name ||
    '';

  if (
    sacramentoFont &&
    coordenadorNome
  ) {
    // 45.5px ≈ 34pt
    const signatureSize = 34;

    const signatureW =
      sacramentoFont.widthOfTextAtSize(
        coordenadorNome,
        signatureSize
      );

    const signatureBaselineY =
      fy - signatureSize * 0.75;

    page.drawText(coordenadorNome, {
      x: (width - signatureW) / 2,
      y: signatureBaselineY,
      size: signatureSize,
      font: sacramentoFont,
      color: dark,
    });

    fy = signatureBaselineY - 2;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SIGNATURE LINE + TEXTO
  // ──────────────────────────────────────────────────────────────────────────

  const sigLineY = fy;

  page.drawLine({
    start: {
      x: width / 2 - 110,
      y: sigLineY,
    },

    end: {
      x: width / 2 + 110,
      y: sigLineY,
    },

    thickness: 1,
    color: dark,
  });

  const sigText =
    cert.assinante_cargo || 'Coordenador de Qualidade';

  const sigTextSize = 12;

  page.drawText(sigText, {
    x:
      width / 2 -
      fontSerif.widthOfTextAtSize(
        sigText,
        sigTextSize
      ) /
        2,

    y: sigLineY - 16,

    size: sigTextSize,

    font: fontSerif,

    color: dark,
  });

  // Identificação do formulário + nº do cert., centralizado horizontalmente,
  // próximo ao rodapé (alinhado verticalmente com a última linha do footer text).
  const foLabel = `FO 51 rev1${cert.numero ? ` - ${cert.numero}` : ''}`;
  const foSize = 8;
  const foW = font.widthOfTextAtSize(foLabel, foSize);
  page.drawText(foLabel, {
    x: (width - foW) / 2,
    y: 18,
    size: foSize,
    font,
    color: gray,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FOOTER IMAGE (canto direito)
  // ──────────────────────────────────────────────────────────────────────────

  if (footerPath) {
    try {
      const footerImg =
        await embedImage(
          footerPath
        );

      const footerDim =
        footerImg.scale(1);

      const footerW = 180;

      const footerH =
        (footerDim.height /
          footerDim.width) *
        footerW;

      page.drawImage(
        footerImg,
        {
          x: width - footerW,

          y: 0,

          width: footerW,

          height: footerH,
        }
      );

    } catch (err) {
      console.error(
        'Erro footer:',
        err
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FOOTER TEXT (alinhado à esquerda)
  // ──────────────────────────────────────────────────────────────────────────

  const footerLines = [
    'Ópera Armouring Materials',

    'Avenida Tucunaré 421 - Tamboré - Barueri – SP – 06460-020',

    'www.opera.security',
  ];

  let footerY = 42;

  for (const line of footerLines) {
    page.drawText(line, {
      x: ml,

      y: footerY,

      size: 9,

      font,

      color: gray,
    });

    footerY -= 12;
  }

  return doc.save();
}

// ─── GET /api/quality/by-cutting ──────────────────────────────────────────────
// Lista certs já emitidos a partir de cutting_records (cutting_record_id NOT NULL),
// no shape { osNumber, certNumero, certId, jiraKey, createdAt }. Usado pelo
// front de corte pra marcar OS já com cert + decidir overwrite/reuse.
export const listarCertsPorCorte = async (_req, res) => {
  try {
    const { rows } = await query(
      `
        SELECT
          qc.id            AS cert_id,
          qc.numero        AS cert_numero,
          qc.order_number  AS os_number,
          qc.cutting_record_id,
          cr.jira_key      AS jira_key,
          qc.created_at,
          qc.updated_at
        FROM maestro.quality_certificates qc
        JOIN public.cutting_records cr ON cr.id = qc.cutting_record_id
        WHERE qc.cutting_record_id IS NOT NULL
        ORDER BY qc.created_at DESC
      `,
    );
    return res.json({
      success: true,
      data: rows.map((r) => ({
        certId: Number(r.cert_id),
        certNumero: r.cert_numero,
        osNumber: r.os_number,
        cuttingRecordId: Number(r.cutting_record_id),
        jiraKey: r.jira_key ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error('[Quality] listarCertsPorCorte error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Anexos cuja substituição é segura ao reemitir o cert para o mesmo card.
// Reconhece dois formatos:
//   - `certificado-qualidade-{OS}.pdf`           (formato atual, alinhado ao romaneio)
//   - `certificado-qualidade-{numero}.pdf`        (formato legado, ex: CQ-2026-000001)
function isQualityCertAttachment(att, certNumero, orderNumber) {
  const name = String(att?.filename || '').toLowerCase();
  if (!name.endsWith('.pdf')) return false;
  if (!name.startsWith('certificado-qualidade-')) return false;
  if (orderNumber && name === `certificado-qualidade-${String(orderNumber).toLowerCase()}.pdf`) {
    return true;
  }
  if (certNumero && name.includes(String(certNumero).toLowerCase())) return true;
  return false;
}

// ─── POST /api/quality/from-cutting ───────────────────────────────────────────
// Body: { deliveryDate?, items: [{ cuttingRecordId, mode: 'new'|'overwrite' }] }
//
// Para cada cutting_record:
//   1. Carrega registro + consumos (com plate_id) + jira_key congelado.
//   2. Resolve metragem via cutting_plan do projeto do Jira (mesma fonte do
//      espelho). Fallback: warning, segue com total 0.
//   3. Resolve certs. de conformidade via placas usadas (workorder.fabric_supplier
//      + camadas + variante Tensylon). Consumos externos caem no padrão antigo.
//   4. UPSERT em maestro.quality_certificates (UNIQUE em cutting_record_id).
//      mode='overwrite' atualiza row existente; 'new' falha em 409 se já existir.
//   5. Gera PDF + anexa no card Jira (se houver jira_key). Sem transition.
//   6. Devolve ZIP de PDFs + relatório.
export const gerarCertificadosCorte = async (req, res) => {
  try {
    const deliveryDate = String(req.body?.deliveryDate || '').slice(0, 10) || null;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ success: false, message: 'Selecione ao menos um registro de corte.' });
    }

    const userId = req.user?.id || req.user?.userId || null;
    const configuredSignatureUserId = Object.prototype.hasOwnProperty.call(req.body || {}, 'signatureUserId')
      ? req.body?.signatureUserId
      : await getConfiguredSignatureUserId();
    const signatureUserId = await resolveSignatureUserId(configuredSignatureUserId, userId);
    const zip = new JSZip();
    const failures = [];
    const successes = [];

    for (const rawItem of items) {
      const cuttingRecordId = Number(rawItem?.cuttingRecordId);
      const mode = String(rawItem?.mode || 'new').toLowerCase();
      const fallbackName = Number.isFinite(cuttingRecordId) ? `corte-${cuttingRecordId}` : 'corte-?';

      try {
        if (!Number.isFinite(cuttingRecordId)) {
          throw new Error('cuttingRecordId inválido.');
        }

        // 1. Carrega corte + consumos (subset suficiente pro builder).
        const crResult = await query(
          `
            SELECT
              cr.id, cr.order_number, cr.order_description, cr.material,
              cr.kit_type, cr.jira_key,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'id',             pc.id,
                  'supplier',       pc.supplier,
                  'layerQuantity',  pc.layer_quantity,
                  'usedMetrage',    pc.used_metrage::float8,
                  'plateId',        pc.plate_id,
                  'batchNumber',    pc.batch_number
                ) ORDER BY pc.id)
                FROM public.plate_consumptions pc
                WHERE pc.cutting_record_id = cr.id
              ), '[]'::json) AS consumptions
            FROM public.cutting_records cr
            WHERE cr.id = $1
          `,
          [cuttingRecordId],
        );
        if (crResult.rows.length === 0) {
          throw new Error(`Cutting record ${cuttingRecordId} não encontrado.`);
        }
        const cuttingRecord = {
          id: Number(crResult.rows[0].id),
          orderNumber: crResult.rows[0].order_number,
          orderDescription: crResult.rows[0].order_description,
          material: crResult.rows[0].material,
          kitType: crResult.rows[0].kit_type,
          jiraKey: crResult.rows[0].jira_key,
          consumptions: crResult.rows[0].consumptions || [],
        };

        const isTensylon = String(cuttingRecord.material || '').toUpperCase().startsWith('TENSYLON');

        // Escopo do FO 51: cert. de qualidade só sai pra kits KIT_COMUM
        // 100% OPERA (todos os consumos processados internamente). Para Aramida
        // exige-se rastreio completo de placa — todo consumo precisa ter
        // plate_id pra que o fabric_supplier venha do workorder do enfesto
        // (única fonte confiável). Tensylon não tem placa (fluxo de enfesto
        // próprio), então essa exigência não se aplica.
        if (String(cuttingRecord.kitType || '').toUpperCase() !== 'KIT_COMUM') {
          throw new Error(
            `Cert. de Qualidade só pode ser emitido para KIT_COMUM (OS ${cuttingRecord.orderNumber} é ${cuttingRecord.kitType || 'sem kit'}).`,
          );
        }
        if (cuttingRecord.consumptions.length === 0) {
          throw new Error(
            `Cert. de Qualidade exige consumos no corte (OS ${cuttingRecord.orderNumber} sem consumos).`,
          );
        }
        const nonOpera = cuttingRecord.consumptions
          .map((c) => String(c.supplier || '').trim().toUpperCase())
          .filter((s) => s && s !== 'OPERA');
        if (nonOpera.length > 0) {
          const unicos = [...new Set(nonOpera)].join(', ');
          throw new Error(
            `Cert. de Qualidade exige consumos 100% OPERA (OS ${cuttingRecord.orderNumber} tem ${unicos}).`,
          );
        }
        const semPlate = cuttingRecord.consumptions.filter((c) => !c.plateId);
        if (!isTensylon && semPlate.length > 0) {
          throw new Error(
            `Cert. de Qualidade exige rastreio completo: todos os consumos devem ter placa do enfesto (OS ${cuttingRecord.orderNumber} tem ${semPlate.length} consumo(s) sem plate_id).`,
          );
        }

        // Idempotência: se já existe cert pro cutting_record, exige 'overwrite'.
        const existing = await query(
          'SELECT id, numero FROM maestro.quality_certificates WHERE cutting_record_id = $1',
          [cuttingRecordId],
        );
        const existingCert = existing.rows[0] || null;
        if (existingCert && mode !== 'overwrite') {
          throw Object.assign(new Error(
            `Já existe cert. ${existingCert.numero} para este corte. Use mode=overwrite para substituir.`,
          ), { code: 'CERT_EXISTS', certNumero: existingCert.numero });
        }

        // 2. Card Jira — usa o congelado e, se NULL, tenta lookup fresco (pode
        // ter sido sincronizado depois do apontamento). Continua sem anexar se
        // ainda NULL.
        let jiraKey = cuttingRecord.jiraKey;
        let jiraCard = null;
        const resolved = await resolveJiraCardForCutting({
          orderNumber: cuttingRecord.orderNumber,
          material: cuttingRecord.material,
          kitType: cuttingRecord.kitType,
        });
        if (resolved.card) {
          jiraCard = resolved.card;
          if (!jiraKey) {
            jiraKey = resolved.key;
            await query(
              'UPDATE public.cutting_records SET jira_key = $1 WHERE id = $2',
              [jiraKey, cuttingRecordId],
            );
          }
        }

        // 3. Metragem do espelho.
        const metragem = await resolveMetragemFromMirror(jiraCard, cuttingRecord);

        // 4. Certificados de conformidade. Aramida: pelas placas usadas
        // (workorder.fabric_supplier + camadas). Tensylon: sem placa/camadas —
        // resolve pela variante (INTERIM: fixa em 30A, ver builder).
        const conformidade = isTensylon
          ? await resolveTensylonConformity(cuttingRecord)
          : await resolveConformityCertsFromPlates(cuttingRecord);

        const fornecedorTecido = conformidade.fabricSuppliers[0] || '';
        const warnings = [...metragem.warnings, ...conformidade.warnings];
        if (conformidade.fabricSuppliers.length > 1) {
          warnings.push(`Múltiplos fornecedores de tecido no corte (${conformidade.fabricSuppliers.join(', ')}). Foi usado o primeiro.`);
        }

        const totalM2Str = metragem.total > 0
          ? Number(metragem.total).toFixed(3).replace('.', ',')
          : '';

        // Um item de `produtos` por cert. de conformidade, na mesma ordem de
        // `conformidade.numeros` — alimenta a coluna "Quantidade (m²)" do PDF.
        const fmtM2 = (v) => (v != null && v > 0 ? Number(v).toFixed(3).replace('.', ',') : '');
        const produtosJson = (conformidade.perCert || []).map((c) => {
          const m2 = getSquareMetersForCert(c, metragem.perLayer, cuttingRecord.material);
          if (m2 == null) {
            warnings.push(`Sem m² no espelho para cert ${c.numero} (${c.camadas} camadas) — campo ficará vazio.`);
          }
          return { quantidade_m2: fmtM2(m2) };
        });
        // Fallback: nenhum cert resolvido → mantém comportamento antigo (single line com total).
        const produtosToPersist = produtosJson.length > 0
          ? produtosJson
          : [{ nome: cuttingRecord.orderDescription || cuttingRecord.orderNumber, quantidade_m2: totalM2Str }];

        // Nº NF vem do customfield_10101 do card Jira (sincronizado em maestro.jira_cards).
        const notaFiscalFromJira = String(jiraCard?.nota_fiscal || '').trim();
        const veiculoFromJira = String(jiraCard?.veiculo || '').trim();
        const veiculoCertificado = veiculoFromJira || String(cuttingRecord.orderDescription || '').trim();
        if (!notaFiscalFromJira) {
          warnings.push('Card Jira sem Nº da Nota Fiscal (customfield_10101) preenchido — campo NF do certificado ficará vazio.');
        }

        // 5. UPSERT do quality_certificate.
        let certRow;
        if (existingCert) {
          const upd = await query(
            `UPDATE maestro.quality_certificates SET
                paineis_balisticos        = $1,
                produtos                  = $2,
                veiculo                   = $3,
                data_emissao              = $4,
                certificados_conformidade = $5,
                fornecedor_tecido         = $6,
                order_number              = $7,
                nota_fiscal               = $8,
                signature_user_id         = $9,
                updated_at                = now()
              WHERE id = $10
              RETURNING *`,
            [
              'Ópera Armouring Materials',
              JSON.stringify(produtosToPersist),
              veiculoCertificado,
              deliveryDate || new Date().toISOString().slice(0, 10),
              JSON.stringify(conformidade.numeros),
              fornecedorTecido,
              cuttingRecord.orderNumber,
              notaFiscalFromJira,
              signatureUserId,
              existingCert.id,
            ],
          );
          certRow = upd.rows[0];
        } else {
          // Retry curto pra race no numero sequencial (UNIQUE em numero).
          let inserted = null;
          let lastErr = null;
          for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
            const numero = await gerarProximoNumero();
            try {
              const ins = await query(
                `INSERT INTO maestro.quality_certificates
                   (numero, certificado, paineis_balisticos, produtos, nota_fiscal,
                    veiculo, data_emissao, material, norma, nivel,
                    certificados_conformidade, garantia_anos, fornecedor_tecido,
                    cutting_record_id, order_number, created_by, signature_user_id)
                 VALUES ($1, '', $2, $3, $4, $5, $6, $7, $8, $9, $10, 5, $11, $12, $13, $14, $15)
                 RETURNING *`,
                [
                  numero,
                  'Ópera Armouring Materials',
                  JSON.stringify(produtosToPersist),
                  notaFiscalFromJira,
                  veiculoCertificado,
                  deliveryDate || new Date().toISOString().slice(0, 10),
                  'Dupont Kevlar® S745GR',
                  'ABNT NBR 15000:2020-2',
                  'III-A',
                  JSON.stringify(conformidade.numeros),
                  fornecedorTecido,
                  cuttingRecordId,
                  cuttingRecord.orderNumber,
                  userId,
                  signatureUserId,
                ],
              );
              inserted = ins.rows[0];
            } catch (err) {
              lastErr = err;
              if (err.code !== '23505') throw err;
              // Conflito: tenta de novo com próximo numero.
            }
          }
          if (!inserted) throw lastErr || new Error('Falha ao alocar numero do certificado.');
          certRow = inserted;
        }

        // 6. Builda PDF e anexa no Jira.
        const pdfRow = await query(
          `${CERTIFICATE_WITH_USERS_SELECT}
           WHERE c.id = $1`,
          [certRow.id],
        );
        const pdfBytes = await buildCertificatePdf(pdfRow.rows[0]);
        const pdfBuffer = Buffer.from(pdfBytes);
        // Padrão alinhado ao romaneio (romaneio-{OS}.pdf): nome legível pelo
        // OS, fácil de identificar entre os anexos do card no Jira.
        const fileSlug = String(cuttingRecord.orderNumber || certRow.numero)
          .replace(/[^A-Za-z0-9_-]+/g, '_');
        const fileName = `certificado-qualidade-${fileSlug}.pdf`;
        zip.file(fileName, pdfBuffer);

        let attachmentAction = 'skipped:no-jira-key';
        if (jiraKey && userId) {
          try {
            const attachments = await listJiraIssueAttachments(userId, jiraKey);
            const obsolete = attachments.filter((a) =>
              isQualityCertAttachment(a, certRow.numero, cuttingRecord.orderNumber),
            );
            for (const att of obsolete) {
              try { await deleteJiraAttachment(userId, att.id); } catch (delErr) {
                console.warn(`[Quality] falha ao remover ${att.id} de ${jiraKey}: ${delErr.message}`);
              }
            }
            await attachToJiraIssue(userId, jiraKey, fileName, pdfBuffer);
            attachmentAction = obsolete.length > 0 ? 'replaced' : 'attached';
          } catch (jiraErr) {
            console.warn(`[Quality] anexar em ${jiraKey} falhou: ${jiraErr.message}`);
            attachmentAction = `error:${jiraErr.message}`;
            warnings.push(`Anexar no card ${jiraKey} falhou: ${jiraErr.message}`);
          }
        }

        successes.push({
          cuttingRecordId,
          osNumber: cuttingRecord.orderNumber,
          certId: Number(certRow.id),
          certNumero: certRow.numero,
          jiraKey: jiraKey || null,
          attachmentAction,
          warnings,
        });
      } catch (err) {
        failures.push({
          cuttingRecordId: Number.isFinite(cuttingRecordId) ? cuttingRecordId : null,
          name: fallbackName,
          message: err.message,
          code: err.code || null,
          certNumero: err.certNumero || null,
        });
      }
    }

    if (successes.length === 0) {
      return res.status(409).json({
        success: false,
        message: 'Nenhum certificado foi gerado.',
        failures,
      });
    }

    if (failures.length > 0) {
      const report = [
        'Falhas ao gerar certificados de qualidade',
        `Data/hora: ${new Date().toLocaleString('pt-BR')}`,
        '',
        ...failures.map((f) => `Corte ${f.name}: ${f.message}`),
      ];
      zip.file('CERT_LOG.txt', report.join('\n'));
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const fileDate = (deliveryDate || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="certificados-qualidade-${fileDate || Date.now()}.zip"`);
    res.setHeader('X-Cert-Failures', String(failures.length));
    res.setHeader('X-Cert-Successes', String(successes.length));
    return res.send(zipBuffer);
  } catch (err) {
    console.error('[Quality] gerarCertificadosCorte error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
