import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import pool from '../config/database.js';
import {
  attachToJiraIssue,
  deleteJiraAttachment,
  downloadJiraAttachment,
  listJiraIssueAttachments,
  transitionJiraIssue,
} from '../services/jiraService.js';
import {
  extractOsFromResumo,
  normalizeOsNumber,
  pickBoardForCutting,
  findMantaCardByOs,
  findTensylonCardByOs,
} from '../services/jiraCardLookup.js';

const ROMANEIO_TARGET_STATUS = 'A entregar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROMANEIO_LOG_PATH = path.join(__dirname, '..', 'logs', 'cutting-romaneios.jsonl');

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeFileName(value) {
  return sanitizeText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function appendPrintedLog(entries) {
  if (!entries.length) return;

  await fs.promises.mkdir(path.dirname(ROMANEIO_LOG_PATH), { recursive: true });

  const lines = entries
    .map((entry) => JSON.stringify(entry))
    .join('\n');

  await fs.promises.appendFile(ROMANEIO_LOG_PATH, `${lines}\n`, 'utf8');
}

async function readPrintedLog() {
  try {
    const content = await fs.promises.readFile(ROMANEIO_LOG_PATH, 'utf8');
    const latestByOs = new Map();

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);
        const osNumber = normalizeOsNumber(entry.osNumber);

        if (!osNumber) continue;

        const current = latestByOs.get(osNumber);
        if (!current || new Date(entry.printedAt) > new Date(current.printedAt)) {
          latestByOs.set(osNumber, { ...entry, osNumber });
        }
      } catch {
        // Ignora linhas antigas/corrompidas sem impedir a consulta do historico.
      }
    }

    return Array.from(latestByOs.values()).sort(
      (a, b) => new Date(b.printedAt) - new Date(a.printedAt),
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function formatDate(value) {
  if (!value) return '';

  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function wrapText(text, font, size, maxWidth) {
  const words = sanitizeText(text).split(' ').filter(Boolean);

  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) {
        lines.push(line);
      }

      line = word;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines.length ? lines : [''];
}

function isRomaneioAttachment(att, osNumber) {
  const name = String(att?.filename || '').toLowerCase();
  if (!name.endsWith('.pdf')) return false;
  if (!name.startsWith('romaneio')) return false;
  if (!osNumber) return true;
  return name.includes(String(osNumber).toLowerCase());
}

function pickRomaneioAttachment(attachments, osNumber) {
  const candidates = (attachments || []).filter((a) => isRomaneioAttachment(a, osNumber));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const da = a.created ? new Date(a.created).getTime() : 0;
    const db = b.created ? new Date(b.created).getTime() : 0;
    return db - da;
  });
  return candidates[0];
}

function filterObsoleteRomaneioAttachments(attachments, osNumber) {
  return (attachments || []).filter((a) => isRomaneioAttachment(a, osNumber));
}

const pickBoardForItem = pickBoardForCutting;

async function enrichItems(items) {
  const enriched = [];

  for (const item of items) {
    const osNumber = sanitizeText(item.os || item.orderNumber);
    const kitType = sanitizeText(item.kitType);
    const material = sanitizeText(item.material);
    const mode = sanitizeText(item.mode).toLowerCase() || 'overwrite';

    let description = sanitizeText(
      item.description || item.orderDescription,
    );

    let project = '';
    let jiraKey = '';
    let source = 'registro';

    const board = pickBoardForItem({ kitType, material });

    if (board) {
      const jira =
        board === 'TENSYLON'
          ? await findTensylonCardByOs(osNumber)
          : await findMantaCardByOs(osNumber);

      if (jira) {
        description = sanitizeText(
          jira.veiculo || jira.resumo || description,
        );

        project = sanitizeText(jira.project);
        jiraKey = sanitizeText(jira.key);
        source = 'jira';
      }
    }

    enriched.push({
      osNumber,
      description,
      project,
      kitType,
      material,
      jiraKey,
      board,
      mode,
      source,
    });
  }

  return enriched;
}

