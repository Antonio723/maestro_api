import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
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
    certificados_conformidade, garantia_anos,
  } = req.body;

  if (!numero) return res.status(400).json({ success: false, message: '"numero" é obrigatório.' });

  try {
    const { rows } = await query(
      `INSERT INTO maestro.quality_certificates
         (numero, certificado, paineis_balisticos, produtos, nota_fiscal, veiculo,
          data_emissao, material, norma, nivel, certificados_conformidade, garantia_anos, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
    certificados_conformidade, garantia_anos,
  } = req.body;

  try {
    const { rows } = await query(
      `UPDATE maestro.quality_certificates SET
         numero=$1, certificado=$2, paineis_balisticos=$3, produtos=$4,
         nota_fiscal=$5, veiculo=$6, data_emissao=$7, material=$8, norma=$9,
         nivel=$10, certificados_conformidade=$11, garantia_anos=$12, updated_at=now()
       WHERE id=$13
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

// ─── GET /api/quality/:id/pdf ─────────────────────────────────────────────────
export const generateCertificatePdf = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM maestro.quality_certificates WHERE id = $1`,
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
  const page = doc.addPage([841.89, 595.28]); // A4 landscape
  const { width, height } = page.getSize();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const dark = rgb(0.08, 0.08, 0.08);
  const gray = rgb(0.45, 0.45, 0.45);
  const blue = rgb(0.06, 0.30, 0.58);
  const white = rgb(1, 1, 1);
  const lightGray = rgb(0.88, 0.88, 0.88);

  const ml = 52;
  const contentWidth = width - ml * 2;

  const backendRoot = path.join(__dirname, '..');
  const logoPath = path.join(backendRoot, 'scripts', 'projetos', 'logo.png');

  // ── Logo top-left ─────────────────────────────────────────────────────────
  let logoDrawn = false;
  if (fs.existsSync(logoPath)) {
    try {
      let logoBytes = await fs.promises.readFile(logoPath);
      if (logoBytes.toString('utf8', 0, 8).startsWith('iVBORw0K')) {
        logoBytes = Buffer.from(logoBytes.toString('utf8'), 'base64');
      }
      const logoImg = await doc.embedPng(logoBytes);
      const logoW = 100;
      const logoH = (logoImg.height / logoImg.width) * logoW;
      page.drawImage(logoImg, { x: ml, y: height - 58 - logoH, width: logoW, height: logoH });
      logoDrawn = true;
    } catch { /* fallback abaixo */ }
  }
  if (!logoDrawn) {
    page.drawText('OPERA', { x: ml, y: height - 55, size: 16, font: fontBold, color: blue });
    page.drawText('Armouring Materials', { x: ml, y: height - 70, size: 8, font, color: gray });
  }

  // ── "Kevlar GENUINE" badge top-right ─────────────────────────────────────
  const badgeLines = ['MADE WITH', 'Kevlar.', 'GENUINE'];
  let bx = width - ml - 90;
  let by = height - 42;
  page.drawRectangle({ x: bx - 6, y: by - 30, width: 92, height: 40, color: rgb(0.93, 0.93, 0.93), borderColor: lightGray, borderWidth: 0.5 });
  page.drawText(badgeLines[0], { x: bx + 2, y: by + 4, size: 6, font, color: dark });
  page.drawText(badgeLines[1], { x: bx + 2, y: by - 8, size: 10, font: fontBold, color: dark });
  page.drawText(badgeLines[2], { x: bx + 2, y: by - 20, size: 7, font: fontBold, color: gray });

  // ── Divider line ──────────────────────────────────────────────────────────
  const lineY = height - 90;
  page.drawLine({ start: { x: ml, y: lineY }, end: { x: width - ml, y: lineY }, thickness: 1.2, color: blue });

  // ── Title ─────────────────────────────────────────────────────────────────
  const title = `CERTIFICADO DE QUALIDADE Nº ${cert.numero}`;
  const titleSize = 17;
  const titleW = fontBold.widthOfTextAtSize(title, titleSize);
  page.drawText(title, {
    x: (width - titleW) / 2,
    y: lineY - 30,
    size: titleSize,
    font: fontBold,
    color: dark,
  });

  // ── Fields — dois colunas para aproveitar largura horizontal ─────────────
  const fieldY0 = lineY - 60;
  const labelSize = 10;
  const rowGap = 20;
  const col2X = width / 2 + 20;

  const produtos = Array.isArray(cert.produtos) ? cert.produtos : [];
  const produtoNomes = produtos.map(p => p.nome).join('; ');
  const produtoQtds = produtos.map(p => p.quantidade_m2).join('; ');

  const dataEmissao = cert.data_emissao
    ? new Date(cert.data_emissao).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : '';

  const leftFields = [
    ['Certificado:', cert.certificado || ''],
    ['Painéis Balísticos:', cert.paineis_balisticos || ''],
    ['Produto Ópera:', produtoNomes],
    ['Quantidade (m²):', produtoQtds],
  ];

  const rightFields = [
    ['Nota Fiscal:', cert.nota_fiscal || ''],
    ['Veículo:', cert.veiculo || ''],
    ['Data de Emissão:', dataEmissao],
  ];

  let lfY = fieldY0;
  for (const [label, value] of leftFields) {
    const lw = fontBold.widthOfTextAtSize(label, labelSize);
    page.drawText(label, { x: ml, y: lfY, size: labelSize, font: fontBold, color: dark });
    page.drawText(String(value), { x: ml + lw + 6, y: lfY, size: labelSize, font, color: dark });
    lfY -= rowGap;
  }

  let rfY = fieldY0;
  for (const [label, value] of rightFields) {
    const lw = fontBold.widthOfTextAtSize(label, labelSize);
    page.drawText(label, { x: col2X, y: rfY, size: labelSize, font: fontBold, color: dark });
    page.drawText(String(value), { x: col2X + lw + 6, y: rfY, size: labelSize, font, color: dark });
    rfY -= rowGap;
  }

  // ── Divider ───────────────────────────────────────────────────────────────
  let fy = Math.min(lfY, rfY) - 12;
  page.drawLine({ start: { x: ml, y: fy }, end: { x: width - ml, y: fy }, thickness: 0.5, color: lightGray });
  fy -= 18;

  // ── Body text ─────────────────────────────────────────────────────────────
  const material = cert.material || 'Dupont Kevlar® S745GR';
  const nivel = cert.nivel || 'III-A';
  const norma = cert.norma || 'ABNT NBR 15000:2020-2';
  const bodySize = 9.5;

  const wrapText = (text, maxW, f, size) => {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(test, size) > maxW && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  const drawWrapped = (text, f, startY) => {
    const lines = wrapText(text, contentWidth, f, bodySize);
    let y = startY;
    for (const line of lines) {
      page.drawText(line, { x: ml, y, size: bodySize, font: f, color: dark });
      y -= 13;
    }
    return y;
  };

  const para1 = `A Ópera Armouring Materials certifica que o produto acima especificado foi produzido com o tecido de para-aramida ${material} e encontra-se em conformidade com o nível ${nivel} da norma ${norma}.`;
  fy = drawWrapped(para1, font, fy);

  const certs = Array.isArray(cert.certificados_conformidade) ? cert.certificados_conformidade : [];
  if (certs.length > 0) {
    fy -= 4;
    const para2 = `A conformidade foi comprovada por meio de ensaios realizados pelo CPRM, conforme certificados de conformidade ${certs.join(' e ')}`;
    fy = drawWrapped(para2, font, fy);
  }

  // ── Guarantee badge (circle with number) ──────────────────────────────────
  fy -= 30;
  const cx = width / 2;
  const radius = 26;
  page.drawCircle({ x: cx, y: fy, size: radius, color: dark });

  const numStr = String(cert.garantia_anos || 5);
  const numSize = 24;
  const numW = fontBold.widthOfTextAtSize(numStr, numSize);
  page.drawText(numStr, {
    x: cx - numW / 2,
    y: fy - numSize / 3,
    size: numSize,
    font: fontBold,
    color: white,
  });

  fy -= radius + 14;
  const gLabel = `GARANTIA ${cert.garantia_anos || 5} ANOS`;
  const gLabelSize = 11;
  const gLabelW = fontBold.widthOfTextAtSize(gLabel, gLabelSize);
  page.drawText(gLabel, { x: cx - gLabelW / 2, y: fy, size: gLabelSize, font: fontBold, color: dark });

  // ── Signature ─────────────────────────────────────────────────────────────
  fy -= 48;
  const sigW = 160;
  const sigX = cx - sigW / 2;
  page.drawLine({ start: { x: sigX, y: fy }, end: { x: sigX + sigW, y: fy }, thickness: 1, color: dark });

  fy -= 13;
  const sigLabel = 'Coordenador de Qualidade';
  const sigLabelW = font.widthOfTextAtSize(sigLabel, 9);
  page.drawText(sigLabel, { x: cx - sigLabelW / 2, y: fy, size: 9, font, color: dark });

  // ── Footer ────────────────────────────────────────────────────────────────
  const footerLineY = 40;
  page.drawLine({ start: { x: ml, y: footerLineY }, end: { x: width - ml, y: footerLineY }, thickness: 0.5, color: lightGray });

  const footerLines = [
    'Ópera Armouring Materials',
    'Avenida Tucunaré 421- Tamboré -Barueri – SP – 06460-020',
    'www.opera.security',
  ];
  let footerY = footerLineY - 10;
  for (const line of footerLines) {
    const lw = font.widthOfTextAtSize(line, 7);
    page.drawText(line, { x: (width - lw) / 2, y: footerY, size: 7, font, color: gray });
    footerY -= 10;
  }

  return doc.save();
}
