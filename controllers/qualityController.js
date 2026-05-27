import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import axios from 'axios';
import { query } from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
      `SELECT c.*, u.name AS created_by_name
       FROM maestro.quality_certificates c
       LEFT JOIN maestro.users u ON u.id = c.created_by
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
      `SELECT c.*, u.name AS created_by_name
       FROM maestro.quality_certificates c
       LEFT JOIN maestro.users u ON u.id = c.created_by
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
    certificados_conformidade, garantia_anos, fornecedor_tecido,
  } = req.body;

  if (!numero) return res.status(400).json({ success: false, message: '"numero" é obrigatório.' });

  try {
    const { rows } = await query(
      `INSERT INTO maestro.quality_certificates
         (numero, certificado, paineis_balisticos, produtos, nota_fiscal, veiculo,
          data_emissao, material, norma, nivel, certificados_conformidade,
          garantia_anos, fornecedor_tecido, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
    certificados_conformidade, garantia_anos, fornecedor_tecido,
  } = req.body;

  try {
    const { rows } = await query(
      `UPDATE maestro.quality_certificates SET
         numero=$1, certificado=$2, paineis_balisticos=$3, produtos=$4,
         nota_fiscal=$5, veiculo=$6, data_emissao=$7, material=$8, norma=$9,
         nivel=$10, certificados_conformidade=$11, garantia_anos=$12,
         fornecedor_tecido=$13, updated_at=now()
       WHERE id=$14
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
//   1. Chama Carbon GET /invoices/{number}/quality-source.
//   2. Para cada consumo, parseia layer_quantity e busca cert. de conformidade
//      por (plate_supplier_id, quantidade_camadas) — agrega únicos.
//   3. Extrai fornecedor_tecido do(s) workorder(s).
//   4. Devolve draft + warnings para o frontend exibir.
export const fromInvoice = async (req, res) => {
  const invoiceNumber = String(req.body?.invoice_number || '').trim();
  if (!invoiceNumber) {
    return res.status(400).json({ success: false, message: '"invoice_number" é obrigatório.' });
  }

  const carbonUrl = process.env.CARBON_API_URL;
  if (!carbonUrl) {
    return res.status(500).json({
      success: false,
      message: 'CARBON_API_URL não configurado no Maestro.',
    });
  }

  try {
    const url = `${carbonUrl.replace(/\/+$/, '')}/invoices/${encodeURIComponent(invoiceNumber)}/quality-source`;
    const carbonResp = await axios.get(url, { timeout: 15_000 });
    const source = carbonResp.data;

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
    const status = err?.response?.status;
    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: `NF ${invoiceNumber} não encontrada no Carbon.`,
      });
    }
    console.error('[Quality] fromInvoice error:', err?.response?.data || err.message);
    return res.status(502).json({
      success: false,
      message: `Falha ao consultar Carbon: ${err?.response?.data?.message || err.message}`,
    });
  }
};

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
         JOIN maestro.plate_supplier ps ON ps.id = c.plate_supplier_id
        WHERE UPPER(ps.name) = UPPER($1)
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
      `SELECT c.*, u.name AS coordenador_nome
       FROM maestro.quality_certificates c
       LEFT JOIN maestro.users u ON u.id = c.created_by
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Certificado não encontrado' });

    const pdfBytes = await buildCertificatePdf(rows[0]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificado-qualidade-${rows[0].numero}.pdf"`);
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

  let kevlarBottomY = headerTop;

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

  // KEVLAR

  if (fs.existsSync(kevlarLogoPath)) {
    try {
      const kevlarImg =
        await embedImage(
          kevlarLogoPath
        );

      const kevlarDim =
        kevlarImg.scale(1);

      const kevlarW = 105;

      const kevlarH =
        (kevlarDim.height /
          kevlarDim.width) *
        kevlarW;

      kevlarBottomY =
        headerTop - kevlarH;

      page.drawImage(kevlarImg, {
        x: width - ml - kevlarW,
        y: kevlarBottomY,
        width: kevlarW,
        height: kevlarH,
      });

    } catch (err) {
      console.error(
        'Erro logo Kevlar:',
        err
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TITLE
  // ──────────────────────────────────────────────────────────────────────────

  const titleBaseY =
    Math.min(
      headerTop - operaLogoHeight,
      kevlarBottomY
    ) - 25;

  const title =
    `CERTIFICADO DE QUALIDADE Nº ${cert.numero || ''}`;

  const titleSize = 18;

  const titleW =
    fontBold.widthOfTextAtSize(
      title,
      titleSize
    );

  page.drawText(title, {
    x: (width - titleW) / 2,
    y: titleBaseY,
    size: titleSize,
    font: fontBold,
    color: dark,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FIELDS (coluna única, alinhada à esquerda)
  // ──────────────────────────────────────────────────────────────────────────

  const fieldY0 = titleBaseY - 32;

  const labelSize = 10;

  const rowGap = 13;

  const produtos = Array.isArray(
    cert.produtos
  )
    ? cert.produtos
    : [];

  const produtoNomes = produtos
    .map(p => p.nome)
    .join('; ');

  const produtoQtds = produtos
    .map(p => p.quantidade_m2)
    .join('; ');

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

  const fields = [
    [
      'Certificado:',
      cert.certificado || '',
      false,
    ],

    [
      'Painéis Balísticos:',
      cert.paineis_balisticos || '',
      false,
    ],

    [
      'Produto Ópera:',
      produtoNomes,
      false,
    ],

    [
      'Quantidade (m²):',
      produtoQtds,
      false,
    ],

    [
      'Nota Fiscal:',
      cert.nota_fiscal || '',
      true,
    ],

    [
      'Veículo:',
      cert.veiculo || '',
      true,
    ],

    [
      'Fornecedor de Tecido:',
      cert.fornecedor_tecido || '',
      false,
    ],

    [
      'Data de Emissão:',
      dataEmissao,
      false,
    ],
  ];

  const valueX = ml + 140;

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

  const material =
    cert.material ||
    'Dupont Kevlar® S745GR';

  const nivel =
    cert.nivel || 'III-A';

  const norma =
    cert.norma ||
    'ABNT NBR 15000:2020-2';

  const bodySize = 9.5;

  const para1 =
    `A Ópera Armouring Materials certifica que o produto acima especificado foi produzido com o tecido de para-aramida ${material} e encontra-se em conformidade com o nível ${nivel} da norma ${norma}.`;

  fy = drawWrapped(
    para1,
    font,
    fy,
    bodySize,
    contentWidth
  );

  const certs = Array.isArray(
    cert.certificados_conformidade
  )
    ? cert.certificados_conformidade
    : [];

  if (certs.length > 0) {
    fy -= 6;

    const para2 =
      `A conformidade foi comprovada por meio de ensaios realizados pelo CPRM, conforme certificados de conformidade ${certs.join(' e ')}`;

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

      const gW = 140;

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
    cert.coordenador_nome ||
    cert.coordenador ||
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
    'Coordenador de Qualidade';

  const sigTextSize = 10;

  page.drawText(sigText, {
    x:
      width / 2 -
      font.widthOfTextAtSize(
        sigText,
        sigTextSize
      ) /
        2,

    y: sigLineY - 14,

    size: sigTextSize,

    font,

    color: dark,
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

      const footerW = 220;

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
    'Ópera Amoring Materials',

    'Avenida Tucunaré 421- Tamboré -Barueri – SP – 06460-020',

    'www.opera.security',
  ];

  let footerY = 38;

  for (const line of footerLines) {
    page.drawText(line, {
      x: ml,

      y: footerY,

      size: 7,

      font,

      color: gray,
    });

    footerY -= 10;
  }

  return doc.save();
}