async function buildRomaneioPdfOld({ deliveryDate, items }) {
  const pdf = await PDFDocument.create();

  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const bold = await pdf.embedFont(
    StandardFonts.HelveticaBold,
  );

  // =========================
  // A4 VERTICAL
  // =========================
  const pageSize = [595, 842];

  const margin = 40;

  function drawText(page, text, x, y, opts = {}) {
    page.drawText(sanitizeText(text), {
      x,
      y,
      size: opts.size || 10,
      font: opts.bold ? bold : font,
      color:
        opts.color || rgb(0.12, 0.16, 0.22),
    });
  }

  function drawLine(page, y) {
    page.drawLine({
      start: { x: margin, y },
      end: { x: pageSize[0] - margin, y },
      thickness: 1,
      color: rgb(0.82, 0.85, 0.9),
    });
  }

  function drawLabelValue(
    page,
    label,
    value,
    x,
    y,
    width = 200,
  ) {
    drawText(page, label, x, y, {
      size: 9,
      bold: true,
      color: rgb(0.35, 0.4, 0.48),
    });

    page.drawRectangle({
      x,
      y: y - 24,
      width,
      height: 22,
      borderColor: rgb(0.82, 0.85, 0.9),
      borderWidth: 1,
    });

    drawText(
      page,
      value || '-',
      x + 8,
      y - 16,
      {
        size: 10,
      },
    );
  }

  for (const item of items) {
    const page = pdf.addPage(pageSize);

    // =========================
    // HEADER
    // =========================

    page.drawText('ROMANEIO DE ENTREGA', {
      x: margin,
      y: 790,
      size: 20,
      font: bold,
      color: rgb(0.08, 0.12, 0.18),
    });

    drawText(
      page,
      `Data da entrega: ${formatDate(deliveryDate)}`,
      margin,
      765,
      { size: 10 },
    );

    drawLine(page, 748);

    // =========================
    // DADOS PRINCIPAIS
    // =========================

    drawLabelValue(
      page,
      'OS',
      item.osNumber,
      margin,
      700,
      180,
    );

    drawLabelValue(
      page,
      'Projeto',
      item.project,
      280,
      700,
      220,
    );

    drawLabelValue(
      page,
      'Tipo do Kit',
      item.kitType,
      margin,
      640,
      220,
    );

    drawLabelValue(
      page,
      'Card Jira',
      item.jiraKey,
      280,
      640,
      220,
    );

    // =========================
    // DESCRIÇÃO
    // =========================

    drawText(
      page,
      'Descrição do veículo',
      margin,
      570,
      {
        size: 10,
        bold: true,
        color: rgb(0.35, 0.4, 0.48),
      },
    );

    page.drawRectangle({
      x: margin,
      y: 350,
      width: pageSize[0] - margin * 2,
      height: 190,
      borderColor: rgb(0.82, 0.85, 0.9),
      borderWidth: 1,
    });

    const descLines = wrapText(
      item.description || '-',
      font,
      12,
      pageSize[0] - margin * 2 - 24,
    );

    descLines.forEach((line, idx) => {
      drawText(
        page,
        line,
        margin + 12,
        515 - idx * 18,
        {
          size: 12,
        },
      );
    });

    // =========================
    // ASSINATURA
    // =========================

    drawLine(page, 220);

    drawText(
      page,
      'Recebido por:',
      margin,
      200,
      {
        size: 10,
        bold: true,
      },
    );

    drawLine(page, 160);

    drawText(
      page,
      'Assinatura',
      margin + 180,
      145,
      {
        size: 9,
      },
    );

    // =========================
    // FOOTER
    // =========================

    drawText(
      page,
      `Gerado em ${formatDate(
        new Date().toISOString(),
      )}`,
      margin,
      24,
      {
        size: 7,
        color: rgb(0.55, 0.58, 0.62),
      },
    );
  }

  return Buffer.from(await pdf.save());
}

