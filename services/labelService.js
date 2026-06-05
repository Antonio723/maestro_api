// Etiquetagem (ZPL) — porta do app standalone "zpl" para dentro do Orquestra.
// Lê os arquivos .txt (CNC/ISO, mesmo formato dos anexos TXT dos projetos) de
// uma pasta configurável por env (LABELS_DIR) — antes era a pasta fixa "iso".
// Faz o parse das peças, gera ZPL por item e um PDF de modelo para preview.
//
// Esta pasta é a MESMA onde o generateOS grava os TXT já processados
// (XXXXX → nº da OS), de modo que a OS gerada aparece aqui automaticamente.

import { readFile, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pasta das etiquetas. Default relativo só para dev quando a env não está setada.
export const LABELS_DIR = resolve(
  process.env.LABELS_DIR || path.resolve(__dirname, '../storage/labels'),
);

function assertInside(parent, target) {
  const normalized = parent.endsWith(sep) ? parent : parent + sep;
  if (target !== parent && !target.startsWith(normalized)) {
    throw new Error('Caminho fora da pasta permitida.');
  }
}

// ─── Listagem de arquivos ────────────────────────────────────────────────────
export async function listLabelFiles() {
  let entries;
  try {
    entries = await readdir(LABELS_DIR, { withFileTypes: true });
  } catch {
    return []; // pasta ainda não existe / inacessível → lista vazia
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return files;
}

export async function listFileSummaries() {
  const files = await listLabelFiles();
  return files.map((fileName) => ({
    fileName,
    orderNumber: findOrderInFileName(fileName),
    product: findProductInFileName(fileName),
    itemCount: null,
  }));
}

export async function loadFileData(fileName) {
  const files = await listLabelFiles();
  if (!files.includes(fileName)) throw new Error('Arquivo de etiqueta não encontrado.');

  const filePath = resolve(LABELS_DIR, fileName);
  assertInside(LABELS_DIR, filePath);

  const raw = await readFile(filePath, 'latin1');
  const parsed = parseIsoFile(fileName, raw);
  const { items, ...file } = parsed;
  return { files: [file], items, loadedAt: new Date().toISOString() };
}

export async function findItemByKey(key) {
  const [fileName] = String(key).split('#');
  if (!fileName) return null;
  const data = await loadFileData(fileName);
  return data.items.find((candidate) => candidate.key === key) || null;
}

function findOrderInFileName(fileName) {
  const match = fileName.match(/^(\d{4,})\b/);
  return match ? match[1] : '';
}

function findProductInFileName(fileName) {
  const match = fileName.match(/CARBON-[A-Z0-9.-]+/i);
  return match ? match[0] : '';
}

// ─── Parser (porta de server/parser.js) ──────────────────────────────────────
const TEXT_COMMANDS = new Set(['A', 'M31']);

export function parseIsoFile(fileName, raw) {
  const cleaned = raw.replace(/\u0000/g, '').trim();
  const tokens = cleaned.split('*').map((token) => token.trim());
  const items = [];
  const header = [];
  let current = null;

  for (const token of tokens) {
    if (!token) continue;

    const itemMatch = token.match(/^N(\d+)$/);
    if (itemMatch) {
      if (current) items.push(finalizeItem(current, fileName));
      current = { id: Number(itemMatch[1]), fileName, tokens: [token], textValues: [], points: [] };
      continue;
    }

    if (!current) {
      header.push(token);
      continue;
    }

    current.tokens.push(token);
    collectText(current, token);
    collectPoint(current, token);
  }

  if (current) items.push(finalizeItem(current, fileName));

  return {
    fileName,
    header,
    orderNumber: findOrder(cleaned, fileName),
    product: findProduct(fileName, cleaned),
    itemCount: items.length,
    items,
  };
}

function collectText(item, token) {
  if (/^X-?\d+Y-?\d+$/.test(token)) return;
  if (/^[A-Z]\d*$/.test(token) && !TEXT_COMMANDS.has(token)) return;
  if (/^Q?X-?\d+Y-?\d+$/.test(token)) return;
  if (/^N\d+$/.test(token)) return;
  if (token.length < 2) return;

  const value = decodeText(token);
  if (/[A-Za-z0-9]/.test(value) && !item.textValues.includes(value)) {
    item.textValues.push(value);
  }
}

function collectPoint(item, token) {
  const match = token.match(/^Q?X(-?\d+)Y(-?\d+)$/);
  if (!match) return;
  item.points.push({ x: Number(match[1]), y: Number(match[2]) });
}

function finalizeItem(item, fileName) {
  const meta = extractMeta(item.textValues, fileName);
  const bounds = calculateBounds(item.points);
  const raw = item.tokens.join('*');

  return {
    id: item.id,
    key: `${fileName}#${item.id}`,
    fileName,
    code: meta.code,
    description: meta.description,
    product: meta.product,
    layer: meta.layer,
    layers: meta.layers,
    order: meta.order,
    vehicle: meta.vehicle,
    pointCount: item.points.length,
    bounds,
    points: item.points,
    rawLength: raw.length,
  };
}

function extractMeta(values, fileName) {
  const product = values.find((value) => /CARBON-/i.test(value)) || findProduct(fileName, values.join(' '));
  const orderLine = values.find((value) => /^OS:/i.test(value)) || '';
  const vehicle = values.find((value) => /TOY|HON|CHEV|VOLK|FIAT|COROLLA|CIVIC|ONIX/i.test(value) && !/^OS:/i.test(value)) || '';
  const layer = values.find((value) => /^BASE$/i.test(value) || /CAMADAS/i.test(value)) || '';
  const layers = extractLayers(orderLine || values.join(' '));
  const part = values.find((value) => /^\d{1,3}\s*-?/.test(value)) || values.find((value) => value.length > 4) || `Item ${fileName}`;
  const partMatch = part.match(/^(\d{1,3})\s*-?\s*(.+)$/);

  return {
    code: partMatch ? partMatch[1].padStart(2, '0') : String(values.length || ''),
    description: partMatch ? normalizeSpaces(partMatch[2]) : normalizeSpaces(part),
    product: normalizeSpaces(product),
    layer: normalizeSpaces(layer),
    layers,
    order: findOrder(orderLine, fileName),
    vehicle: normalizeSpaces(vehicle),
  };
}

function extractLayers(text) {
  const match = text.match(/(\d+)\s*CAMADAS/i);
  return match ? Number(match[1]) : null;
}

function calculateBounds(points) {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function findOrder(text, fileName) {
  const match = `${text} ${fileName}`.match(/OS:\s*(\d+)|^(\d{4,})\b/);
  return match ? match[1] || match[2] : '';
}

function findProduct(fileName, text) {
  const match = `${fileName} ${text}`.match(/CARBON-[A-Z0-9.-]+/i);
  return match ? match[0] : '';
}

function decodeText(value) {
  return normalizeSpaces(value.replace(/Ã‡/g, 'C').replace(/‡/g, 'C'));
}

function normalizeSpaces(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

// ─── ZPL (porta de server/zpl.js) ─────────────────────────────────────────────
export function buildItemLabel(item) {
  const pieceLine = `${item.code || item.id} - ${item.description || 'ITEM'}`;
  const order = item.order ? `OS: ${item.order}` : 'OS: NAO INFORMADA';
  const project = item.product || item.vehicle || 'PROJETO NAO INFORMADO';
  const layers = item.layers ? `${item.layers} CAMADAS` : 'CAMADAS NAO INFORMADAS';
  const vehicle = item.vehicle || 'VEICULO NAO INFORMADO';

  return [
    '^XA',
    '^CI28',
    '^PW812',
    '^LL420',
    '^LH0,0',
    '^FO0,14^A0N,46,46^FB812,1,0,C^FD' + escapeZpl(order) + '^FS',
    '^FO18,86^GB776,310,10^FS',
    '^FO252,86^GB10,310,10^FS',
    '^FO252,158^GB542,10,10^FS',
    '^FO252,230^GB542,10,10^FS',
    '^FO252,302^GB542,10,10^FS',
    '^FO38,98^GB204,286,2^FS',
    '^FO38,98' + buildPieceGraphic(item, 204, 286) + '^FS',
    '^FO284,116^A0N,34,34^FD' + escapeZpl(pieceLine).slice(0, 34) + '^FS',
    '^FO284,188^A0N,34,34^FD' + escapeZpl(layers).slice(0, 34) + '^FS',
    '^FO284,260^A0N,34,34^FD' + escapeZpl(project).slice(0, 34) + '^FS',
    '^FO284,332^A0N,34,34^FD' + escapeZpl(vehicle).slice(0, 34) + '^FS',
    '^XZ',
  ].join('\n');
}

function buildPieceGraphic(item, width, height) {
  if (!item.points?.length || !item.bounds?.width || !item.bounds?.height) {
    return '^A0N,28,28^FB204,1,0,C^FDSEM IMG^FS';
  }

  const rowBytes = Math.ceil(width / 8);
  const bitmap = Array.from({ length: height }, () => new Uint8Array(rowBytes));
  const pad = 14;
  const scale = Math.min((width - pad * 2) / item.bounds.width, (height - pad * 2) / item.bounds.height);
  const drawWidth = item.bounds.width * scale;
  const drawHeight = item.bounds.height * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;

  const points = item.points.map((point) => ({
    x: Math.round(offsetX + (point.x - item.bounds.minX) * scale),
    y: Math.round(offsetY + (point.y - item.bounds.minY) * scale),
  }));

  fillPolygon(bitmap, width, height, points);
  for (let index = 1; index < points.length; index += 1) {
    drawLine(bitmap, width, height, points[index - 1], points[index]);
  }

  const totalBytes = rowBytes * height;
  let hex = '';
  for (const row of bitmap) {
    for (const byte of row) hex += byte.toString(16).padStart(2, '0').toUpperCase();
  }
  return `^GFA,${totalBytes},${totalBytes},${rowBytes},${hex}`;
}

function fillPolygon(bitmap, width, height, points) {
  for (let y = 0; y < height; y += 1) {
    const intersections = [];
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      if ((current.y <= y && next.y > y) || (next.y <= y && current.y > y)) {
        const x = current.x + ((y - current.y) * (next.x - current.x)) / (next.y - current.y);
        intersections.push(x);
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index < intersections.length; index += 2) {
      const start = Math.max(0, Math.ceil(intersections[index]));
      const end = Math.min(width - 1, Math.floor(intersections[index + 1] ?? intersections[index]));
      for (let x = start; x <= end; x += 1) setPixel(bitmap, width, height, x, y);
    }
  }
}

function drawLine(bitmap, width, height, start, end) {
  let x0 = start.x;
  let y0 = start.y;
  const x1 = end.x;
  const y1 = end.y;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    setPixel(bitmap, width, height, x0, y0);
    setPixel(bitmap, width, height, x0 + 1, y0);
    setPixel(bitmap, width, height, x0, y0 + 1);
    if (x0 === x1 && y0 === y1) break;
    const doubledError = 2 * error;
    if (doubledError >= dy) { error += dy; x0 += sx; }
    if (doubledError <= dx) { error += dx; y0 += sy; }
  }
}

function setPixel(bitmap, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  bitmap[y][Math.floor(x / 8)] |= 0x80 >> (x % 8);
}

function escapeZpl(value) {
  return String(value ?? '')
    .replace(/\^/g, ' ')
    .replace(/~/g, ' ')
    .replace(/[^\x20-\x7E]/g, (char) => {
      const replacements = { Ç: 'C', ç: 'c', Ã: 'A', Õ: 'O', Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U' };
      return replacements[char] || '';
    });
}

// ─── PDF de modelo (porta de server/pdf.js) ───────────────────────────────────
export function buildLabelPdf(item) {
  const width = 812;
  const height = 420;
  const pieceLine = `${item.code || item.id} - ${item.description || 'ITEM'}`;
  const order = item.order ? `OS: ${item.order}` : 'OS: NAO INFORMADA';
  const project = item.product || item.vehicle || 'PROJETO NAO INFORMADO';
  const layers = item.layers ? `${item.layers} CAMADAS` : 'CAMADAS NAO INFORMADAS';
  const vehicle = item.vehicle || 'VEICULO NAO INFORMADO';

  const content = [
    '0 0 0 RG',
    '0 0 0 rg',
    centerText(order, width / 2, 365, 46, 'F2'),
    rect(18, 24, 776, 310, 10),
    rect(252, 24, 10, 310, 0),
    rect(252, 252, 542, 10, 0),
    rect(252, 180, 542, 10, 0),
    rect(252, 108, 542, 10, 0),
    strokeRect(38, 36, 204, 286, 2),
    piecePath(item, 38, 36, 204, 286),
    text(pieceLine, 284, 280, 34, 'F2'),
    text(layers, 284, 208, 34, 'F2'),
    text(project, 284, 136, 34, 'F2'),
    text(vehicle, 284, 64, 34, 'F2'),
  ].join('\n');

  return createPdf(width, height, content);
}

function rect(x, y, width, height, lineWidth) {
  if (lineWidth > 0) return `${lineWidth} w ${x} ${y} ${width} ${height} re S`;
  return `${x} ${y} ${width} ${height} re f`;
}

function strokeRect(x, y, width, height, lineWidth) {
  return `${lineWidth} w ${x} ${y} ${width} ${height} re S`;
}

function piecePath(item, boxX, boxY, boxWidth, boxHeight) {
  if (!item.points?.length || !item.bounds?.width || !item.bounds?.height) {
    return centerText('SEM IMG', boxX + boxWidth / 2, boxY + boxHeight / 2, 24, 'F2');
  }
  const pad = 14;
  const scale = Math.min((boxWidth - pad * 2) / item.bounds.width, (boxHeight - pad * 2) / item.bounds.height);
  const drawWidth = item.bounds.width * scale;
  const drawHeight = item.bounds.height * scale;
  const offsetX = boxX + (boxWidth - drawWidth) / 2;
  const offsetY = boxY + (boxHeight - drawHeight) / 2;

  const commands = item.points.map((point, index) => {
    const x = offsetX + (point.x - item.bounds.minX) * scale;
    const y = offsetY + drawHeight - (point.y - item.bounds.minY) * scale;
    return `${formatNumber(x)} ${formatNumber(y)} ${index === 0 ? 'm' : 'l'}`;
  });
  return ['1.5 w', ...commands, 'h f'].join('\n');
}

function textCmd(value, x, y, size, font = 'F1') {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${escapePdf(value).slice(0, 42)}) Tj ET`;
}
const text = textCmd;

function centerText(value, centerX, y, size, font = 'F1') {
  const safe = escapePdf(value);
  const approximateWidth = safe.length * size * 0.55;
  const x = Math.max(0, centerX - approximateWidth / 2);
  return textCmd(safe, x, y, size, font);
}

function formatNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, '');
}

function createPdf(width, height, content) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

function escapePdf(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// ─── Gravação dos TXT processados (usado pelo generateOS) ─────────────────────
// Grava na LABELS_DIR um .txt já processado (XXXXX → nº OS). Best-effort:
// o chamador trata erros — nunca deve derrubar a geração de OS.
export async function saveProcessedLabelTxt(fileName, content) {
  const { mkdir, writeFile, rename } = await import('node:fs/promises');
  await mkdir(LABELS_DIR, { recursive: true });
  const safeName = String(fileName).replace(/[\\/]/g, '_').replace(/[^\w .,()+-]/g, '_');
  const finalPath = resolve(LABELS_DIR, safeName);
  assertInside(LABELS_DIR, finalPath);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, content, 'latin1');
  await rename(tmpPath, finalPath);
  return finalPath;
}

// ─── Impressão ────────────────────────────────────────────────────────────────
// A impressão NÃO acontece aqui. Como o backend roda na VPS (Linux) e a impressora
// fica na LAN do Windows, o servidor não alcança a impressora. A etiqueta é
// renderizada e impressa no NAVEGADOR da máquina cliente
// (CarbonProduction/src/pages/etiquetas/Etiquetas.jsx). Este serviço só fornece
// os dados das peças (listagem/parse) e, opcionalmente, o ZPL/PDF de modelo.