// Linhas da tabela de itens por página do romaneio. O romaneio unificado quebra
// em várias páginas quando passa disso.
const ROMANEIO_ROWS_PER_PAGE = 13;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// Quando unified=true, gera UM romaneio com todos os itens listados na tabela
// (quebrando em páginas de ROMANEIO_ROWS_PER_PAGE). Caso contrário, mantém o
// comportamento atual: uma página por item (uma linha preenchida).
async function buildRomaneioPdf({ deliveryDate, items, unified = false }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageSize = [595, 842]; // A4 vertical
  const black = rgb(0, 0, 0);
  const blue = rgb(0.02, 0.19, 0.35);
  const titleBg = rgb(0.92, 0.93, 0.95);
  const muted = rgb(0.45, 0.48, 0.55);
  const line = 0.55;

  const margin = 18;
  const width = pageSize[0];
  const height = pageSize[1];
  const right = width - margin;
  const top = height - margin;
  const bottom = margin;
  const contentW = width - margin * 2;

  const logoPath = path.join(__dirname, '..', 'scripts', 'projetos', 'logo.png');
  let logoImage = null;

  try {
    logoImage = await pdf.embedPng(await fs.promises.readFile(logoPath));
  } catch {
    logoImage = null;
  }

  function drawText(page, text, x, y, opts = {}) {
    page.drawText(sanitizeText(text), {
      x,
      y,
      size: opts.size || 7,
      font: opts.bold ? bold : font,
      color: opts.color || black,
    });
  }

  function drawCentered(page, text, x, y, w, opts = {}) {
    const value = sanitizeText(text);
    const size = opts.size || 7;
    const selectedFont = opts.bold ? bold : font;
    const textWidth = selectedFont.widthOfTextAtSize(value, size);
    drawText(page, value, x + Math.max(0, (w - textWidth) / 2), y, opts);
  }

  function rect(page, x, y, w, h, opts = {}) {
    const params = { x, y, width: w, height: h };
    if (opts.color) params.color = opts.color;
    if (opts.borderWidth !== 0) {
      params.borderColor = opts.borderColor || black;
      params.borderWidth = opts.borderWidth ?? line;
    }
    page.drawRectangle(params);
  }

  function fillBand(page, x, y, w, h, color) {
    page.drawRectangle({
      x: x + line,
      y,
      width: w - 2 * line,
      height: h - line,
      color,
    });
  }

  function hLine(page, x1, x2, y) {
    page.drawLine({
      start: { x: x1, y },
      end: { x: x2, y },
      thickness: line,
      color: black,
    });
  }

  function vLine(page, x, y1, y2) {
    page.drawLine({
      start: { x, y: y1 },
      end: { x, y: y2 },
      thickness: line,
      color: black,
    });
  }

  function drawLogo(page, x, y, w, h) {
    if (logoImage) {
      const ratio = logoImage.height / logoImage.width;
      const logoW = Math.min(w - 18, 82);
      const logoH = Math.min(h - 12, logoW * ratio);
      page.drawImage(logoImage, {
        x: x + (w - logoW) / 2,
        y: y + (h - logoH) / 2,
        width: logoW,
        height: logoH,
      });
      return;
    }

    const boxW = Math.min(w - 24, 72);
    const boxH = Math.min(h - 18, 30);
    const boxX = x + (w - boxW) / 2;
    const boxY = y + (h - boxH) / 2 + 4;
    rect(page, boxX, boxY, boxW, boxH, { color: blue });
    drawCentered(page, 'OPERA', boxX, boxY + boxH / 2 - 3, boxW, {
      size: 11,
      bold: true,
      color: rgb(1, 1, 1),
    });
    drawCentered(page, 'Armouring Materials', x, boxY - 9, w, {
      size: 5,
      color: blue,
    });
  }

  function drawField(page, label, value, x, y, w, h, opts = {}) {
    rect(page, x, y, w, h);
    drawText(page, label, x + 4, y + h - 7, {
      size: opts.labelSize || 6,
      bold: true,
      color: muted,
    });

    const valueSize = opts.valueSize || 7.5;
    const lines = wrapText(value || '-', font, valueSize, w - 8).slice(0, opts.maxLines || 1);
    lines.forEach((lineText, idx) => {
      drawText(page, lineText, x + 4, y + h - 17 - idx * (valueSize + 2), {
        size: valueSize,
      });
    });
  }

  function drawInvoicePartyBox(page, title, fields, x, y, w) {
    const h = 78;
    const titleH = 13;
    const row1H = 22;
    const row2H = 22;
    const row3H = h - titleH - row1H - row2H;

    fillBand(page, x, y + h - titleH, w, titleH, titleBg);
    rect(page, x, y, w, h);
    hLine(page, x, x + w, y + h - titleH);
    drawCentered(page, title, x, y + h - 9.5, w, { size: 8, bold: true });

    const yRow1 = y + h - titleH - row1H;
    const yRow2 = yRow1 - row2H;
    const yRow3 = y;

    drawField(page, 'Razão social', fields.razaoSocial, x, yRow1, w * 0.68, row1H);
    drawField(page, 'CNPJ', fields.cnpj, x + w * 0.68, yRow1, w * 0.32, row1H);

    drawField(page, 'Endereço', fields.endereco, x, yRow2, w * 0.52, row2H);
    drawField(page, 'Município', fields.municipio, x + w * 0.52, yRow2, w * 0.2, row2H);
    drawField(page, 'UF', fields.uf, x + w * 0.72, yRow2, w * 0.08, row2H);
    drawField(page, 'CEP', fields.cep, x + w * 0.8, yRow2, w * 0.2, row2H);

    drawField(page, 'Telefone', fields.telefone, x, yRow3, w * 0.22, row3H);
    drawField(page, 'E-mail', fields.email, x + w * 0.22, yRow3, w * 0.38, row3H);
    drawField(page, 'Data de emissão', fields.dataEmissao, x + w * 0.6, yRow3, w * 0.2, row3H);
    drawField(page, 'Data da entrega', fields.dataEntrega, x + w * 0.8, yRow3, w * 0.2, row3H);
  }

  function drawObservationsBox(page, x, y, w, h) {
    const titleH = 13;
    fillBand(page, x, y + h - titleH, w, titleH, titleBg);
    rect(page, x, y, w, h);
    hLine(page, x, x + w, y + h - titleH);
    drawText(page, 'OBSERVAÇÕES', x + 6, y + h - 9, { size: 7.5, bold: true });
  }

  function drawSignBox(page, x, y, w, dateValue, responsibleLabel) {
    const h = 34;
    const headerH = 13;
    const dateW = Math.round(w * 0.18);
    const responsibleW = Math.round(w * 0.36);
    const signW = w - dateW - responsibleW;

    fillBand(page, x, y + h - headerH, w, headerH, titleBg);
    rect(page, x, y, w, h);
    vLine(page, x + dateW, y, y + h);
    vLine(page, x + dateW + responsibleW, y, y + h);
    hLine(page, x, x + w, y + h - headerH);

    drawCentered(page, 'Data', x, y + h - 9, dateW, { size: 6.5, bold: true });
    drawCentered(page, dateValue || '', x, y + 8, dateW, { size: 7.5, bold: true });
    drawCentered(page, responsibleLabel, x + dateW, y + h - 9, responsibleW, { size: 6.5, bold: true });
    drawCentered(page, 'Assinatura', x + dateW + responsibleW, y + h - 9, signW, { size: 6.5, bold: true });
  }

  const pageGroups = unified
    ? chunkArray(items, ROMANEIO_ROWS_PER_PAGE)
    : items.map((it) => [it]);

  for (const pageItems of pageGroups) {
    const page = pdf.addPage(pageSize);

    rect(page, margin, bottom, contentW, height - margin * 2);

    // =========================
    // HEADER
    // =========================
    const headerH = 54;
    const headerY = top - headerH;
    const logoW = 110;
    const infoW = 142;
    const titleW = contentW - logoW - infoW;

    rect(page, margin, headerY, contentW, headerH);
    vLine(page, margin + logoW, headerY, top);
    vLine(page, margin + logoW + titleW, headerY, top);

    drawLogo(page, margin, headerY, logoW, headerH);

    drawCentered(page, 'ROMANEIO DE ENTREGA', margin + logoW, headerY + headerH - 20, titleW, {
      size: 15,
      bold: true,
    });

    const infoX = margin + logoW + titleW;
    hLine(page, infoX, infoX + infoW, headerY + headerH / 2);
    drawText(page, 'Nº ROMANEIO', infoX + 6, headerY + headerH - 9, {
      size: 6.5,
      bold: true,
      color: muted,
    });
    drawText(page, unified ? 'UNIFICADO' : (pageItems[0]?.osNumber || '-'), infoX + 6, headerY + headerH - 24, {
      size: 13,
      bold: true,
    });
    drawText(page, 'DATA DE ENTREGA', infoX + 6, headerY + headerH / 2 - 9, {
      size: 6.5,
      bold: true,
      color: muted,
    });
    drawText(page, formatDate(deliveryDate), infoX + 6, headerY + 7, {
      size: 11,
      bold: true,
    });

    // =========================
    // REMETENTE / DESTINATÁRIO
    // =========================
    const partyH = 78;
    const remY = headerY - partyH;
    const destY = remY - partyH;

    drawInvoicePartyBox(page, 'REMETENTE', {
      razaoSocial: 'Ópera Armouring Materials',
      cnpj: '22.811.775/0002-60',
      endereco: 'Avenida Tucunaré 421 - Galpão 2 - Sítio Tamboré',
      municipio: 'Barueri',
      uf: 'SP',
      cep: '06460-020',
      telefone: '-',
      email: '-',
      dataEmissao: formatDate(new Date().toISOString()),
      dataEntrega: formatDate(deliveryDate),
    }, margin, remY, contentW);

    drawInvoicePartyBox(page, 'DESTINATÁRIO', {
      razaoSocial: 'C Blindados S.A',
      cnpj: '22.811.775/0005-03',
      endereco: 'Avenida Tucunaré 421 - Galpão I - Sítio Tamboré',
      municipio: 'Barueri',
      uf: 'SP',
      cep: '06460-020',
      telefone: '-',
      email: '-',
      dataEmissao: formatDate(new Date().toISOString()),
      dataEntrega: formatDate(deliveryDate),
    }, margin, destY, contentW);

    // =========================
    // TABELA DE ITENS
    // =========================
    const tableHeaderH = 22;
    const rowH = 30;
    const rows = ROMANEIO_ROWS_PER_PAGE;
    const tableTop = destY;
    const tableBottom = tableTop - tableHeaderH - rows * rowH;
    const tableW = contentW;
    const colItem = 30;
    const colOs = 84;
    const colProject = 140;
    const colNf = 84;
    const colDesc = tableW - colItem - colOs - colProject - colNf;
    const xItem = margin;
    const xOs = xItem + colItem;
    const xProject = xOs + colOs;
    const xDesc = xProject + colProject;
    const xNf = xDesc + colDesc;

    fillBand(page, margin, tableTop - tableHeaderH, tableW, tableHeaderH, titleBg);
    rect(page, margin, tableBottom, tableW, tableHeaderH + rows * rowH);
    hLine(page, margin, margin + tableW, tableTop - tableHeaderH);
    [xOs, xProject, xDesc, xNf].forEach((x) => vLine(page, x, tableBottom, tableTop));

    const headerTextY = tableTop - 14;
    drawCentered(page, 'ITEM', xItem, headerTextY, colItem, { size: 7.5, bold: true });
    drawCentered(page, 'OS', xOs, headerTextY, colOs, { size: 7.5, bold: true });
    drawCentered(page, 'PROJETO', xProject, headerTextY, colProject, { size: 7.5, bold: true });
    drawCentered(page, 'DESCRIÇÃO', xDesc, headerTextY, colDesc, { size: 7.5, bold: true });
    drawCentered(page, 'MATERIAL', xNf, headerTextY, colNf, { size: 7.5, bold: true });

    for (let i = 0; i < rows; i++) {
      const y = tableTop - tableHeaderH - (i + 1) * rowH;
      hLine(page, margin, margin + tableW, y);
      drawCentered(page, String(i + 1), xItem, y + 11, colItem, { size: 7.5, bold: true, color: muted });
    }

    pageItems.forEach((it, rowIndex) => {
      const rowY = tableTop - tableHeaderH - (rowIndex + 1) * rowH;
      drawCentered(page, it.osNumber || '-', xOs, rowY + 11, colOs, { size: 8, bold: true });
      drawCentered(page, it.project || '-', xProject, rowY + 11, colProject, { size: 8 });
      // Material do kit produzido (ex.: ARAMIDA / TENSYLON) — substitui a antiga coluna NF.
      drawCentered(page, (it.material || '-').toUpperCase(), xNf, rowY + 11, colNf, { size: 8, bold: true });

      const descLines = wrapText(it.description || '-', font, 7.5, colDesc - 10).slice(0, 2);
      if (descLines.length === 1) {
        drawCentered(page, descLines[0], xDesc + 5, rowY + 11, colDesc - 10, { size: 7.5 });
      } else {
        descLines.forEach((text, idx) => {
          drawCentered(page, text, xDesc + 5, rowY + 17 - idx * 10, colDesc - 10, { size: 7.5 });
        });
      }
    });

    // =========================
    // OBSERVAÇÕES
    // =========================
    const obsH = 62;
    const obsY = tableBottom - 8 - obsH;
    drawObservationsBox(page, margin, obsY, contentW, obsH);

    // =========================
    // ASSINATURAS
    // =========================
    const signH = 34;
    const sign1Y = obsY - 8 - signH;
    const sign2Y = sign1Y - 6 - signH;
    drawSignBox(page, margin, sign1Y, contentW, formatDate(deliveryDate), 'Responsável pela liberação');
    drawSignBox(page, margin, sign2Y, contentW, '', 'Responsável pelo recebimento');

    // =========================
    // FOOTER
    // =========================
    const footerLineY = bottom + 22;
    hLine(page, margin + 4, right - 4, footerLineY);
    drawText(page, 'OPERA Armouring Materials', margin + 6, bottom + 10, {
      size: 6,
      color: muted,
    });
    drawCentered(page, `Documento gerado em ${formatDate(new Date().toISOString())}`, margin, bottom + 10, contentW, {
      size: 6,
      color: muted,
    });
    drawText(page, 'FO 16 Rev. 1', right - 56, bottom + 10, {
      size: 6,
      color: muted,
    });
  }

  return Buffer.from(await pdf.save());
}


export const gerarRomaneioCorte = async (req, res) => {
  try {
    const deliveryDate = sanitizeText(
      req.body?.deliveryDate,
    );

    const items = Array.isArray(req.body?.items)
      ? req.body.items
      : [];

    if (!deliveryDate) {
      return res.status(400).json({
        success: false,
        message:
          'Data da entrega é obrigatória.',
      });
    }

    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          'Selecione ao menos um item.',
      });
    }

    const cleanItems = items
      .map((item) => ({
        os: sanitizeText(
          item.os || item.orderNumber,
        ),

        description: sanitizeText(
          item.description ||
            item.orderDescription,
        ),

        kitType: sanitizeText(item.kitType),
        material: sanitizeText(item.material),
        mode: sanitizeText(item.mode).toLowerCase() || 'overwrite',
      }))
      .filter((item) => item.os);

    if (cleanItems.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          'Nenhuma OS válida informada.',
      });
    }

    const zip = new JSZip();
    const failures = [];
    const printedEntries = [];
    // Itens (já enriquecidos com projeto/descrição do Jira) que entraram no ZIP,
    // usados para montar o romaneio unificado ao final.
    const unifiedItems = [];
    const printedAt = new Date().toISOString();
    const userId = req.user?.id || req.user?.userId || null;

    for (let index = 0; index < cleanItems.length; index += 1) {
      const sourceItem = cleanItems[index];
      const fallbackName = normalizeOsNumber(sourceItem.os) || `item-${index + 1}`;
      try {
        const [item] = await enrichItems([sourceItem]);
        const osNumber = normalizeOsNumber(item.osNumber);
        const fileName = `romaneio-${sanitizeFileName(osNumber || item.jiraKey || fallbackName)}.pdf`;
        const reuseRequested = item.mode === 'reuse';

        let pdfBuffer = null;
        let pdfSource = 'generated';
        let reusedAttachmentId = null;

        if (reuseRequested && item.jiraKey && userId) {
          try {
            const attachments = await listJiraIssueAttachments(userId, item.jiraKey);
            const candidate = pickRomaneioAttachment(attachments, osNumber);
            if (candidate) {
              pdfBuffer = await downloadJiraAttachment(userId, candidate.id);
              pdfSource = 'reused';
              reusedAttachmentId = candidate.id;
            }
          } catch (error) {
            console.warn(
              `[cuttingRomaneio] Falha ao baixar anexo existente para ${item.jiraKey}: ${error.message}`,
            );
          }
        }

        if (!pdfBuffer) {
          pdfBuffer = await buildRomaneioPdf({
            deliveryDate,
            items: [item],
          });
        }

        let attachmentAction = 'skipped';
        let transitionResult = null;

        if (item.jiraKey && userId && pdfSource !== 'reused') {
          try {
            const attachments = await listJiraIssueAttachments(userId, item.jiraKey);
            const obsolete = filterObsoleteRomaneioAttachments(attachments, osNumber);
            for (const att of obsolete) {
              try {
                await deleteJiraAttachment(userId, att.id);
              } catch (error) {
                console.warn(
                  `[cuttingRomaneio] Falha ao remover anexo ${att.id} (${att.filename}) de ${item.jiraKey}: ${error.message}`,
                );
              }
            }

            await attachToJiraIssue(userId, item.jiraKey, fileName, pdfBuffer);
            attachmentAction = obsolete.length > 0 ? 'replaced' : 'attached';
          } catch (error) {
            console.warn(
              `[cuttingRomaneio] Falha ao anexar PDF em ${item.jiraKey}: ${error.message}`,
            );
            attachmentAction = `error:${error.message}`;
          }
        } else if (pdfSource === 'reused') {
          attachmentAction = 'reused';
        }

        if (item.jiraKey && userId) {
          try {
            transitionResult = await transitionJiraIssue(
              userId,
              item.jiraKey,
              ROMANEIO_TARGET_STATUS,
              null,
            );
          } catch (error) {
            console.warn(
              `[cuttingRomaneio] Falha ao mover ${item.jiraKey} para "${ROMANEIO_TARGET_STATUS}": ${error.message}`,
            );
            transitionResult = { changed: false, reason: `error:${error.message}` };
          }
        }

        zip.file(fileName, pdfBuffer);
        unifiedItems.push(item);

        printedEntries.push({
          osNumber,
          jiraKey: item.jiraKey || '',
          project: item.project || '',
          description: item.description || '',
          kitType: item.kitType || '',
          material: item.material || '',
          board: item.board || '',
          deliveryDate,
          printedAt,
          fileName,
          mode: item.mode,
          pdfSource,
          reusedAttachmentId,
          attachmentAction,
          transition: transitionResult,
          userId,
          userName: req.user?.name || req.user?.username || req.user?.email || '',
        });
      } catch (error) {
        failures.push({
          osNumber: fallbackName,
          message: error.message,
        });
      }
    }

    if (printedEntries.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Nenhum romaneio foi gerado.',
        failures,
      });
    }

    if (failures.length > 0) {
      const logLines = [
        'Falhas ao gerar romaneios',
        `Data/hora: ${new Date().toLocaleString('pt-BR')}`,
        '',
        ...failures.map(
          (failure) => `OS ${failure.osNumber}: ${failure.message}`,
        ),
      ];

      zip.file('ROMANEIO_LOG.txt', logLines.join('\n'));
    }

    await appendPrintedLog(printedEntries);

    // Romaneio unificado: um único PDF com todas as OS selecionadas em tabela.
    // Só faz sentido com 2+ itens (com 1, seria idêntico ao individual).
    if (unifiedItems.length >= 2) {
      try {
        const unifiedBuffer = await buildRomaneioPdf({
          deliveryDate,
          items: unifiedItems,
          unified: true,
        });
        const unifiedDate = sanitizeFileName(String(deliveryDate).slice(0, 10)) || 'entrega';
        zip.file(`romaneio-UNIFICADO-${unifiedDate}.pdf`, unifiedBuffer);
      } catch (error) {
        console.warn(
          `[cuttingRomaneio] Falha ao gerar romaneio unificado: ${error.message}`,
        );
      }
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const fileDate = String(deliveryDate)
      .slice(0, 10)
      .replace(/[^0-9-]/g, '');

    res.setHeader(
      'Content-Type',
      'application/zip',
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="romaneios-corte-${
        fileDate || Date.now()
      }.zip"`,
    );

    res.setHeader('X-Romaneio-Failures', String(failures.length));

    return res.send(zipBuffer);
  } catch (error) {
    console.error(
      'Erro ao gerar romaneio de corte:',
      error,
    );

    return res.status(500).json({
      success: false,
      message: `Erro: ${error.message}`,
    });
  }
};

export const listarRomaneiosImpressos = async (req, res) => {
  try {
    const printed = await readPrintedLog();

    return res.json({
      success: true,
      data: printed,
    });
  } catch (error) {
    console.error(
      'Erro ao listar romaneios impressos:',
      error,
    );

    return res.status(500).json({
      success: false,
      message: `Erro: ${error.message}`,
    });
  }
};
