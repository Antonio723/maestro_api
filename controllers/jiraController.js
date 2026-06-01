import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import QRCode from 'qrcode';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { registrarGeracaoEspelhos } from '../utils/espelhos-logger.js';
import { prepararCardParaDuplex } from '../utils/pdfDuplex.js';
import { decrypt } from '../utils/crypto.js';
import pool from '../config/database.js';
import { fetchAllProjects } from '../services/mirrorProjectRepository.js';
import { logProjectAudit } from '../services/auditService.js';
import { LATEST_FILE, readStatus, isRunning } from '../services/carbonReportService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Busca credenciais do Jira do usuário logado no banco de dados
 * @param {number} userId - ID do usuário logado
 * @returns {Promise<{email: string, apiToken: string}>} Credenciais do Jira
 * @throws {Error} Se credenciais não estiverem configuradas
 */
async function getUserJiraCredentials(userId) {
  try {
    const result = await pool.query(
      'SELECT email, api_token FROM maestro.users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Usuário não encontrado');
    }

    const { email, api_token } = result.rows[0];

    if (!email || !api_token) {
      throw new Error('Credenciais do Jira não configuradas para este usuário. Configure no perfil ou contate o administrador.');
    }

    const apiToken = decrypt(api_token);
    if (!apiToken) {
      throw new Error('Falha ao decifrar token Jira. Reconfigure o token em Gerenciar Usuários.');
    }

    return {
      email: email,
      apiToken,
    };
  } catch (error) {
    console.error('❌ Erro ao buscar credenciais do Jira:', error.message);
    throw error;
  }
}

// Cria PDF idêntico ao template Word original
async function criarEspelhoPdfDoCodigo(
  cardData,
  quantidadePecas = 1,
  consumoCampos = { c8: '', c9: '', c11: '' }
) {
  try {
    console.log('📄 [1/7] Iniciando criação do PDF...');
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4 em pontos
    const { width, height } = page.getSize();
    console.log('✅ [2/7] PDF criado, página adicionada');
    
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    console.log('✅ [3/7] Fontes carregadas');
    
    const backendRoot = path.join(__dirname, '..');
    const footerCandidates = [
      path.join(backendRoot, 'scripts', 'projetos', 'logo-footer.png'),
      path.join(backendRoot, 'scripts', 'projetos', 'footer.png')
    ];
    const footerPath = footerCandidates.find((candidate) => fs.existsSync(candidate));
    const topLogoPath = path.join(backendRoot, 'scripts', 'projetos', 'logo.png');
    
    const dataAtual = new Date().toLocaleDateString('pt-BR');
  
  // Margens
  const marginLeft = 58;
  
  // Logo OPERA no topo central
  let yPos = height - 100;
  if (fs.existsSync(topLogoPath)) {
    try {
      let topLogoBytes = await fs.promises.readFile(topLogoPath);
      const isBase64TopLogo = topLogoBytes.toString('utf8', 0, 8).startsWith('iVBORw0K');

      if (isBase64TopLogo) {
        topLogoBytes = Buffer.from(topLogoBytes.toString('utf8'), 'base64');
      }

      const topLogoImage = await pdfDoc.embedPng(topLogoBytes);
      const topLogoDims = topLogoImage.scale(1);
      const topLogoWidth = 130;
      const topLogoHeight = (topLogoDims.height / topLogoDims.width) * topLogoWidth;

      page.drawImage(topLogoImage, {
        x: (width - topLogoWidth) / 2,
        y: yPos - 10,
        width: topLogoWidth,
        height: topLogoHeight,
        opacity: 1
      });
      yPos -= 18;
    } catch (topLogoError) {
      page.drawText('OPERA', {
        x: width / 2 - 30,
        y: yPos,
        size: 16,
        font: fontBold,
        color: rgb(0.4, 0.6, 0.8)
      });

      yPos -= 15;
      page.drawText('Armouring Materials', {
        x: width / 2 - 45,
        y: yPos,
        size: 9,
        font: font,
        color: rgb(0.5, 0.5, 0.5)
      });
    }
  } else {
    page.drawText('OPERA', {
      x: width / 2 - 30,
      y: yPos,
      size: 16,
      font: fontBold,
      color: rgb(0.4, 0.6, 0.8)
    });

    yPos -= 15;
    page.drawText('Armouring Materials', {
      x: width / 2 - 45,
      y: yPos,
      size: 9,
      font: font,
      color: rgb(0.5, 0.5, 0.5)
    });
  }
  
  const cardIdentifier = `${cardData.id || ''} ${cardData.numeroOrdem || ''} ${cardData.numeroProjeto || ''}`;
  const isTensylonCard = /TENSYLON/i.test(cardIdentifier);
  const tensylonTitleSize = 21;
  const tituloMaterial = isTensylonCard ? 'Tensylon' : 'Aramida';
  const tituloMaterialWidth = fontBold.widthOfTextAtSize(tituloMaterial, tensylonTitleSize);
  const tituloMaterialX = width / 2 - (tituloMaterialWidth / 2);

  // Titulo do material (Tensylon ou Aramida)
  yPos -= 50;
  page.drawRectangle({
    x: tituloMaterialX - 8,
    y: yPos - 4,
    width: tituloMaterialWidth + 16,
    height: tensylonTitleSize + 7,
    color: rgb(1, 0.84, 0.62)
  });

  page.drawText(tituloMaterial, {
    x: tituloMaterialX,
    y: yPos,
    size: tensylonTitleSize,
    font: fontBold,
    color: rgb(0, 0, 0)
  });
  
  // Campos do documento
  yPos -= 60;
  const lineHeight = 50;
  const labelSize = 19;
  const valueSize = 19;
  
  const fields = [
    { label: 'Modelo:', value: cardData.modeloVeiculo },
    { label: 'Tipo De Teto:', value: cardData.tipoTeto },
    { label: 'Ano:', value: cardData.anoVeiculo },
    { label: 'Projeto:', value: cardData.numeroProjeto },
    { label: 'Data:', value: dataAtual },
    { label: 'Quantidade de peças:', value: String(quantidadePecas) },
    { label: 'OS:', value: cardData.numeroOrdem }
  ];

  const drawCenteredText = (text, x, y, w, h, size, useBold = false, color = rgb(0, 0, 0)) => {
    const fontToUse = useBold ? fontBold : font;
    const value = String(text || '');
    const textWidth = fontToUse.widthOfTextAtSize(value, size);
    const textHeight = size;

    page.drawText(value, {
      x: x + (w - textWidth) / 2,
      y: y + (h - textHeight) / 2 + 2,
      size,
      font: fontToUse,
      color
    });
  };

  for (const field of fields) {
    const labelText = String(field.label || '');
    const valueText = String(field.value || '');

    page.drawText(labelText, {
      x: marginLeft,
      y: yPos,
      size: labelSize,
      font: fontBold,
      color: rgb(0, 0, 0)
    });

    const labelWidth = fontBold.widthOfTextAtSize(labelText, labelSize);
    page.drawText(valueText, {
      x: marginLeft + labelWidth + 6,
      y: yPos,
      size: valueSize,
      font: font,
      color: rgb(0, 0, 0)
    });

    yPos -= lineHeight;

    // Para Aramida, adiciona quadro de consumo abaixo de "OS:".
    if (!isTensylonCard && labelText === 'OS:') {
      const consumoLabelSize = labelSize;
      const tableX = marginLeft;
      const tableWidth = Math.min((width - (marginLeft * 2)) * 0.88, 520);
      const colWidth = tableWidth / 3;
      const headerHeight = 30;
      const valueRowHeight = 26;
      const labelY = yPos - 6;
      const gapBetweenLabelAndTable = 10;
      const tableTopY = labelY - gapBetweenLabelAndTable - headerHeight;
      const consumoValues = [
        String(consumoCampos?.c8 || ''),
        String(consumoCampos?.c9 || ''),
        String(consumoCampos?.c11 || '')
      ];

      page.drawText('Consumo (m²):', {
        x: tableX,
        y: labelY,
        size: consumoLabelSize,
        font: fontBold,
        color: rgb(0, 0, 0)
      });

      // Linha de cabeçalho colorida
      const headerColors = [
        rgb(0.08, 0.08, 0.95),
        rgb(0.1, 0.45, 0.13),
        rgb(0.95, 0.05, 0.05)
      ];
      const headerTexts = ['8C', '9C', '11C'];

      for (let i = 0; i < 3; i += 1) {
        const x = tableX + (i * colWidth);
        page.drawRectangle({
          x,
          y: tableTopY,
          width: colWidth,
          height: headerHeight,
          color: headerColors[i],
          borderColor: rgb(0, 0, 0),
          borderWidth: 1
        });

        drawCenteredText(headerTexts[i], x, tableTopY, colWidth, headerHeight, 14, false, rgb(1, 1, 1));
      }

      // Linha de valor
      const valueRowY = tableTopY - valueRowHeight;
      for (let i = 0; i < 3; i += 1) {
        const x = tableX + (i * colWidth);
        page.drawRectangle({
          x,
          y: valueRowY,
          width: colWidth,
          height: valueRowHeight,
          color: rgb(1, 1, 1),
          borderColor: rgb(0, 0, 0),
          borderWidth: 1
        });
      }

      for (let i = 0; i < 3; i += 1) {
        drawCenteredText(consumoValues[i], tableX + (i * colWidth), valueRowY, colWidth, valueRowHeight, 13, false, rgb(0, 0, 0));
      }

      yPos = valueRowY - 22;
    }
  }
  console.log('✅ [5/7] Campos do documento desenhados');
  
  // Gera e adiciona QR code centralizado
  console.log('📄 [6/7] Gerando QR code...');
  const qrPayload = [
    cardData.modeloVeiculo,
    cardData.tipoTeto,
    cardData.anoVeiculo,
    cardData.numeroProjeto,
    cardData.numeroOrdem
  ].filter((v) => String(v || '').trim().length > 0).join('\n');
  
  const qrCodeDataUrl = await QRCode.toDataURL(qrPayload || cardData.id || '', { 
    margin: 1, 
    width: 300 
  });
  const qrImageBytes = Buffer.from(qrCodeDataUrl.split(',')[1], 'base64');
  const qrImage = await pdfDoc.embedPng(qrImageBytes);
  
  yPos -= 30;
  const qrSize = 92;
  const qrX = width / 2 - qrSize / 2;
  const qrY = yPos - qrSize;
  
  // Fundo do rodapé (arte completa)
  if (footerPath) {
    try {
      let logoBytes = await fs.promises.readFile(footerPath);
      const isBase64 = logoBytes.toString('utf8', 0, 8).startsWith('iVBORw0K');

      if (isBase64) {
        logoBytes = Buffer.from(logoBytes.toString('utf8'), 'base64');
      }

      const logoImage = await pdfDoc.embedPng(logoBytes);
      const logoDims = logoImage.scale(1);
      const footerWidth = width;
      const footerHeight = (logoDims.height / logoDims.width) * footerWidth;

      page.drawImage(logoImage, {
        x: 0,
        y: 0,
        width: footerWidth,
        height: footerHeight,
        opacity: 0.9
      });
      console.log('✅ [7/7] Arte do rodapé adicionada');
    } catch (logoError) {
      console.warn('⚠️ Não foi possível adicionar o logo no rodapé:', logoError?.message || String(logoError));
    }
  }

  // Rodapé com informações de contato
  const footerY = 80;
  page.drawText('Avenida Tucunaré 421', {
    x: marginLeft - 28,
    y: footerY,
    size: 7,
    font: font,
    color: rgb(0.36, 0.36, 0.36)
  });
  
  page.drawText('Tamboré • Barueri – SP', {
    x: marginLeft - 28,
    y: footerY - 10,
    size: 7,
    font: font,
    color: rgb(0.36, 0.36, 0.36)
  });
  
  page.drawText('CEP 06460-020', {
    x: marginLeft - 28,
    y: footerY - 20,
    size: 7,
    font: font,
    color: rgb(0.36, 0.36, 0.36)
  });
  
  page.drawText('+55 11 0000 0000', {
    x: marginLeft - 28,
    y: footerY - 30,
    size: 7,
    font: font,
    color: rgb(0.36, 0.36, 0.36)
  });
  
  page.drawText('www.opera.security', {
    x: marginLeft - 28,
    y: footerY - 40,
    size: 7,
    font: font,
    color: rgb(0.36, 0.36, 0.36)
  });

  // Ícones sociais abaixo do site
  const iconsY = footerY - 56;
  const iconRadius = 7;
  const iconGap = 20;
  const iconStartX = marginLeft - 21;
  const iconFill = rgb(0.08, 0.36, 0.56);
  const iconTextColor = rgb(1, 1, 1);
  const socialIcons = [
    { label: 'IG', size: 5.2 },
    { label: 'f', size: 8.5 },
    { label: 'YT', size: 4.8 },
    { label: 'in', size: 5.6 }
  ];

  socialIcons.forEach((icon, idx) => {
    const cx = iconStartX + (idx * iconGap);
    page.drawCircle({
      x: cx,
      y: iconsY,
      size: iconRadius,
      color: iconFill
    });

    const textWidth = fontBold.widthOfTextAtSize(icon.label, icon.size);
    page.drawText(icon.label, {
      x: cx - (textWidth / 2),
      y: iconsY - (icon.size / 3),
      size: icon.size,
      font: fontBold,
      color: iconTextColor
    });
  });
  
  // Desenha o QR por último para ficar sobreposto
  page.drawImage(qrImage, {
    x: qrX,
    y: qrY,
    width: qrSize,
    height: qrSize
  });

  const revisaoText = 'Fo.22.1 - Rev.0';
  const revisaoSize = 7;
  const revisaoWidth = font.widthOfTextAtSize(revisaoText, revisaoSize);
  page.drawText(revisaoText, {
    x: qrX + (qrSize / 2) - (revisaoWidth / 2),
    y: qrY - 12,
    size: revisaoSize,
    font: font,
    color: rgb(0.42, 0.42, 0.42)
  });

  console.log('✅ [6/7] QR code adicionado (sobreposto)');

  // Converte Uint8Array para Buffer
  console.log('📄 [7/7] Salvando PDF...');
  const pdfBytes = await pdfDoc.save();
  console.log('✅ [7/7] PDF salvo com sucesso, tamanho:', pdfBytes.length, 'bytes');
  return Buffer.from(pdfBytes);
  } catch (error) {
    console.error('❌ ERRO CAPTURADO AO CRIAR PDF:');
    console.error('  - Tipo:', typeof error);
    console.error('  - Message:', error?.message || 'SEM MENSAGEM');
    console.error('  - Stack:', error?.stack || 'SEM STACK');
    console.error('  - Error completo:', error);
    throw new Error(error?.message || `Erro desconhecido ao criar PDF: ${String(error)}`);
  }
}

async function mesclarPdfBuffers(primaryPdfBuffer, secondaryPdfBuffer) {
  const mergedPdf = await PDFDocument.create();
  const primaryPdf = await PDFDocument.load(primaryPdfBuffer);
  const secondaryPdf = await PDFDocument.load(secondaryPdfBuffer);

  const primaryPages = await mergedPdf.copyPages(primaryPdf, primaryPdf.getPageIndices());
  primaryPages.forEach((page) => mergedPdf.addPage(page));

  const secondaryPages = await mergedPdf.copyPages(secondaryPdf, secondaryPdf.getPageIndices());
  secondaryPages.forEach((page) => mergedPdf.addPage(page));

  return await mergedPdf.save();
}

async function criarUltimaFolhaAramida(cardData, quantidadeTampas = 1) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const backendRoot = path.join(__dirname, '..');
  const footerCandidates = [
    path.join(backendRoot, 'scripts', 'projetos', 'logo-footer.png'),
    path.join(backendRoot, 'scripts', 'projetos', 'footer.png')
  ];
  const footerPath = footerCandidates.find((candidate) => fs.existsSync(candidate));
  const topLogoPath = path.join(backendRoot, 'scripts', 'projetos', 'logo.png');

  const marginLeft = 60;
  let yPos = height - 88;

  if (fs.existsSync(topLogoPath)) {
    try {
      let topLogoBytes = await fs.promises.readFile(topLogoPath);
      const isBase64TopLogo = topLogoBytes.toString('utf8', 0, 8).startsWith('iVBORw0K');

      if (isBase64TopLogo) {
        topLogoBytes = Buffer.from(topLogoBytes.toString('utf8'), 'base64');
      }

      const topLogoImage = await pdfDoc.embedPng(topLogoBytes);
      const topLogoDims = topLogoImage.scale(1);
      const topLogoWidth = 95;
      const topLogoHeight = (topLogoDims.height / topLogoDims.width) * topLogoWidth;

      page.drawImage(topLogoImage, {
        x: (width - topLogoWidth) / 2,
        y: yPos,
        width: topLogoWidth,
        height: topLogoHeight
      });
    } catch {
      page.drawText('OPERA', {
        x: width / 2 - 25,
        y: yPos,
        size: 14,
        font: fontBold,
        color: rgb(0.4, 0.6, 0.8)
      });
    }
  }

  page.drawText('Pacote 2 - Tampa', {
    x: width - 180,
    y: height - 58,
    size: 14,
    font: font,
    color: rgb(0.12, 0.3, 0.5)
  });

  yPos = height - 170;
  const titulo = 'Aramida';
  const tituloSize = 21;
  const tituloWidth = fontBold.widthOfTextAtSize(titulo, tituloSize);
  const tituloX = width / 2 - (tituloWidth / 2);

  page.drawRectangle({
    x: tituloX - 6,
    y: yPos - 4,
    width: tituloWidth + 12,
    height: tituloSize + 7,
    color: rgb(1, 0.84, 0.62)
  });

  page.drawText(titulo, {
    x: tituloX,
    y: yPos,
    size: tituloSize,
    font: fontBold,
    color: rgb(0, 0, 0)
  });

  yPos -= 58;
  page.drawRectangle({
    x: marginLeft,
    y: yPos,
    width: 115,
    height: 19,
    color: rgb(0.05, 0.12, 0.62)
  });

  page.drawText('Tampa traseira', {
    x: marginLeft + 8,
    y: yPos + 4,
    size: 14,
    font: fontBold,
    color: rgb(1, 1, 1)
  });

  yPos -= 52;
  const labelSize = 19;
  const valueSize = 19;
  const lineHeight = 50;
  const fields = [
    { label: 'Modelo:', value: cardData.modeloVeiculo },
    { label: 'Projeto:', value: cardData.numeroProjeto },
    { label: 'OS:', value: cardData.numeroOrdem },
    { label: 'Quantidade de peças:', value: String(quantidadeTampas) }
  ];

  fields.forEach((field) => {
    const labelText = String(field.label || '');
    const valueText = String(field.value || '');

    page.drawText(labelText, {
      x: marginLeft,
      y: yPos,
      size: labelSize,
      font: fontBold,
      color: rgb(0, 0, 0)
    });

    const labelWidth = fontBold.widthOfTextAtSize(labelText, labelSize);
    page.drawText(valueText, {
      x: marginLeft + labelWidth + 6,
      y: yPos,
      size: valueSize,
      font,
      color: rgb(0, 0, 0)
    });

    yPos -= lineHeight;
  });

  if (footerPath) {
    try {
      let logoBytes = await fs.promises.readFile(footerPath);
      const isBase64 = logoBytes.toString('utf8', 0, 8).startsWith('iVBORw0K');

      if (isBase64) {
        logoBytes = Buffer.from(logoBytes.toString('utf8'), 'base64');
      }

      const logoImage = await pdfDoc.embedPng(logoBytes);
      const logoDims = logoImage.scale(1);
      const footerWidth = width;
      const footerHeight = (logoDims.height / logoDims.width) * footerWidth;

      page.drawImage(logoImage, {
        x: 0,
        y: 0,
        width: footerWidth,
        height: footerHeight,
        opacity: 0.9
      });
    } catch {
      // Segue sem imagem de rodapé em caso de falha.
    }
  }

  const footerY = 80;
  page.drawText('Avenida Tucunaré 421', {
    x: marginLeft - 28,
    y: footerY,
    size: 7,
    font,
    color: rgb(0.36, 0.36, 0.36)
  });

  page.drawText('Tamboré • Barueri – SP', {
    x: marginLeft - 28,
    y: footerY - 10,
    size: 7,
    font,
    color: rgb(0.36, 0.36, 0.36)
  });

  page.drawText('CEP 06460-020', {
    x: marginLeft - 28,
    y: footerY - 20,
    size: 7,
    font,
    color: rgb(0.36, 0.36, 0.36)
  });

  page.drawText('+55 11 0000 0000', {
    x: marginLeft - 28,
    y: footerY - 30,
    size: 7,
    font,
    color: rgb(0.36, 0.36, 0.36)
  });

  page.drawText('www.opera.security', {
    x: marginLeft - 28,
    y: footerY - 40,
    size: 7,
    font,
    color: rgb(0.36, 0.36, 0.36)
  });

  page.drawText('Fo.22.1 - Rev.0', {
    x: width - 335,
    y: footerY - 10,
    size: 7,
    font,
    color: rgb(0.42, 0.42, 0.42)
  });

  return Buffer.from(await pdfDoc.save());
}

function formatJiraDate(rawDate) {
  if (!rawDate) return '';

  const dateOnly = String(rawDate).split('T')[0];
  const match = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (match) {
    const [, year, month, day] = match;
    return `${day}/${month}/${year}`;
  }

  return String(rawDate);
}

/**
 * Valida que a data está no formato YYYY-MM-DD aceito pela Jira API.
 * Retorna true também para null/undefined (limpar campo).
 */
function isValidJiraDate(date) {
  if (date === null || date === undefined) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const BLOCKED_REPORT_STATUS = 'RECEBIDO NAO LIBERADO';

function normalizeCardId(value) {
  return String(value || '').trim().toUpperCase();
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeRelativePath(value) {
  return toPosixPath(String(value || '').trim())
    .replace(/^\/+/, '')
    .replace(/\.\.(\/|$)/g, '');
}

function findCardDirectories(entries, cardId) {
  const normalizedCardId = normalizeCardId(cardId);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const exact = directories.filter((name) => normalizeCardId(name) === normalizedCardId);
  if (exact.length > 0) {
    return exact;
  }

  return directories.filter((name) => {
    const normalized = normalizeCardId(name);
    return normalized.startsWith(`${normalizedCardId} `)
      || normalized.startsWith(`${normalizedCardId}-`)
      || normalized.startsWith(`${normalizedCardId}_`)
      || normalized.includes(normalizedCardId);
  });
}

async function walkFiles(rootPath, currentRelative = '') {
  const currentPath = currentRelative ? path.join(rootPath, currentRelative) : rootPath;
  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
  const output = [];

  for (const entry of entries) {
    const relative = currentRelative ? path.join(currentRelative, entry.name) : entry.name;

    if (entry.isDirectory()) {
      const nested = await walkFiles(rootPath, relative);
      output.push(...nested);
      continue;
    }

    if (entry.isFile()) {
      output.push(relative);
    }
  }

  return output;
}

function createServerBaseUrl(req) {
  return `https://${req.get('host')}`;
}

function toLocalFileResult(req, cardId, dirName, relativeFilePath) {
  const baseUrl = createServerBaseUrl(req);
  const safeRelativePath = sanitizeRelativePath(relativeFilePath);
  const filename = path.basename(relativeFilePath);
  const ext = path.extname(filename).toLowerCase();

  return {
    url: `${baseUrl}/api/jira/download-arquivo/${encodeURIComponent(cardId)}/${encodeURIComponent(dirName)}/${encodeURIComponent(toPosixPath(safeRelativePath))}`,
    name: filename,
    cardId,
    extension: ext,
    isPdf: ext === '.pdf',
    source: 'local',
    relativePath: toPosixPath(path.join(dirName, safeRelativePath))
  };
}

function toJiraFileResult(req, cardId, attachment) {
  const baseUrl = createServerBaseUrl(req);
  const ext = path.extname(attachment.filename || '').toLowerCase();

  return {
    url: `${baseUrl}/api/jira/download-arquivo-jira/${encodeURIComponent(cardId)}/${encodeURIComponent(attachment.id)}/${encodeURIComponent(attachment.filename || 'arquivo')}`,
    name: attachment.filename,
    cardId,
    extension: ext,
    isPdf: ext === '.pdf',
    source: 'jira',
    size: attachment.size || 0,
    mimeType: attachment.mimeType || 'application/octet-stream'
  };
}

async function buscarArquivosNoJira(cardId, req, email, apiToken) {
  const jiraUrl = process.env.JIRA_URL;

  if (!jiraUrl || !email || !apiToken) {
    return [];
  }

  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const url = `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(cardId)}?fields=attachment`;

  try {
    const response = await axios.get(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${auth}`
      }
    });

    const attachments = response.data?.fields?.attachment;
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return [];
    }

    // Filtrar apenas PDFs
    return attachments
      .map((attachment) => toJiraFileResult(req, cardId, attachment))
      .filter((file) => file.isPdf);
  } catch (error) {
    // Retornar vazio silenciosamente para cards não encontrados
    if (error?.response?.status === 404) {
      return [];
    }
    // Log apenas para erros reais
    console.error(`❌ Jira erro: ${cardId}`);
    return [];
  }
}

function isBlockedReportStatus(statusName, situacao) {
  const normalizedStatus = normalizeText(statusName);
  const normalizedSituacao = normalizeText(situacao);

  return normalizedStatus.includes(BLOCKED_REPORT_STATUS)
    || normalizedSituacao.includes(BLOCKED_REPORT_STATUS);
}

/**
 * Busca issues do Jira com paginação
 */
export const getJiraIssues = async (req, res) => {
  try {
    console.log('🔍 Iniciando busca de issues do Jira...');
    console.log('👤 Usuário ID:', req.user.id);
    console.log('📧 Email do usuário:', req.user.email);

    // Buscar credenciais do usuário logado
    let credentials;
    try {
      credentials = await getUserJiraCredentials(req.user.id);
      console.log('✅ Credenciais recuperadas do banco');
      console.log('📧 Email Jira:', credentials.email);
      console.log('🔑 Token presente:', !!credentials.apiToken);
    } catch (credError) {
      console.error('❌ Erro ao buscar credenciais:', credError.message);
      return res.status(400).json({
        success: false,
        message: `Erro ao buscar credenciais: ${credError.message}`
      });
    }

    const { email, apiToken } = credentials;

    const jiraUrl = process.env.JIRA_URL;
    console.log('🌐 JIRA_URL configurado:', !!jiraUrl);
    console.log('🌐 JIRA_URL:', jiraUrl);

    if (!jiraUrl) {
      console.error('❌ JIRA_URL não configurado no .env do servidor');
      return res.status(500).json({
        success: false,
        message: 'JIRA_URL não configurado no servidor. Contate o administrador.'
      });
    }

    if (!email || !apiToken) {
      console.error('❌ Credenciais do usuário incompletas');
      return res.status(400).json({
        success: false,
        message: 'Credenciais do Jira não configuradas para seu usuário. Configure no perfil.'
      });
    }

    // Verificar se deve filtrar apenas issues sem data de previsão
    const semData = req.query.semData === 'true';
    const mantaBoard = String(req.query.mantaBoard || '').trim();

    // Filtro JQL base - incluindo "Recebido Não liberado" para TENSYLON
    const jqlMantaBase = '(project = MANTA AND status IN ("A Produzir") AND ("situação[short text]" ~ "🔴RECEBIDO NÃO LIBERADO" OR "situação[short text]" ~ "⚪️RECEBIDO ENCAMINHADO" OR "situação[short text]" ~ "⚫Aguardando entrada" OR "situação[short text]" ~ "🟢RECEBIDO LIBERADO"))';
    const jqlTensylonBase = '(project = TENSYLON AND status IN ("A Produzir") AND ("situação[short text]" ~ "🔴RECEBIDO NÃO LIBERADO" OR "situação[short text]" ~ "⚪️RECEBIDO ENCAMINHADO" OR "situação[short text]" ~ "⚫Aguardando entrada" OR "situação[short text]" ~ "🟢RECEBIDO LIBERADO"))';
    const escapedMantaBoard = mantaBoard.replace(/"/g, '\\"');
    const jqlMantaComBoard = mantaBoard
      ? `(project = MANTA AND "fábrica de manta[dropdown]" = "${escapedMantaBoard}" AND status IN ("A Produzir"))`
      : jqlMantaBase;

    let jql = `${jqlMantaComBoard} OR ${jqlTensylonBase}`;
    
    // Adicionar filtro de data vazia se solicitado
    if (semData) {
      jql = `(${jql}) AND customfield_10245 is EMPTY`;
    }

    const url = `${jiraUrl}/rest/api/3/search/jql`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    console.log(' URL:', url);
    console.log(' Email:', email);
    console.log(' Token presente:', !!apiToken);
    console.log(' JQL:', jql);
    console.log(' Filtro sem data:', semData);

    const situacoesValidas = [
      '⚪️RECEBIDO ENCAMINHADO',
      '🟢RECEBIDO LIBERADO',
      '⚫Aguardando entrada',
      '🔴RECEBIDO NÃO LIBERADO'
    ];

    let allIssues = [];
    let nextPageToken = null;
    let pageCount = 0;

    // Buscar todas as páginas via nextPageToken (mesma lógica do script Python)
    while (true) {
      pageCount++;
      console.log(`📄 [PÁGINA ${pageCount}] Buscando issues via nextPageToken...`);

      const params = {
        jql: jql,
        maxResults: 100,
        fields: [
          'issuetype',
          'summary',
          'status',
          'customfield_10039',
          'customfield_11298',
          'customfield_10245',
          'customfield_11353'
        ].join(',')
      };

      if (nextPageToken) {
        params.nextPageToken = nextPageToken;
      }

      const response = await axios.get(url, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${auth}`
        },
        params
      });

      const issues = response.data.issues || [];
      const isLast = !!response.data.isLast;

      console.log(`✅ [PÁGINA ${pageCount}] Recebidas ${issues.length} issues`);
      console.log(`📊 [PÁGINA ${pageCount}] Acumuladas até agora: ${allIssues.length + issues.length}`);

      allIssues = [...allIssues, ...issues];

      if (isLast) {
        break;
      }

      nextPageToken = response.data.nextPageToken || null;
      if (!nextPageToken) {
        console.log('⚠️ nextPageToken ausente; encerrando paginação para evitar loop.');
        break;
      }
    }

    console.log(`✅ Paginação concluída! ${pageCount} páginas processadas`);
    console.log(`🎯 Total de issues coletadas: ${allIssues.length}`);

    // Processar issues com filtro de SITUAÇÃO (igual ao script de referência)
    const processedData = [];
    let skippedBySituacao = 0;
    
    for (const issue of allIssues) {
      const fields = issue.fields;
      const key = issue.key;

      // SITUAÇÃO
      let situacao = '';
      const situacaoRaw = fields.customfield_10039;
      if (situacaoRaw && typeof situacaoRaw === 'object' && situacaoRaw.value) {
        situacao = situacaoRaw.value;
      } else if (situacaoRaw) {
        situacao = situacaoRaw;
      }

      if (!situacoesValidas.includes(situacao)) {
        skippedBySituacao++;
        continue;
      }

      const statusName = fields.status?.name || '';

      // VEÍCULO
      let veiculo = '';
      const veiculoRaw = fields.customfield_11298;
      if (veiculoRaw && typeof veiculoRaw === 'object' && veiculoRaw.value) {
        veiculo = veiculoRaw.value;
      } else if (veiculoRaw) {
        veiculo = veiculoRaw;
      }

      // DATA PREVISÃO
      let previsao = '';
      const previsaoRaw = fields.customfield_10245;
      if (previsaoRaw) {
        previsao = formatJiraDate(previsaoRaw);
      }

      // NÚMERO DO PROJETO
      let numeroProjeto = '';
      const numeroProjetoRaw = fields.customfield_11353;
      if (numeroProjetoRaw && typeof numeroProjetoRaw === 'object' && numeroProjetoRaw.value) {
        numeroProjeto = String(numeroProjetoRaw.value).trim();
      } else if (numeroProjetoRaw) {
        numeroProjeto = String(numeroProjetoRaw).trim();
      }

      if (!numeroProjeto) {
        const resumoValue = String(fields.summary || '').trim();
        const projetoMatch = resumoValue.match(/\b[A-Z]\d{1,2}\.\d{6,8}\.[A-Z]{2}\b/i);
        numeroProjeto = projetoMatch ? projetoMatch[0].toUpperCase() : '';
      }

      // Extrair número do resumo (se houver)
      const resumoTexto = fields.summary || '';
      const numerosEncontrados = resumoTexto.match(/\d+/g);
      const resumoNumero = numerosEncontrados ? parseInt(numerosEncontrados[0], 10) : 0;

      processedData.push({
        key: key,
        resumo: resumoNumero,
        status: statusName,
        situacao: situacao,
        veiculo: veiculo,
        previsao: previsao,
        numeroProjeto: numeroProjeto || '-'
      });
    }

    console.log(`⛔ Issues removidas por SITUAÇÃO fora da lista: ${skippedBySituacao}`);
    console.log(`✅ Issues filtradas: ${processedData.length}`);

    // Ordenar: priorizar veículos com marcas especiais (Land Rover, Toyota, Jaguar)
    const marcasDestaque = ['land rover', 'toyota', 'jaguar'];
    
    processedData.sort((a, b) => {
      const veiculoA = (a.veiculo || '').toLowerCase();
      const veiculoB = (b.veiculo || '').toLowerCase();
      
      const temMarcaA = marcasDestaque.some(marca => veiculoA.includes(marca));
      const temMarcaB = marcasDestaque.some(marca => veiculoB.includes(marca));
      
      // Se A tem marca e B não, A vem primeiro
      if (temMarcaA && !temMarcaB) return -1;
      // Se B tem marca e A não, B vem primei ro
      if (!temMarcaA && temMarcaB) return 1;
      
      // Se ambos têm ou ambos não têm marcas, ordenar alfabeticamente por veículo
      return veiculoA.localeCompare(veiculoB);
    });

    console.log(`🔄 Issues ordenadas (prioritárias no topo + ordem alfabética)`);

    return res.json({
      success: true,
      total: allIssues.length,
      filtered: processedData.length,
      data: processedData
    });

  } catch (error) {
    console.error('❌ Erro ao buscar issues do Jira:', error.message);
    console.error('❌ Nome do erro:', error.name);
    console.error('❌ Stack:', error.stack);
    
    // Erro da API do Jira
    if (error.response) {
      console.error('❌ Response status:', error.response.status);
      console.error('❌ Response statusText:', error.response.statusText);
      console.error('❌ Response data:', JSON.stringify(error.response.data, null, 2));
      
      return res.status(error.response.status).json({
        success: false,
        message: `Erro na API do Jira (${error.response.status}): ${error.response.data?.errorMessages?.[0] || error.response.statusText}`,
        details: error.response.data
      });
    }
    
    // Erro de rede ou timeout
    if (error.request) {
      console.error('❌ Nenhuma resposta recebida do Jira');
      console.error('❌ Request:', error.request);
      
      return res.status(503).json({
        success: false,
        message: 'Não foi possível conectar ao Jira. Verifique a URL e a conexão de rede.'
      });
    }
    
    // Outros erros
    return res.status(500).json({
      success: false,
      message: 'Erro ao buscar dados do Jira: ' + error.message
    });
  }
};

/**
 * Busca issues do Jira apenas com marcas CONTEC (Land Rover, Toyota, Jaguar)
 */
export const getContecIssues = async (req, res) => {
  try {
    console.log('🔍 Iniciando busca de issues CONTEC do Jira...');
    console.log('👤 Usuário ID:', req.user.id);
    console.log('📧 Email do usuário:', req.user.email);

    // Buscar credenciais do usuário logado
    let credentials;
    try {
      credentials = await getUserJiraCredentials(req.user.id);
      console.log('✅ Credenciais CONTEC recuperadas do banco');
      console.log('📧 Email Jira:', credentials.email);
      console.log('🔑 Token presente:', !!credentials.apiToken);
    } catch (credError) {
      console.error('❌ Erro ao buscar credenciais CONTEC:', credError.message);
      return res.status(400).json({
        success: false,
        message: `Erro ao buscar credenciais: ${credError.message}`
      });
    }

    const { email, apiToken } = credentials;

    const jiraUrl = process.env.JIRA_URL;
    console.log('🌐 JIRA_URL configurado:', !!jiraUrl);
    console.log('🌐 JIRA_URL:', jiraUrl);

    if (!jiraUrl) {
      console.error('❌ JIRA_URL não configurado no .env do servidor');
      return res.status(500).json({
        success: false,
        message: 'JIRA_URL não configurado no servidor. Contate o administrador.'
      });
    }

    if (!email || !apiToken) {
      console.error('❌ Credenciais do usuário incompletas');
      return res.status(400).json({
        success: false,
        message: 'Credenciais do Jira não configuradas para seu usuário. Configure no perfil.'
      });
    }

    // Filtro JQL
    const jql = '(project = MANTA AND status IN ("A Produzir", "Liberado Engenharia")) OR (project = TENSYLON AND status IN ("A Produzir", "Liberado Engenharia", "Aguardando Acabamento", "Aguardando Autoclave", "Aguardando Corte", "Aguardando montagem", "🔴RECEBIDO NÃO LIBERADO"))';

    const url = `${jiraUrl}/rest/api/3/search/jql`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    console.log('📡 [CONTEC] URL:', url);
    console.log('📧 [CONTEC] Email:', email);
    console.log('🔑 [CONTEC] Token presente:', !!apiToken);
    console.log('🔍 [CONTEC] JQL:', jql);

    const situacoesValidas = [
      '⚪️RECEBIDO ENCAMINHADO',
      '🟢RECEBIDO LIBERADO',
      '⚫Aguardando entrada',
      '🔴RECEBIDO NÃO LIBERADO'
    ];

    let allIssues = [];
    let nextPageToken = null;
    let pageCount = 0;

    // Buscar todas as páginas via nextPageToken
    while (true) {
      pageCount++;
      console.log(`📄 [CONTEC PÁGINA ${pageCount}] Buscando issues via nextPageToken...`);

      const params = {
        jql: jql,
        maxResults: 100,
        fields: [
          'issuetype',
          'summary',
          'status',
          'customfield_10039',
          'customfield_11298',
          'customfield_10245'
        ].join(',')
      };

      if (nextPageToken) {
        params.nextPageToken = nextPageToken;
      }

      const response = await axios.get(url, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${auth}`
        },
        params
      });

      const issues = response.data.issues || [];
      const isLast = !!response.data.isLast;

      console.log(`✅ [CONTEC PÁGINA ${pageCount}] Recebidas ${issues.length} issues`);
      console.log(`📊 [CONTEC PÁGINA ${pageCount}] Acumuladas até agora: ${allIssues.length + issues.length}`);

      allIssues = [...allIssues, ...issues];

      if (isLast) {
        break;
      }

      nextPageToken = response.data.nextPageToken || null;
      if (!nextPageToken) {
        console.log('⚠️ [CONTEC] nextPageToken ausente; encerrando paginação para evitar loop.');
        break;
      }
    }

    console.log(`✅ [CONTEC] Paginação concluída! ${pageCount} páginas processadas`);
    console.log(`🎯 [CONTEC] Total de issues coletadas: ${allIssues.length}`);

    // Marcas CONTEC que devem ser filtradas
    const marcasContec = ['land rover', 'toyota', 'jaguar'];

    // Processar e filtrar issues (SITUAÇÃO válida + marca CONTEC)
    const processedData = [];
    let skippedByStatus = 0;
    let skippedBySituacao = 0;
    
    for (const issue of allIssues) {
      const fields = issue.fields;
      const key = issue.key;

      // SITUAÇÃO
      let situacao = '';
      const situacaoRaw = fields.customfield_10039;
      if (situacaoRaw && typeof situacaoRaw === 'object' && situacaoRaw.value) {
        situacao = situacaoRaw.value;
      } else if (situacaoRaw) {
        situacao = situacaoRaw;
      }

      if (!situacoesValidas.includes(situacao)) {
        skippedBySituacao++;
        continue;
      }

      const statusName = fields.status?.name || '';

      if (isBlockedReportStatus(statusName, situacao)) {
        skippedByStatus++;
        continue;
      }

      // VEÍCULO
      let veiculo = '';
      const veiculoRaw = fields.customfield_11298;
      if (veiculoRaw && typeof veiculoRaw === 'object' && veiculoRaw.value) {
        veiculo = veiculoRaw.value;
      } else if (veiculoRaw) {
        veiculo = veiculoRaw;
      }

      // Filtrar apenas marcas CONTEC
      const veiculoLower = veiculo.toLowerCase();
      const temMarcaContec = marcasContec.some(marca => veiculoLower.includes(marca));
      
      if (!temMarcaContec) {
        continue; // Pular se não for marca CONTEC
      }

      // DATA PREVISÃO
      let previsao = '';
      const previsaoRaw = fields.customfield_10245;
      if (previsaoRaw) {
        previsao = formatJiraDate(previsaoRaw);
      }

      // Extrair número do resumo (se houver)
      const resumoTexto = fields.summary || '';
      const numerosEncontrados = resumoTexto.match(/\d+/g);
      const resumoNumero = numerosEncontrados ? parseInt(numerosEncontrados[0], 10) : 0;

      processedData.push({
        key: key,
        resumo: resumoNumero,
        status: statusName,
        situacao: situacao,
        veiculo: veiculo,
        previsao: previsao
      });
    }

    console.log(`⛔ [CONTEC] Issues removidas por status bloqueado: ${skippedByStatus}`);
    console.log(`⛔ [CONTEC] Issues removidas por SITUAÇÃO fora da lista: ${skippedBySituacao}`);
    console.log(`✅ Issues CONTEC filtradas: ${processedData.length}`);

    // Ordenar alfabeticamente por veículo
    processedData.sort((a, b) => {
      const veiculoA = (a.veiculo || '').toLowerCase();
      const veiculoB = (b.veiculo || '').toLowerCase();
      return veiculoA.localeCompare(veiculoB);
    });

    console.log(`🔄 Issues CONTEC ordenadas alfabeticamente`);

    return res.json({
      success: true,
      total: allIssues.length,
      filtered: processedData.length,
      data: processedData
    });

  } catch (error) {
    console.error('❌ Erro ao buscar issues CONTEC do Jira:', error.message);
    console.error('❌ Nome do erro:', error.name);
    console.error('❌ Stack:', error.stack);
    
    // Erro da API do Jira
    if (error.response) {
      console.error('❌ Response status:', error.response.status);
      console.error('❌ Response statusText:', error.response.statusText);
      console.error('❌ Response data:', JSON.stringify(error.response.data, null, 2));
      
      return res.status(error.response.status).json({
        success: false,
        message: `Erro na API do Jira (${error.response.status}): ${error.response.data?.errorMessages?.[0] || error.response.statusText}`,
        details: error.response.data
      });
    }
    
    // Erro de rede ou timeout
    if (error.request) {
      console.error('❌ Nenhuma resposta recebida do Jira');
      console.error('❌ Request:', error.request);
      
      return res.status(503).json({
        success: false,
        message: 'Não foi possível conectar ao Jira. Verifique a URL e a conexão de rede.'
      });
    }
    
    // Outros erros
    return res.status(500).json({
      success: false,
      message: 'Erro ao buscar dados CONTEC do Jira: ' + error.message
    });
  }
};

/**
 * Reprograma múltiplas issues do Jira com nova data de previsão
 */
export const reprogramarEmMassa = async (req, res) => {
  console.log('🎯 ============================================');
  console.log('🎯 ENDPOINT /reprogramar-massa INICIADO');
  console.log('🎯 ============================================');
  
  try {
    console.log('🚀 Iniciando reprogramação em massa...');

    // Buscar credenciais do usuário logado
    const credentials = await getUserJiraCredentials(req.user.id);
    const { email, apiToken } = credentials;

    const JIRA_UPDATE_TIMEOUT_MS = 45000; // 45 segundos por card

    const { ids, date } = req.body;
    
    console.log('📦 Body recebido:', { ids, date });

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Lista de IDs é obrigatória e deve ser um array não vazio'
      });
    }

    // Data pode ser null para limpar o campo no Jira (null/undefined limpa; string deve ser YYYY-MM-DD)
    const dateValue = date ?? null;

    if (!isValidJiraDate(dateValue)) {
      return res.status(400).json({
        success: false,
        message: `Formato de data inválido: "${date}". Use YYYY-MM-DD ou envie null para limpar.`
      });
    }

    const jiraUrl = process.env.JIRA_URL;
    const campoPrevisao = 'customfield_10245';

    if (!jiraUrl || !email || !apiToken) {
      console.error('❌ Credenciais do Jira não configuradas');
      return res.status(500).json({
        success: false,
        message: 'Credenciais do Jira não configuradas no servidor'
      });
    }

    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    console.log('📅 Nova previsão:', dateValue === null ? '(LIMPAR CAMPO)' : dateValue);
    console.log('📋 IDs para atualizar:', ids.length);
    ids.forEach(id => console.log(`   • ${id}`));

    let successCount = 0;
    let errorCount = 0;
    const results = [];

    // Atualizar cada issue
    for (const issueId of ids) {
      try {
        console.log(`🔄 Processando ${issueId}...`);
        const url = `${jiraUrl}/rest/api/3/issue/${issueId}`;
        
        const response = await axios.put(
          url,
          {
            fields: {
              [campoPrevisao]: dateValue
            }
          },
          {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': `Basic ${auth}`
            },
            timeout: JIRA_UPDATE_TIMEOUT_MS
          }
        );

        if (response.status === 204 || response.status === 200) {
          successCount++;
          const msg = dateValue ? `atualizado para ${dateValue}` : 'data limpa';
          console.log(`✅ ${issueId} ${msg}`);
          results.push({
            id: issueId,
            success: true,
            message: dateValue ? `Atualizado para ${dateValue}` : 'Data limpa'
          });
        } else {
          errorCount++;
          console.log(`❌ ${issueId} falhou (${response.status})`);
          results.push({
            id: issueId,
            success: false,
            message: `Falhou com status ${response.status}`
          });
        }
      } catch (error) {
        errorCount++;
        const errorMessage =
          error.code === 'ECONNABORTED'
            ? `Timeout ao atualizar issue após ${JIRA_UPDATE_TIMEOUT_MS / 1000}s`
            : (error.response?.data?.errorMessages?.join(', ') || error.message);
        console.log(`❌ ${issueId} erro: ${errorMessage}`);
        results.push({
          id: issueId,
          success: false,
          message: errorMessage
        });
      }
    }

    console.log('='.repeat(60));
    console.log('REPROGRAMAÇÃO FINALIZADA');
    console.log(`✅ Sucesso: ${successCount}`);
    console.log(`❌ Erros: ${errorCount}`);
    console.log('='.repeat(60));

    const allSuccess = errorCount === 0;
    const partialSuccess = successCount > 0 && errorCount > 0;
    const httpStatus = allSuccess ? 200 : partialSuccess ? 207 : 422;

    const responseData = {
      success: allSuccess,
      partial: partialSuccess,
      message: allSuccess
        ? `${successCount} card(s) reprogramado(s) com sucesso.`
        : partialSuccess
          ? `Parcial: ${successCount} atualizado(s), ${errorCount} com falha.`
          : `Falha: nenhum card foi atualizado (${errorCount} erro(s)).`,
      data: {
        successCount,
        errorCount,
        total: ids.length,
        results
      }
    };

    console.log(`📡 [RESPONSE] Enviando HTTP ${httpStatus}...`);
    res.status(httpStatus).json(responseData);
    console.log('🎯 ENDPOINT /reprogramar-massa FINALIZADO');

  } catch (error) {
    console.error('❌ [ERROR] Erro na reprogramação em massa:', error);
    console.error('❌ [ERROR] Stack:', error.stack);
    
    const errorResponse = {
      success: false,
      message: 'Erro ao reprogramar issues: ' + error.message
    };
    
    console.log('📤 [ERROR] Enviando resposta de erro...');
    res.status(500).json(errorResponse);
    console.log('📤 [ERROR] Resposta de erro enviada');
  }
};

/**
 * Atualiza datas de previsão individuais para múltiplos cards
 * Cada card pode ter uma data diferente
 */
export const atualizarDatasIndividuais = async (req, res) => {
  console.log('🎯 ============================================');
  console.log('🎯 ENDPOINT /atualizar-datas-individuais INICIADO');
  console.log('🎯 ============================================');
  
  try {
    console.log('🚀 Iniciando atualização de datas individuais...');

    const JIRA_UPDATE_TIMEOUT_MS = 45000; // 45 segundos por card

    const { updates } = req.body;
    
    console.log('📦 Body recebido:', { updates });

    // Validar formato: [{id: "CARD-123", date: "2024-03-15"}, ...]
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Lista de updates é obrigatória e deve ser um array não vazio com formato [{id, date}, ...]'
      });
    }

    // Buscar credenciais do usuário logado
    const credentials = await getUserJiraCredentials(req.user.id);
    const { email, apiToken } = credentials;

    const jiraUrl = process.env.JIRA_URL;
    const campoPrevisao = 'customfield_10245';

    if (!jiraUrl || !email || !apiToken) {
      console.error('❌ Credenciais do Jira não configuradas');
      return res.status(500).json({
        success: false,
        message: 'Credenciais do Jira não configuradas no servidor'
      });
    }

    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    console.log('📋 Updates para processar:', updates.length);
    updates.forEach(update => console.log(`   • ${update.id} → ${update.date || '(LIMPAR)'}`));

    let successCount = 0;
    let errorCount = 0;
    const results = [];

    // Atualizar cada issue individualmente
    for (const update of updates) {
      const { id: issueId, date: dateValue } = update;
      
      if (!issueId) {
        console.log(`⚠️ Update sem ID, pulando:`, update);
        errorCount++;
        results.push({ id: 'UNKNOWN', success: false, message: 'ID não fornecido' });
        continue;
      }

      if (!isValidJiraDate(dateValue ?? null)) {
        console.log(`⚠️ ${issueId}: data inválida "${dateValue}"`);
        errorCount++;
        results.push({
          id: issueId,
          success: false,
          message: `Formato de data inválido: "${dateValue}". Use YYYY-MM-DD.`
        });
        continue;
      }

      try {
        console.log(`🔄 Processando ${issueId} → ${dateValue || '(limpar)'}...`);
        const url = `${jiraUrl}/rest/api/3/issue/${issueId}`;
        
        const response = await axios.put(
          url,
          {
            fields: {
              [campoPrevisao]: dateValue || null
            }
          },
          {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': `Basic ${auth}`
            },
            timeout: JIRA_UPDATE_TIMEOUT_MS
          }
        );

        if (response.status === 204 || response.status === 200) {
          successCount++;
          const msg = dateValue ? `atualizado para ${dateValue}` : 'data limpa';
          console.log(`✅ ${issueId} ${msg}`);
          results.push({
            id: issueId,
            success: true,
            message: dateValue ? `Atualizado para ${dateValue}` : 'Data limpa'
          });
        } else {
          errorCount++;
          console.log(`❌ ${issueId} falhou (${response.status})`);
          results.push({
            id: issueId,
            success: false,
            message: `Falhou com status ${response.status}`
          });
        }
      } catch (error) {
        errorCount++;
        const errorMessage =
          error.code === 'ECONNABORTED'
            ? `Timeout ao atualizar issue após ${JIRA_UPDATE_TIMEOUT_MS / 1000}s`
            : (error.response?.data?.errorMessages?.join(', ') || error.message);
        console.log(`❌ ${issueId} erro: ${errorMessage}`);
        results.push({
          id: issueId,
          success: false,
          message: errorMessage
        });
      }
    }

    console.log('='.repeat(60));
    console.log('ATUALIZAÇÃO DE DATAS INDIVIDUAIS FINALIZADA');
    console.log(`✅ Sucesso: ${successCount}`);
    console.log(`❌ Erros: ${errorCount}`);
    console.log('='.repeat(60));

    const allSuccess = errorCount === 0;
    const partialSuccess = successCount > 0 && errorCount > 0;
    const httpStatus = allSuccess ? 200 : partialSuccess ? 207 : 422;

    const responseData = {
      success: allSuccess,
      partial: partialSuccess,
      message: allSuccess
        ? `${successCount} data(s) atualizada(s) com sucesso.`
        : partialSuccess
          ? `Parcial: ${successCount} atualizada(s), ${errorCount} com falha.`
          : `Falha: nenhuma data foi atualizada (${errorCount} erro(s)).`,
      data: {
        successCount,
        errorCount,
        total: updates.length,
        results
      }
    };

    console.log(`📡 [RESPONSE] Enviando HTTP ${httpStatus}...`);
    res.status(httpStatus).json(responseData);
    console.log('🎯 ENDPOINT /atualizar-datas-individuais FINALIZADO');

  } catch (error) {
    console.error('❌ [ERROR] Erro na atualização de datas individuais:', error);
    console.error('❌ [ERROR] Stack:', error.stack);
    
    const errorResponse = {
      success: false,
      message: 'Erro ao atualizar datas: ' + error.message
    };
    
    console.log('📤 [ERROR] Enviando resposta de erro...');
    res.status(500).json(errorResponse);
    console.log('📤 [ERROR] Resposta de erro enviada');
  }
};

/**
 * Busca todos os PDFs por IDs dos cards (filtrados por extensão .pdf)
 */
export const buscarArquivosPorIds = async (req, res) => {
  console.log('🔍 ============================================');
  console.log('🔍 ENDPOINT /buscar-arquivos (PDFs) INICIADO');
  console.log('🔍 ============================================');
  
  try {
    const { ids } = req.body;
    
    console.log('📦 Body recebido:', { ids });

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Lista de IDs é obrigatória e deve ser um array não vazio'
      });
    }

    // Buscar credenciais do usuário logado
    const credentials = await getUserJiraCredentials(req.user.id);
    const { email, apiToken } = credentials;

    // Diretório base onde estão os arquivos locais
    const basePdfPath = process.env.PDF_BASE_PATH || 'C:\\OPs';
    console.log(`📁 Buscando PDFs para ${ids.length} cards em: ${basePdfPath}`);
    
    const foundFiles = [];
    const startTime = Date.now();

    let basePathEntries = null;
    try {
      basePathEntries = await fs.promises.readdir(basePdfPath, { withFileTypes: true });
    } catch (error) {
      console.log('⚠️ Diretório local não acessível. Busca apenas no Jira.');
    }

    // Buscar arquivos para cada ID em paralelo (local + Jira)
    const searchPromises = ids.map(async (cardId) => {
      try {
        let localFiles = [];
        if (basePathEntries) {
          const matchingDirs = findCardDirectories(basePathEntries, cardId);

          if (matchingDirs.length > 0) {
            for (const dirName of matchingDirs) {
              const absoluteDir = path.join(basePdfPath, dirName);
              const files = await walkFiles(absoluteDir);
              files.forEach((relativeFile) => {
                const fileResult = toLocalFileResult(req, cardId, dirName, relativeFile);
                // Filtrar apenas PDFs
                if (fileResult.isPdf) {
                  localFiles.push(fileResult);
                }
              });
            }
          }
        }

        const jiraFiles = await buscarArquivosNoJira(cardId, req, email, apiToken);

        const dedupeMap = new Map();
        [...localFiles, ...jiraFiles].forEach((file) => {
          const key = `${normalizeCardId(file.cardId)}|${normalizeCardId(file.name)}|${file.size || 0}`;
          if (!dedupeMap.has(key)) {
            dedupeMap.set(key, file);
          }
        });

        return Array.from(dedupeMap.values());
      } catch (error) {
        console.error(`❌ Erro: ${cardId} - ${error.message}`);
        return [];
      }
    });

    // Aguardar todas as buscas em paralelo
    const results = await Promise.all(searchPromises);
    results.forEach(files => foundFiles.push(...files));

    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`⚡ Busca concluída: ${foundFiles.length} PDFs encontrados em ${elapsedTime}s`);

    const responseData = {
      success: true,
      count: foundFiles.length,
      files: foundFiles
    };

    res.status(200).json(responseData);

  } catch (error) {
    console.error('❌ [ERROR] Erro ao buscar PDFs:', error);
    console.error('❌ [ERROR] Stack:', error.stack);
    
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar PDFs: ' + error.message
    });
  }
};

/**
 * Mescla PDFs de múltiplos cards e retorna um único PDF para impressão
 */
export const imprimirOpsPorIds = async (req, res) => {
  console.log('🖨️ ============================================');
  console.log('🖨️ ENDPOINT /imprimir-ops INICIADO');
  console.log('🖨️ ============================================');

  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Lista de IDs é obrigatória e deve ser um array não vazio'
      });
    }

    const credentials = await getUserJiraCredentials(req.user.id);
    const { email, apiToken } = credentials;

    const basePdfPath = process.env.PDF_BASE_PATH || 'C:\\OPs';
    const jiraUrl = process.env.JIRA_URL;
    const auth = (email && apiToken) ? Buffer.from(`${email}:${apiToken}`).toString('base64') : null;

    console.log(`📁 Mesclando PDFs para ${ids.length} cards`);

    let basePathEntries = null;
    try {
      basePathEntries = await fs.promises.readdir(basePdfPath, { withFileTypes: true });
    } catch {
      console.log('⚠️ Diretório local não acessível. Busca apenas no Jira.');
    }

    // Coleta entradas com caminhos reais (sem gerar URLs)
    const pdfEntries = [];
    const errors = [];

    await Promise.all(ids.map(async (cardId) => {
      try {
        // Arquivos locais
        if (basePathEntries) {
          const matchingDirs = findCardDirectories(basePathEntries, cardId);
          for (const dirName of matchingDirs) {
            const absoluteDir = path.join(basePdfPath, dirName);
            const files = await walkFiles(absoluteDir);
            for (const relFile of files) {
              if (path.extname(relFile).toLowerCase() === '.pdf') {
                pdfEntries.push({
                  cardId,
                  name: path.basename(relFile),
                  source: 'local',
                  absolutePath: path.join(absoluteDir, relFile)
                });
              }
            }
          }
        }

        // Anexos do Jira
        if (jiraUrl && auth) {
          try {
            const response = await axios.get(
              `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(cardId)}?fields=attachment`,
              { headers: { Accept: 'application/json', Authorization: `Basic ${auth}` } }
            );
            const attachments = response.data?.fields?.attachment || [];
            for (const att of attachments) {
              if (path.extname(att.filename || '').toLowerCase() === '.pdf') {
                pdfEntries.push({
                  cardId,
                  name: att.filename,
                  source: 'jira',
                  contentUrl: att.content,
                  size: att.size || 0
                });
              }
            }
          } catch (err) {
            if (err?.response?.status !== 404) {
              console.error(`❌ Jira erro ${cardId}:`, err.message);
            }
          }
        }
      } catch (err) {
        console.error(`❌ Erro ao buscar card ${cardId}:`, err.message);
        errors.push({ cardId, name: '-', message: err.message });
      }
    }));

    // Deduplicar
    const dedupMap = new Map();
    pdfEntries.forEach((entry) => {
      const key = `${normalizeCardId(entry.cardId)}|${normalizeCardId(entry.name)}|${entry.size || 0}`;
      if (!dedupMap.has(key)) dedupMap.set(key, entry);
    });
    const uniqueEntries = Array.from(dedupMap.values());

    // Identifica cards que não tiveram nenhum PDF encontrado (nem local nem Jira).
    const cardsWithPdf = new Set(uniqueEntries.map((e) => normalizeCardId(e.cardId)));
    for (const id of ids) {
      if (!cardsWithPdf.has(normalizeCardId(id))) {
        errors.push({ cardId: id, name: '-', message: 'Card sem PDF disponível' });
      }
    }

    if (uniqueEntries.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Nenhum PDF encontrado para os cards informados.',
        errors
      });
    }

    console.log(`📄 ${uniqueEntries.length} PDFs encontrados. Iniciando mesclagem com regras duplex...`);

    // Agrupa entradas por cardId preservando a ordem dos IDs solicitados
    const entriesByCard = new Map();
    ids.forEach((id) => entriesByCard.set(normalizeCardId(id), []));
    uniqueEntries.forEach((entry) => {
      const key = normalizeCardId(entry.cardId);
      if (!entriesByCard.has(key)) entriesByCard.set(key, []);
      entriesByCard.get(key).push(entry);
    });

    // PDF final — cada card entra já tratado para duplex
    const merged = await PDFDocument.create();

    for (const [cardKey, entries] of entriesByCard) {
      if (!entries.length) continue;

      // 1. Une todos os arquivos do card em um PDF intermediário
      const intermediate = await PDFDocument.create();
      for (const entry of entries) {
        try {
          let buf;
          if (entry.source === 'local') {
            buf = await fs.promises.readFile(entry.absolutePath);
          } else {
            const fileRes = await axios.get(entry.contentUrl, {
              responseType: 'arraybuffer',
              headers: { Authorization: `Basic ${auth}` }
            });
            buf = Buffer.from(fileRes.data);
          }
          const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
          const pages = await intermediate.copyPages(doc, doc.getPageIndices());
          pages.forEach((p) => intermediate.addPage(p));
          console.log(`✅ Lido: ${entry.cardId}/${entry.name}`);
        } catch (err) {
          console.error(`❌ PDF inválido: ${entry.cardId}/${entry.name} - ${err.message}`);
          errors.push({ cardId: entry.cardId, name: entry.name, message: err.message });
        }
      }

      if (intermediate.getPageCount() === 0) continue;

      // 2. Aplica regra de impressão frente-e-verso neste card
      //    → se ímpar, insere página em branco na posição 2 (verso da capa)
      const intermediateBytes = await intermediate.save();
      const duplexBytes = await prepararCardParaDuplex(intermediateBytes);
      const duplexDoc = await PDFDocument.load(duplexBytes, { ignoreEncryption: true });

      // 3. Copia as páginas tratadas para o PDF final
      const pages = await merged.copyPages(duplexDoc, duplexDoc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
      console.log(`🖨️ Card ${cardKey}: ${duplexDoc.getPageCount()} pág. (duplex aplicado)`);
    }

    if (merged.getPageCount() === 0) {
      return res.status(400).json({
        success: false,
        message: 'Todos os PDFs encontrados estão corrompidos ou inválidos.',
        errors
      });
    }

    const pdfBytes = await merged.save();
    console.log(`🖨️ PDF final: ${merged.getPageCount()} páginas, ${errors.length} erro(s)`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="ops-impressao-${Date.now()}.pdf"`);
    res.setHeader('X-Print-Errors', JSON.stringify(errors));
    res.setHeader('Access-Control-Expose-Headers', 'X-Print-Errors');
    res.send(Buffer.from(pdfBytes));

  } catch (error) {
    console.error('❌ Erro ao mesclar PDFs para impressão:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao mesclar PDFs: ' + error.message
    });
  }
};

/**
 * Faz download de um arquivo específico
 */
export const downloadArquivo = async (req, res) => {
  try {
    const { cardId, directory } = req.params;
    const rawRelativeFilePath = req.params[0] || '';
    const safeRelativePath = sanitizeRelativePath(decodeURIComponent(rawRelativeFilePath));
    const safeDirectory = decodeURIComponent(directory || '');
    
    console.log(`📥 Download solicitado: ${cardId}/${safeDirectory}/${safeRelativePath}`);

    const basePdfPath = process.env.PDF_BASE_PATH || 'C:\\OPs';
    const filePath = path.join(basePdfPath, safeDirectory, safeRelativePath);

    console.log(`📁 Caminho completo: ${filePath}`);

    // Verificar se o arquivo existe
    if (!fs.existsSync(filePath)) {
      console.log('❌ Arquivo não encontrado');
      return res.status(404).json({
        success: false,
        message: 'Arquivo não encontrado'
      });
    }

    // Enviar arquivo
    console.log('✅ Enviando arquivo...');
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('❌ Erro ao enviar arquivo:', err);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Erro ao enviar arquivo'
          });
        }
      } else {
        console.log('✅ Arquivo enviado com sucesso');
      }
    });

  } catch (error) {
    console.error('❌ Erro ao fazer download do arquivo:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao fazer download: ' + error.message
    });
  }
};

/**
 * Faz proxy de download de anexo do Jira
 */
export const downloadArquivoJira = async (req, res) => {
  try {
    const { cardId, attachmentId, filename } = req.params;
    
    // Buscar credenciais do usuário logado
    const credentials = await getUserJiraCredentials(req.user.id);
    const { email, apiToken } = credentials;
    
    const jiraUrl = process.env.JIRA_URL;

    if (!jiraUrl || !email || !apiToken) {
      return res.status(500).json({
        success: false,
        message: 'Credenciais do Jira não configuradas no servidor'
      });
    }

    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const issueUrl = `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(cardId)}?fields=attachment`;

    const issueResponse = await axios.get(issueUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${auth}`
      }
    });

    const attachments = issueResponse.data?.fields?.attachment || [];
    const target = attachments.find((item) => String(item.id) === String(attachmentId));

    if (!target?.content) {
      return res.status(404).json({
        success: false,
        message: 'Anexo não encontrado no Jira'
      });
    }

    const fileResponse = await axios.get(target.content, {
      responseType: 'stream',
      headers: {
        Authorization: `Basic ${auth}`
      }
    });

    const downloadName = target.filename || decodeURIComponent(filename || 'arquivo');
    const contentType = target.mimeType || fileResponse.headers['content-type'] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

    fileResponse.data.pipe(res);
  } catch (error) {
    console.error('❌ Erro ao baixar anexo do Jira:', error.message);
    res.status(500).json({
      success: false,
      message: 'Erro ao baixar anexo do Jira: ' + error.message
    });
  }
};

/**
 * Busca campos específicos de um card Jira para geração de espelho.
 */
async function buscarDadosCardEspelho(cardId, email, apiToken) {
  const fieldToString = (value) => {
    if (value === null || value === undefined) {
      return '';
    }

    if (Array.isArray(value)) {
      return value
        .map((item) => fieldToString(item))
        .filter((item) => item.length > 0)
        .join(', ');
    }

    if (typeof value === 'object') {
      const preferredKeys = ['value', 'name', 'displayName', 'key', 'id'];
      for (const key of preferredKeys) {
        const nested = fieldToString(value[key]);
        if (nested) {
          return nested;
        }
      }

      return '';
    }

    return String(value).trim();
  };

  const pickField = (fields, keys, fallback = '') => {
    for (const key of keys) {
      const parsed = fieldToString(fields[key]);
      if (parsed) {
        return parsed;
      }
    }
    return fallback;
  };

  const extractOrderNumber = (fields, cardId) => {
    const direct = fieldToString(fields.customfield_10040);
    if (direct) {
      const match = direct.match(/(\d{3,10})/);
      return (match?.[1] || direct).trim();
    }

    const fallbackSources = [
      fieldToString(fields.summary),
      fieldToString(fields.customfield_11353)
    ].filter((value) => value.length > 0);

    for (const source of fallbackSources) {
      const explicitOs = source.match(/(?:\bOS\b|ORDEM(?:\s+DE\s+SERVICO)?)[^\d]{0,8}(\d{3,10})/i);
      if (explicitOs?.[1]) {
        return explicitOs[1].trim();
      }

      const anyNumber = source.match(/\b(\d{3,10})\b/);
      if (anyNumber?.[1]) {
        return anyNumber[1].trim();
      }
    }

    return String(cardId || '').trim().toUpperCase();
  };

  const jiraUrl = process.env.JIRA_URL;

  if (!jiraUrl || !email || !apiToken) {
    throw new Error('Credenciais do Jira não configuradas no servidor');
  }

  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const issueUrl = `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(cardId)}`;
  const response = await axios.get(issueUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${auth}`
    },
    params: {
      fields: 'summary,customfield_11298,customfield_11331,customfield_11071,customfield_11353,customfield_10040'
    },
    timeout: 30000
  });

  const fields = response.data?.fields || {};
  return {
    id: cardId,
    modeloVeiculo: pickField(fields, ['customfield_11298']),
    tipoTeto: pickField(fields, ['customfield_11331']),
    anoVeiculo: pickField(fields, ['customfield_11071']),
    numeroProjeto: pickField(fields, ['customfield_11353', 'summary']),
    numeroOrdem: extractOrderNumber(fields, cardId)
  };
}

async function anexarPdfNoCardJira(cardId, pdfBuffer, fileName, email, apiToken) {
  const jiraUrl = process.env.JIRA_URL;

  if (!jiraUrl || !email || !apiToken) {
    throw new Error('Credenciais do Jira não configuradas no servidor');
  }

  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const attachmentUrl = `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(cardId)}/attachments`;
  const safeFileName = sanitizeFileName(String(fileName || `${cardId}.pdf`));

  const formData = new FormData();
  formData.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), safeFileName);

  const response = await fetch(attachmentUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${auth}`,
      'X-Atlassian-Token': 'no-check'
    },
    body: formData
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Falha ao anexar PDF no Jira (HTTP ${response.status}): ${details || 'sem detalhes'}`);
  }
}

/**
 * Transiciona o status de um card no Jira para "Liberado Engenharia"
 */
async function transicionarStatusCard(
  cardId,
  email,
  apiToken,
  statusNome = 'Liberado Engenharia',
  statusOrigem = 'A Produzir'
) {
  const jiraUrl = process.env.JIRA_URL;

  if (!jiraUrl || !email || !apiToken) {
    throw new Error('Credenciais do Jira não configuradas no servidor');
  }

  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  try {
    // 1. Buscar status atual para garantir a transição esperada de origem -> destino.
    const issueUrl = `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(cardId)}?fields=status`;
    const issueResponse = await axios.get(issueUrl, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json'
      }
    });

    const statusAtual = String(issueResponse?.data?.fields?.status?.name || '').trim();
    if (!statusAtual) {
      throw new Error(`Nao foi possivel identificar o status atual do card ${cardId}`);
    }

    if (statusAtual.toLowerCase() === statusNome.toLowerCase()) {
      console.log(`ℹ️ Card ${cardId} ja esta em "${statusNome}"`);
      return {
        changed: false,
        from: statusAtual,
        to: statusAtual,
        reason: 'already-in-target'
      };
    }

    if (statusAtual.toLowerCase() !== statusOrigem.toLowerCase()) {
      console.warn(`⚠️ Card ${cardId} em status "${statusAtual}". Esperado "${statusOrigem}" para transicao automatica.`);
      return {
        changed: false,
        from: statusAtual,
        to: statusAtual,
        reason: 'unexpected-source-status'
      };
    }

    // 2. Buscar transições disponíveis para o card
    const transitionsUrl = `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(cardId)}/transitions`;
    const transitionsResponse = await axios.get(transitionsUrl, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json'
      }
    });

    const transitions = transitionsResponse.data.transitions || [];
    console.log(`🔍 Transições disponíveis para ${cardId}:`, transitions.map(t => t.name).join(', '));

    // 3. Encontrar a transição que leva ao status de destino.
    const targetTransition = transitions.find(
      (t) => String(t?.to?.name || '').trim().toLowerCase() === statusNome.toLowerCase()
    ) || transitions.find(
      (t) => String(t?.name || '').trim().toLowerCase() === statusNome.toLowerCase()
    );

    if (!targetTransition) {
      console.warn(`⚠️ Transição "${statusNome}" não encontrada para o card ${cardId}`);
      throw new Error(`Transição "${statusNome}" não disponível para este card`);
    }

    console.log(`✅ Transição encontrada: ${targetTransition.name} (ID: ${targetTransition.id})`);

    // 4. Executar a transição
    await axios.post(
      transitionsUrl,
      {
        transition: {
          id: targetTransition.id
        }
      },
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    console.log(`✅ Status do card ${cardId} alterado de "${statusAtual}" para "${statusNome}"`);
    return {
      changed: true,
      from: statusAtual,
      to: statusNome,
      reason: 'transitioned'
    };
  } catch (error) {
    console.error(`❌ Erro ao transicionar status do card ${cardId}:`, error.message);
    throw error;
  }
}

/**
 * Gera documento DOCX de espelho com base no template original.
 */
async function gerarEspelhoDocx(templatePath, cardData) {
  const templateBuffer = await fs.promises.readFile(templatePath);
  const zip = new PizZip(templateBuffer);

  const SENTINEL = '__QR_CODE_IMAGE__';

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
    parser(tag) {
      const cleanTag = String(tag || '').trim();
      const key = cleanTag.startsWith('%') ? cleanTag.slice(1).trim() : cleanTag;
      return {
        get(scope) {
          const value = scope?.[key];
          return value === undefined || value === null ? '' : value;
        }
      };
    },
    nullGetter() {
      return '';
    }
  });

  const dataAtual = new Date().toLocaleDateString('pt-BR');
  const qrPayload = [
    cardData.modeloVeiculo,
    cardData.tipoTeto,
    cardData.anoVeiculo,
    cardData.numeroProjeto,
    cardData.numeroOrdem
  ].filter((value) => String(value || '').trim().length > 0).join('\n');

  doc.render({
    MODELO_VEICULO: cardData.modeloVeiculo,
    TIPO_TETO: cardData.tipoTeto,
    ANO_VEICULO: cardData.anoVeiculo,
    NUMERO_PROJETO: cardData.numeroProjeto,
    DATA_PROJETO: dataAtual,
    QUANTIDADE_PECAS: '',
    NUMERO_ORDEM: cardData.numeroOrdem,
    QR_CODE: SENTINEL
  });

  const renderedZip = doc.getZip();

  // Gera QR code como PNG e injeta diretamente no ZIP do docx
  const qrPngBuffer = await QRCode.toBuffer(qrPayload || cardData.id || '', {
    margin: 1,
    width: 260,
    type: 'png'
  });

  renderedZip.file('word/media/qrcode.png', qrPngBuffer);

  const relsPath = 'word/_rels/document.xml.rels';
  const relsFile = renderedZip.file(relsPath);
  if (relsFile) {
    let relsXml = relsFile.asText();
    const imgRel = '<Relationship Id="rIdQRCode" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/qrcode.png"/>';
    relsXml = relsXml.replace('</Relationships>', imgRel + '</Relationships>');
    renderedZip.file(relsPath, relsXml);
  }

  const docFile = renderedZip.file('word/document.xml');
  if (docFile) {
    const emuSize = 110 * 9525; // 110px em EMUs
    const drawingXml = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emuSize}" cy="${emuSize}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="100" name="QRCode"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="100" name="QRCode"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdQRCode"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emuSize}" cy="${emuSize}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

    const docXml = docFile.asText();
    const updatedXml = docXml.replace(
      /<w:p\b[^>]*>[\s\S]*?__QR_CODE_IMAGE__[\s\S]*?<\/w:p>/,
      drawingXml
    );
    renderedZip.file('word/document.xml', updatedXml);
  }

  return renderedZip.generate({ type: 'nodebuffer' });
}

async function runCommand(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Falha ao executar ${command} (code ${code})`));
      }
    });
  });
}

function escapePowerShellString(value) {
  return String(value || '').replace(/'/g, "''");
}

async function converterDocxParaPdfViaWord(inputPath, outputPath) {
  const inPath = escapePowerShellString(inputPath);
  const outPath = escapePowerShellString(outputPath);

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$inputPath = '${inPath}'`,
    `$outputPath = '${outPath}'`,
    '$word = $null',
    '$doc = $null',
    'try {',
    '  $word = New-Object -ComObject Word.Application',
    '  $word.Visible = $false',
    '  $doc = $word.Documents.Open($inputPath, $false, $true)',
    '  $wdFormatPDF = 17',
    '  $doc.SaveAs([ref]$outputPath, [ref]$wdFormatPDF)',
    '} finally {',
    '  if ($doc -ne $null) { $doc.Close() }',
    '  if ($word -ne $null) { $word.Quit() }',
    '}'
  ].join('; ');

  await runCommand('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ]);
}

function resolveLibreOfficeCandidates() {
  const explicitPath = String(process.env.LIBREOFFICE_PATH || '').trim();
  if (explicitPath) {
    return [explicitPath];
  }

  const candidates = ['soffice', 'soffice.exe'];

  if (process.platform === 'win32') {
    const baseDirs = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA
    ].filter(Boolean);

    for (const baseDir of baseDirs) {
      candidates.push(path.join(baseDir, 'LibreOffice', 'program', 'soffice.exe'));
    }
  }

  return candidates;
}

async function converterDocxParaPdf(docxBuffer, baseName) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'espelho-pdf-'));
  const safeName = sanitizeFileName(baseName || 'espelho');
  const inputPath = path.join(tmpDir, `${safeName}.docx`);
  const outputPath = path.join(tmpDir, `${safeName}.pdf`);

  try {
    await fs.promises.writeFile(inputPath, docxBuffer);

    const candidates = resolveLibreOfficeCandidates();

    let converted = false;
    let lastError = null;

    for (const candidate of candidates) {
      const isNamedCommand = !candidate.includes(path.sep);
      if (!isNamedCommand && !fs.existsSync(candidate)) {
        continue;
      }

      try {
        await runCommand(candidate, [
          '--headless',
          '--convert-to',
          'pdf',
          '--outdir',
          tmpDir,
          inputPath
        ]);
        converted = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!converted && process.platform === 'win32') {
      try {
        await converterDocxParaPdfViaWord(inputPath, outputPath);
        converted = true;
      } catch (wordError) {
        lastError = wordError;
      }
    }

    if (!converted) {
      const guidance = process.platform === 'win32'
        ? 'Instale o LibreOffice, defina LIBREOFFICE_PATH (ex: C:\\Program Files\\LibreOffice\\program\\soffice.exe) ou tenha Microsoft Word instalado.'
        : 'Instale o LibreOffice/soffice e garanta que o binario esteja no PATH.';
      throw new Error(`Nao foi possivel converter DOCX para PDF. ${guidance} ${lastError?.message || ''}`.trim());
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('Conversao concluida sem gerar arquivo PDF de saida.');
    }

    return await fs.promises.readFile(outputPath);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Gera espelhos nativamente no backend Node.js para múltiplos cards.
 */
export const gerarEspelhos = async (req, res) => {
  const startTime = Date.now();
  const usuarioEmail = req.user?.email || 'Desconhecido';
  const usuarioNome = req.user?.name || usuarioEmail;
  
  try {
    // Buscar credenciais do usuário logado
    const credentials = await getUserJiraCredentials(req.user.id);
    const { email, apiToken } = credentials;

    const bodyIds = req.body?.ids ?? req.body?.['ids[]'];
    const ids = Array.isArray(bodyIds)
      ? bodyIds
      : (bodyIds ? [bodyIds] : (req.body?.cardId ? [req.body.cardId] : []));

    if (ids.length === 0) {
      registrarGeracaoEspelhos({
        usuario: usuarioNome,
        cards: [],
        sucesso: false,
        quantidadeGerada: 0,
        erro: 'Nenhum card ID fornecido',
        incluiuPdf: false
      });
      
      return res.status(400).json({
        success: false,
        message: 'Informe o cardId para gerar espelho.'
      });
    }

    const normalizedIds = ids
      .map((id) => String(id || '').trim().toUpperCase())
      .filter((id) => id.length > 0);

    if (normalizedIds.length === 0) {
      registrarGeracaoEspelhos({
        usuario: usuarioNome,
        cards: ids,
        sucesso: false,
        quantidadeGerada: 0,
        erro: 'IDs inválidos fornecidos',
        incluiuPdf: false
      });
      
      return res.status(400).json({
        success: false,
        message: 'IDs inválidos para gerar espelhos.'
      });
    }

    if (normalizedIds.length !== 1) {
      registrarGeracaoEspelhos({
        usuario: usuarioNome,
        cards: normalizedIds,
        sucesso: false,
        quantidadeGerada: 0,
        erro: `Múltiplos IDs enviados (${normalizedIds.length}). Apenas 1 ID permitido por requisição`,
        incluiuPdf: false
      });
      
      return res.status(400).json({
        success: false,
        message: 'Envie apenas 1 ID por requisição para download direto.'
      });
    }

    let arquivosProjetoBuffers = [];
    const incluiuPdf = Array.isArray(req.files) && req.files.length > 0;
    const quantidadePecas = parseInt(req.body.quantidade) || 1; // Capturar quantidade de peças
    const quantidadeTampas = parseInt(req.body.quantidadeTampas) || quantidadePecas;
    const consumoCampos = {
      c8: String(req.body?.consumo8c || '').trim(),
      c9: String(req.body?.consumo9c || '').trim(),
      c11: String(req.body?.consumo11c || '').trim()
    };
    
    if (Array.isArray(req.files) && req.files.length > 0) {
      // Validar que todos são PDFs
      for (const file of req.files) {
        const mimeType = String(file.mimetype || '').toLowerCase();
        const originalName = String(file.originalname || '').toLowerCase();
        const isPdf = mimeType.includes('pdf') || originalName.endsWith('.pdf');

        if (!isPdf) {
          registrarGeracaoEspelhos({
            usuario: usuarioNome,
            cards: normalizedIds,
            sucesso: false,
            quantidadeGerada: 0,
            erro: `Arquivo enviado não é PDF: ${originalName}`,
            incluiuPdf: false
          });
          
          return res.status(400).json({
            success: false,
            message: 'Todos os arquivos devem ser PDFs.'
          });
        }

        arquivosProjetoBuffers.push(file.buffer);
      }
    }

    const cardId = normalizedIds[0];
    const cardData = await buscarDadosCardEspelho(cardId, email, apiToken);
    const cardIdentifier = `${cardData.id || ''} ${cardData.numeroOrdem || ''} ${cardData.numeroProjeto || ''}`;
    const isAramidaCard = !/TENSYLON/i.test(cardIdentifier);
    const numeroOrdem = sanitizeFileName(String(cardData.numeroOrdem || cardId));
    let generatedBuffer;
    let contentType = 'application/pdf';
    let downloadName = `${numeroOrdem}.pdf`;

    try {
      generatedBuffer = await criarEspelhoPdfDoCodigo(cardData, quantidadePecas, consumoCampos);
    } catch (pdfError) {
      console.error('❌ Erro ao gerar PDF:', pdfError.message);
      
      registrarGeracaoEspelhos({
        usuario: usuarioNome,
        cards: normalizedIds,
        sucesso: false,
        quantidadeGerada: 0,
        erro: `Erro ao gerar PDF: ${pdfError.message}`,
        incluiuPdf,
        detalhes: {
          'Número Ordem': numeroOrdem,
          'Card ID': cardId
        }
      });
      
      return res.status(500).json({
        success: false,
        message: `Erro ao gerar PDF: ${pdfError.message}`
      });
    }

    if (arquivosProjetoBuffers.length > 0) {
      try {
        // Mesclar espelho com todos os arquivos selecionados
        let mergedBuffer = generatedBuffer;
        for (const projetoBuffer of arquivosProjetoBuffers) {
          mergedBuffer = Buffer.from(await mesclarPdfBuffers(mergedBuffer, projetoBuffer));
        }
        generatedBuffer = mergedBuffer;
        downloadName = `${numeroOrdem}.pdf`;
      } catch (mergeError) {
        registrarGeracaoEspelhos({
          usuario: usuarioNome,
          cards: normalizedIds,
          sucesso: false,
          quantidadeGerada: 0,
          erro: `Erro ao mesclar PDFs: ${mergeError.message}`,
          incluiuPdf: true,
          detalhes: {
            'Número Ordem': numeroOrdem,
            'Card ID': cardId,
            'Quantidade Arquivos': arquivosProjetoBuffers.length
          }
        });
        
        return res.status(400).json({
          success: false,
          message: `Nao foi possivel juntar o espelho com os arquivos selecionados: ${mergeError.message}`
        });
      }
    }

    if (isAramidaCard) {
      // Para Aramida, a ultima folha deve conter apenas os campos do layout simplificado.
      const ultimaFolhaAramida = await criarUltimaFolhaAramida(cardData, quantidadeTampas);
      generatedBuffer = Buffer.from(await mesclarPdfBuffers(generatedBuffer, ultimaFolhaAramida));
    }

    try {
      await anexarPdfNoCardJira(cardId, generatedBuffer, downloadName, email, apiToken);
    } catch (attachError) {
      registrarGeracaoEspelhos({
        usuario: usuarioNome,
        cards: normalizedIds,
        sucesso: false,
        quantidadeGerada: 1,
        erro: `PDF gerado, mas falha ao anexar no Jira: ${attachError.message}`,
        incluiuPdf,
        detalhes: {
          'Número Ordem': numeroOrdem,
          'Card ID': cardId,
          'Nome Arquivo': downloadName,
          'Tamanho PDF': `${(generatedBuffer.length / 1024).toFixed(2)} KB`,
          'Quantidade Peças': quantidadePecas
        }
      });
      
      return res.status(500).json({
        success: false,
        message: `PDF gerado, mas não foi possível anexar no card ${cardId}: ${attachError.message}`
      });
    }

    // Transicionar status do card para "Liberado Engenharia"
    try {
      const statusTransition = await transicionarStatusCard(cardId, email, apiToken, 'Liberado Engenharia', 'A Produzir');
      if (statusTransition.changed) {
        console.log(`✅ Status do card ${cardId} alterado para "Liberado Engenharia"`);
      } else if (statusTransition.reason === 'already-in-target') {
        console.log(`ℹ️ Card ${cardId} ja estava em "Liberado Engenharia"`);
      } else if (statusTransition.reason === 'unexpected-source-status') {
        console.warn(`⚠️ Card ${cardId} nao foi movido automaticamente: status atual "${statusTransition.from}"`);
      }
    } catch (statusError) {
      console.warn(`⚠️ Não foi possível alterar o status do card ${cardId}:`, statusError.message);
      // Não falha a requisição, apenas loga o aviso
    }

    // Sucesso total
    const tempoDecorrido = ((Date.now() - startTime) / 1000).toFixed(2);
    
    const arquivosNomes = Array.isArray(req.files) && req.files.length > 0
      ? req.files.map(f => f.originalname).join(', ')
      : 'Não incluído';
    
    registrarGeracaoEspelhos({
      usuario: usuarioNome,
      cards: normalizedIds,
      sucesso: true,
      quantidadeGerada: 1,
      incluiuPdf,
      detalhes: {
        'Número Ordem': numeroOrdem,
        'Card ID': cardId,
        'Nome Arquivo': downloadName,
        'Tamanho PDF': `${(generatedBuffer.length / 1024).toFixed(2)} KB`,
        'Tempo de Processamento': `${tempoDecorrido}s`,
        'Arquivos Projeto': incluiuPdf ? arquivosNomes : 'Não incluído',
        'Quantidade Arquivos': incluiuPdf ? arquivosProjetoBuffers.length : 0,
        'Quantidade Peças': quantidadePecas
      }
    });

    // Salvar registro no banco de dados
    try {
      await pool.query(
        `INSERT INTO maestro.projetos_espelhos 
        (card_id, numero_ordem, titulo, usuario_email, usuario_nome, arquivo_pdf, 
         tamanho_kb, quantidade_pecas, arquivo_projeto_incluido, status, tempo_processamento)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          cardId,
          numeroOrdem,
          cardData.titulo || 'Sem título',
          usuarioEmail,
          usuarioNome,
          downloadName,
          (generatedBuffer.length / 1024).toFixed(2),
          quantidadePecas,
          incluiuPdf,
          'gerado',
          tempoDecorrido
        ]
      );
      console.log(`✅ Registro salvo no banco de dados: ${cardId}`);
    } catch (dbError) {
      console.error('⚠️ Erro ao salvar no banco de dados:', dbError.message);
      // Não falha a requisição, apenas loga o erro
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    return res.status(200).send(generatedBuffer);
  } catch (error) {
    console.error('❌ Erro em gerarEspelhos:', error);
    
    registrarGeracaoEspelhos({
      usuario: usuarioNome,
      cards: [],
      sucesso: false,
      quantidadeGerada: 0,
      erro: `Erro não tratado: ${error.message}`,
      incluiuPdf: Array.isArray(req.files) && req.files.length > 0,
      detalhes: {
        'Stack': error.stack?.split('\n').slice(0, 3).join(' | ')
      }
    });
    
    return res.status(500).json({
      success: false,
      message: `Erro ao gerar espelhos: ${error.message}`
    });
  }
};

/**
 * Obtém o histórico de logs de geração de espelhos
 */
export const obterLogsEspelhos = async (req, res) => {
  try {
    const { obterLogsEspelhos: obterLogs } = await import('../utils/espelhos-logger.js');
    const logsContent = obterLogs();
    
    return res.status(200).json({
      success: true,
      data: {
        logs: logsContent
      }
    });
  } catch (error) {
    console.error('❌ Erro ao obter logs de espelhos:', error);
    return res.status(500).json({
      success: false,
      message: `Erro ao obter logs: ${error.message}`
    });
  }
};

/**
 * Lista todos os projetos/espelhos cadastrados
 */
export const listarProjetosEspelhos = async (req, res) => {
  try {
    const { page = 1, limit = 50, filtro = '', ordenarPor = 'created_at', ordem = 'DESC' } = req.query;
    const offset = (page - 1) * limit;

    // Construir WHERE clause para filtro
    let whereClause = '';
    const queryParams = [];
    
    if (filtro) {
      whereClause = `WHERE (
        card_id ILIKE $1 OR 
        numero_ordem ILIKE $1 OR 
        titulo ILIKE $1 OR 
        usuario_nome ILIKE $1 OR 
        usuario_email ILIKE $1
      )`;
      queryParams.push(`%${filtro}%`);
    }

    // Validar ordenação
    const camposValidos = ['created_at', 'numero_ordem', 'card_id', 'usuario_nome', 'quantidade_pecas'];
    const orderBy = camposValidos.includes(ordenarPor) ? ordenarPor : 'created_at';
    const orderDirection = ordem.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Contar total de registros
    const countQuery = `SELECT COUNT(*) FROM maestro.projetos_espelhos ${whereClause}`;
    const countResult = await pool.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count);

    // Buscar registros paginados
    const dataQuery = `
      SELECT 
        id, card_id, numero_ordem, titulo, usuario_email, usuario_nome,
        arquivo_pdf, tamanho_kb, quantidade_pecas, arquivo_projeto_incluido,
        status, tempo_processamento, created_at, updated_at
      FROM maestro.projetos_espelhos
      ${whereClause}
      ORDER BY ${orderBy} ${orderDirection}
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `;
    
    queryParams.push(limit, offset);
    const dataResult = await pool.query(dataQuery, queryParams);

    return res.status(200).json({
      success: true,
      data: dataResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Erro ao listar projetos:', error);
    return res.status(500).json({
      success: false,
      message: `Erro ao listar projetos: ${error.message}`
    });
  }
};

/**
 * Obtém detalhes de um projeto específico
 */
export const obterProjetoEspelho = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT 
        id, card_id, numero_ordem, titulo, usuario_email, usuario_nome,
        arquivo_pdf, tamanho_kb, quantidade_pecas, arquivo_projeto_incluido,
        status, tempo_processamento, created_at, updated_at
      FROM maestro.projetos_espelhos
      WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Projeto não encontrado'
      });
    }

    return res.status(200).json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Erro ao obter projeto:', error);
    return res.status(500).json({
      success: false,
      message: `Erro ao obter projeto: ${error.message}`
    });
  }
};

/**
 * Obtém estatísticas dos projetos cadastrados
 */
export const obterEstatisticasProjetos = async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_projetos,
        COUNT(DISTINCT usuario_email) as total_usuarios,
        SUM(quantidade_pecas) as total_pecas,
        AVG(tempo_processamento) as tempo_medio,
        MAX(created_at) as ultima_geracao
      FROM maestro.projetos_espelhos
    `);

    const porUsuario = await pool.query(`
      SELECT 
        usuario_nome,
        COUNT(*) as quantidade,
        SUM(quantidade_pecas) as total_pecas
      FROM maestro.projetos_espelhos
      GROUP BY usuario_nome
      ORDER BY quantidade DESC
      LIMIT 10
    `);

    const porDia = await pool.query(`
      SELECT 
        DATE(created_at) as data,
        COUNT(*) as quantidade
      FROM maestro.projetos_espelhos
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY data DESC
    `);

    return res.status(200).json({
      success: true,
      data: {
        geral: stats.rows[0],
        porUsuario: porUsuario.rows,
        porDia: porDia.rows
      }
    });
  } catch (error) {
    console.error('❌ Erro ao obter estatísticas:', error);
    return res.status(500).json({
      success: false,
      message: `Erro ao obter estatísticas: ${error.message}`
    });
  }
};

/**
 * Lista projetos da tabela maestro.project com paginação e filtros
 */
export const listarProjects = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      filtro = '',
      ordenarPor = 'id',
      ordem = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;
    const ordensColunas = ['id', 'project', 'material_type', 'brand', 'model', 'roof_config', 'total_parts_qty', 'lid_parts_qty'];
    const colunaOrdenacao = ordensColunas.includes(ordenarPor) ? ordenarPor : 'id';
    const direcaoOrdem = ordem.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    // Query para contar total de registros
    let countQuery = 'SELECT COUNT(*) FROM maestro.project';
    let countParams = [];

    // Query para buscar registros
    let dataQuery = `
      SELECT 
        id,
        project,
        material_type,
        brand,
        model,
        roof_config,
        total_parts_qty,
        lid_parts_qty
      FROM maestro.project
    `;
    let dataParams = [];

    // Aplicar filtro se fornecido
    if (filtro && filtro.trim() !== '') {
      const filtroWhere = ` WHERE 
        LOWER(project) LIKE LOWER($1) OR
        LOWER(material_type) LIKE LOWER($1) OR
        LOWER(brand) LIKE LOWER($1) OR
        LOWER(model) LIKE LOWER($1) OR
        LOWER(roof_config) LIKE LOWER($1)
      `;
      countQuery += filtroWhere;
      dataQuery += filtroWhere;
      
      const filtroParam = `%${filtro}%`;
      countParams.push(filtroParam);
      dataParams.push(filtroParam);
    }

    // Adicionar ordenação e paginação
    dataQuery += ` ORDER BY ${colunaOrdenacao} ${direcaoOrdem} LIMIT $${dataParams.length + 1} OFFSET $${dataParams.length + 2}`;
    dataParams.push(limit, offset);

    // Executar queries
    const [countResult, dataResult] = await Promise.all([
      pool.query(countQuery, countParams),
      pool.query(dataQuery, dataParams)
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      data: dataResult.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('❌ Erro ao listar projetos:', error);
    return res.status(500).json({
      success: false,
      message: `Erro ao listar projetos: ${error.message}`
    });
  }
};

/**
 * Cria novo projeto na tabela maestro.project
 */
export const criarProject = async (req, res) => {
  try {
    const body = req.body || {};
    const parseDecimalOrEmpty = (value) => {
      if (value === null || value === undefined || String(value).trim() === '') {
        return '';
      }

      const normalized = String(value).replace(',', '.').trim();
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : '';
    };

    const project = String(body.project || '').trim();
    const materialType = String(body.material_type || '').trim();
    const brand = String(body.brand || '').trim();
    const model = String(body.model || '').trim();
    const totalPartsQty = Number(body.total_parts_qty);

    const camposObrigatoriosFaltantes = [];
    if (!project) camposObrigatoriosFaltantes.push('Projeto');
    if (!materialType) camposObrigatoriosFaltantes.push('Tipo de Material');
    if (!brand) camposObrigatoriosFaltantes.push('Marca');
    if (!model) camposObrigatoriosFaltantes.push('Modelo');
    if (!Number.isFinite(totalPartsQty) || totalPartsQty <= 0) camposObrigatoriosFaltantes.push('Qtd. Total');

    if (camposObrigatoriosFaltantes.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Campos obrigatórios inválidos: ${camposObrigatoriosFaltantes.join(', ')}`
      });
    }

    const payload = {
      project,
      material_type: materialType,
      brand,
      model,
      roof_config: String(body.roof_config || '').trim(),
      total_parts_qty: Math.trunc(totalPartsQty),
      lid_parts_qty: Number.isFinite(Number(body.lid_parts_qty)) ? Math.max(0, Math.trunc(Number(body.lid_parts_qty))) : 0,
      linear_meters: materialType.toUpperCase() === 'TENSYLON'
        ? {
            '8C': '',
            '9C': '',
            '11C': '',
            tensylon: parseDecimalOrEmpty(body?.linear_meters?.tensylon ?? body?.linear_meters?.['Metro Linear'] ?? body.spec_8c)
          }
        : {
            '8C': parseDecimalOrEmpty(body?.linear_meters?.['8C'] ?? body.spec_8c),
            '9C': parseDecimalOrEmpty(body?.linear_meters?.['9C'] ?? body.spec_9c),
            '11C': parseDecimalOrEmpty(body?.linear_meters?.['11C'] ?? body.spec_11c)
          },
      square_meters: materialType.toUpperCase() === 'TENSYLON'
        ? {
            '8C': '',
            '9C': '',
            '11C': '',
            tensylon: parseDecimalOrEmpty(body?.square_meters?.tensylon ?? body.metro_quadrado_8c)
          }
        : {
            '8C': parseDecimalOrEmpty(body?.square_meters?.['8C'] ?? body.metro_quadrado_8c),
            '9C': parseDecimalOrEmpty(body?.square_meters?.['9C'] ?? body.metro_quadrado_9c),
            '11C': parseDecimalOrEmpty(body?.square_meters?.['11C'] ?? body.metro_quadrado_11c)
          },
      plate_consumption: {
        '8C': parseDecimalOrEmpty(body?.plate_consumption?.['8C'] ?? body?.plaste_consumption?.['8C'] ?? body?.plates_consumption?.['8C'] ?? body.quantidade_placas_8c),
        '9C': parseDecimalOrEmpty(body?.plate_consumption?.['9C'] ?? body?.plaste_consumption?.['9C'] ?? body?.plates_consumption?.['9C'] ?? body.quantidade_placas_9c),
        '11C': parseDecimalOrEmpty(body?.plate_consumption?.['11C'] ?? body?.plaste_consumption?.['11C'] ?? body?.plates_consumption?.['11C'] ?? body.quantidade_placas_11c)
      },
      reviews: {
        cutting: Boolean(body?.reviews?.cutting ?? body.flag_corte),
        labeling: Boolean(body?.reviews?.labeling ?? body.flag_etiquetagem),
        ki_Layout: Boolean(body?.reviews?.ki_Layout ?? body.flag_mapa_kit),
        nesting_report: Boolean(body?.reviews?.nesting_report ?? body.flag_relatorio_encaixe),
        folder_template: Boolean(body?.reviews?.folder_template ?? body.flag_modelo_pastas)
      },
      flag_corte: Boolean(body.flag_corte),
      flag_mapa_kit: Boolean(body.flag_mapa_kit),
      flag_relatorio_encaixe: Boolean(body.flag_relatorio_encaixe),
      flag_etiquetagem: Boolean(body.flag_etiquetagem),
      flag_modelo_pastas: Boolean(body.flag_modelo_pastas)
    };

    const columnsResult = await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'maestro'
          AND table_name = 'project'
      `
    );

    const existingColumns = new Set(columnsResult.rows.map((row) => row.column_name));
    const entries = Object.entries(payload).filter(([column]) => existingColumns.has(column));

    if (entries.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Não foi possível identificar colunas de inserção na tabela maestro.project.'
      });
    }

    const missingMandatoryColumns = ['project', 'material_type', 'brand', 'model', 'total_parts_qty']
      .filter((column) => !existingColumns.has(column));

    if (missingMandatoryColumns.length > 0) {
      return res.status(500).json({
        success: false,
        message: `A tabela maestro.project não possui as colunas obrigatórias: ${missingMandatoryColumns.join(', ')}`
      });
    }

    const missingJsonColumns = ['linear_meters', 'square_meters', 'plate_consumption', 'reviews']
      .filter((column) => !existingColumns.has(column));

    if (missingJsonColumns.length > 0) {
      return res.status(500).json({
        success: false,
        message: `A tabela maestro.project não possui as colunas JSON esperadas: ${missingJsonColumns.join(', ')}`
      });
    }

    const duplicateCheck = await pool.query(
      `
        SELECT id, project
        FROM maestro.project
        WHERE LOWER(project) = LOWER($1)
        LIMIT 1
      `,
      [project]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Já existe um projeto cadastrado com o código ${duplicateCheck.rows[0].project}.`
      });
    }

    const insertColumns = entries.map(([column]) => column);
    const values = entries.map(([, value]) => value);
    const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');

    const insertQuery = `
      INSERT INTO maestro.project (${insertColumns.join(', ')})
      VALUES (${placeholders})
      RETURNING id, project, material_type, brand, model, roof_config, total_parts_qty, lid_parts_qty
    `;

    const insertResult = await pool.query(insertQuery, values);
    const created = insertResult.rows[0];

    await logProjectAudit({
      req,
      action: 'CREATE',
      projectId: created.id,
      projectCode: created.project,
      before: null,
      after: created,
    });

    return res.status(201).json({
      success: true,
      message: 'Projeto cadastrado com sucesso.',
      data: created
    });
  } catch (error) {
    console.error('❌ Erro ao criar projeto:', error);
    return res.status(500).json({
      success: false,
      message: `Erro ao criar projeto: ${error.message}`
    });
  }
};

/**
 * Obtém um projeto por ID
 */
export const obterProjectById = async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'ID de projeto inválido.' });
    }

    const result = await pool.query('SELECT * FROM maestro.project WHERE id = $1 LIMIT 1', [projectId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado.' });
    }

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao obter projeto por ID:', error);
    return res.status(500).json({ success: false, message: `Erro ao obter projeto: ${error.message}` });
  }
};

/**
 * Atualiza um projeto existente
 */
export const atualizarProject = async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'ID de projeto inválido.' });
    }

    const body = req.body || {};
    const parseDecimalOrEmpty = (value) => {
      if (value === null || value === undefined || String(value).trim() === '') {
        return '';
      }

      const normalized = String(value).replace(',', '.').trim();
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : '';
    };

    const project = String(body.project || '').trim();
    const materialType = String(body.material_type || '').trim();
    const brand = String(body.brand || '').trim();
    const model = String(body.model || '').trim();
    const totalPartsQty = Number(body.total_parts_qty);

    const camposObrigatoriosFaltantes = [];
    if (!project) camposObrigatoriosFaltantes.push('Projeto');
    if (!materialType) camposObrigatoriosFaltantes.push('Tipo de Material');
    if (!brand) camposObrigatoriosFaltantes.push('Marca');
    if (!model) camposObrigatoriosFaltantes.push('Modelo');
    if (!Number.isFinite(totalPartsQty) || totalPartsQty <= 0) camposObrigatoriosFaltantes.push('Qtd. Total');

    if (camposObrigatoriosFaltantes.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Campos obrigatórios inválidos: ${camposObrigatoriosFaltantes.join(', ')}`
      });
    }

    const duplicateCheck = await pool.query(
      `
        SELECT id, project
        FROM maestro.project
        WHERE LOWER(project) = LOWER($1)
          AND id <> $2
        LIMIT 1
      `,
      [project, projectId]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Já existe um projeto cadastrado com o código ${duplicateCheck.rows[0].project}.`
      });
    }

    const payload = {
      project,
      material_type: materialType,
      brand,
      model,
      roof_config: String(body.roof_config || '').trim(),
      total_parts_qty: Math.trunc(totalPartsQty),
      lid_parts_qty: Number.isFinite(Number(body.lid_parts_qty)) ? Math.max(0, Math.trunc(Number(body.lid_parts_qty))) : 0,
      linear_meters: materialType.toUpperCase() === 'TENSYLON'
        ? {
            '8C': '',
            '9C': '',
            '11C': '',
            tensylon: parseDecimalOrEmpty(body?.linear_meters?.tensylon ?? body?.linear_meters?.['Metro Linear'] ?? body.spec_8c)
          }
        : {
            '8C': parseDecimalOrEmpty(body?.linear_meters?.['8C'] ?? body.spec_8c),
            '9C': parseDecimalOrEmpty(body?.linear_meters?.['9C'] ?? body.spec_9c),
            '11C': parseDecimalOrEmpty(body?.linear_meters?.['11C'] ?? body.spec_11c)
          },
      square_meters: materialType.toUpperCase() === 'TENSYLON'
        ? {
            '8C': '',
            '9C': '',
            '11C': '',
            tensylon: parseDecimalOrEmpty(body?.square_meters?.tensylon ?? body.metro_quadrado_8c)
          }
        : {
            '8C': parseDecimalOrEmpty(body?.square_meters?.['8C'] ?? body.metro_quadrado_8c),
            '9C': parseDecimalOrEmpty(body?.square_meters?.['9C'] ?? body.metro_quadrado_9c),
            '11C': parseDecimalOrEmpty(body?.square_meters?.['11C'] ?? body.metro_quadrado_11c)
          },
      plate_consumption: {
        '8C': parseDecimalOrEmpty(body?.plate_consumption?.['8C'] ?? body?.plaste_consumption?.['8C'] ?? body?.plates_consumption?.['8C'] ?? body.quantidade_placas_8c),
        '9C': parseDecimalOrEmpty(body?.plate_consumption?.['9C'] ?? body?.plaste_consumption?.['9C'] ?? body?.plates_consumption?.['9C'] ?? body.quantidade_placas_9c),
        '11C': parseDecimalOrEmpty(body?.plate_consumption?.['11C'] ?? body?.plaste_consumption?.['11C'] ?? body?.plates_consumption?.['11C'] ?? body.quantidade_placas_11c)
      },
      reviews: {
        cutting: Boolean(body?.reviews?.cutting ?? body.flag_corte),
        labeling: Boolean(body?.reviews?.labeling ?? body.flag_etiquetagem),
        ki_Layout: Boolean(body?.reviews?.ki_Layout ?? body.flag_mapa_kit),
        nesting_report: Boolean(body?.reviews?.nesting_report ?? body.flag_relatorio_encaixe),
        folder_template: Boolean(body?.reviews?.folder_template ?? body.flag_modelo_pastas)
      },
      flag_corte: Boolean(body.flag_corte),
      flag_mapa_kit: Boolean(body.flag_mapa_kit),
      flag_relatorio_encaixe: Boolean(body.flag_relatorio_encaixe),
      flag_etiquetagem: Boolean(body.flag_etiquetagem),
      flag_modelo_pastas: Boolean(body.flag_modelo_pastas)
    };

    const columnsResult = await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'maestro'
          AND table_name = 'project'
      `
    );

    const existingColumns = new Set(columnsResult.rows.map((row) => row.column_name));
    const entries = Object.entries(payload).filter(([column]) => existingColumns.has(column));

    if (entries.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Não foi possível identificar colunas para atualização na tabela maestro.project.'
      });
    }

    const beforeResult = await pool.query(
      'SELECT * FROM maestro.project WHERE id = $1 LIMIT 1',
      [projectId]
    );
    if (beforeResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado para atualização.' });
    }
    const before = beforeResult.rows[0];

    const setClause = entries.map(([column], index) => `${column} = $${index + 1}`).join(', ');
    const values = entries.map(([, value]) => value);
    values.push(projectId);

    const updateResult = await pool.query(
      `
        UPDATE maestro.project
        SET ${setClause}
        WHERE id = $${values.length}
        RETURNING *
      `,
      values
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado para atualização.' });
    }
    const after = updateResult.rows[0];

    await logProjectAudit({
      req,
      action: 'UPDATE',
      projectId: after.id,
      projectCode: after.project,
      before,
      after,
    });

    return res.status(200).json({
      success: true,
      message: 'Projeto atualizado com sucesso.',
      data: {
        id: after.id,
        project: after.project,
        material_type: after.material_type,
        brand: after.brand,
        model: after.model,
        roof_config: after.roof_config,
        total_parts_qty: after.total_parts_qty,
        lid_parts_qty: after.lid_parts_qty,
      }
    });
  } catch (error) {
    console.error('❌ Erro ao atualizar projeto:', error);
    return res.status(500).json({ success: false, message: `Erro ao atualizar projeto: ${error.message}` });
  }
};

/**
 * Clona projeto existente criando novo nome incremental (1), (2), ...
 */
export const clonarProject = async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'ID de projeto inválido.' });
    }

    const originalResult = await pool.query('SELECT * FROM maestro.project WHERE id = $1 LIMIT 1', [projectId]);
    if (originalResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado para clonagem.' });
    }

    const original = originalResult.rows[0];
    const baseProjectName = String(original.project || '').replace(/\s\(\d+\)$/, '').trim();

    const existingNamesResult = await pool.query(
      `
        SELECT project
        FROM maestro.project
        WHERE LOWER(project) = LOWER($1)
           OR LOWER(project) LIKE LOWER($2)
      `,
      [baseProjectName, `${baseProjectName} (%)`]
    );

    const usedIndexes = new Set();
    const escapedBase = baseProjectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const suffixRegex = new RegExp(`^${escapedBase} \\((\\d+)\\)$`, 'i');

    for (const row of existingNamesResult.rows) {
      const currentName = String(row.project || '').trim();
      if (currentName.toLowerCase() === baseProjectName.toLowerCase()) {
        usedIndexes.add(0);
        continue;
      }

      const match = currentName.match(suffixRegex);
      if (match) {
        usedIndexes.add(Number(match[1]));
      }
    }

    let cloneIndex = 1;
    while (usedIndexes.has(cloneIndex)) {
      cloneIndex += 1;
    }

    const clonedProjectName = `${baseProjectName} (${cloneIndex})`;

    const columnsResult = await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'maestro'
          AND table_name = 'project'
          AND column_name <> 'id'
      `
    );

    const insertColumns = [];
    const insertValues = [];

    for (const row of columnsResult.rows) {
      const column = row.column_name;
      let value = original[column];

      if (column === 'project') {
        value = clonedProjectName;
      }

      if (value === undefined) {
        continue;
      }

      insertColumns.push(column);
      insertValues.push(value);
    }

    if (insertColumns.length === 0) {
      return res.status(500).json({ success: false, message: 'Não foi possível montar dados para clonagem.' });
    }

    const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');
    const cloneResult = await pool.query(
      `
        INSERT INTO maestro.project (${insertColumns.join(', ')})
        VALUES (${placeholders})
        RETURNING id, project, material_type, brand, model, roof_config, total_parts_qty, lid_parts_qty
      `,
      insertValues
    );
    const cloned = cloneResult.rows[0];

    await logProjectAudit({
      req,
      action: 'CLONE',
      projectId: cloned.id,
      projectCode: cloned.project,
      before: null,
      after: cloned,
      metadata: { source_project_id: original.id, source_project_code: original.project },
    });

    return res.status(201).json({
      success: true,
      message: `Projeto clonado com sucesso como ${clonedProjectName}.`,
      data: cloned
    });
  } catch (error) {
    console.error('❌ Erro ao clonar projeto:', error);
    return res.status(500).json({ success: false, message: `Erro ao clonar projeto: ${error.message}` });
  }
};

/**
 * Exclui projeto por ID
 */
export const excluirProject = async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'ID de projeto inválido.' });
    }

    const beforeResult = await pool.query(
      'SELECT * FROM maestro.project WHERE id = $1 LIMIT 1',
      [projectId]
    );
    const before = beforeResult.rows[0] || null;

    const deleteResult = await pool.query(
      `
        DELETE FROM maestro.project
        WHERE id = $1
        RETURNING id, project
      `,
      [projectId]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Projeto não encontrado para exclusão.' });
    }

    await logProjectAudit({
      req,
      action: 'DELETE',
      projectId,
      projectCode: deleteResult.rows[0].project,
      before,
      after: null,
    });

    return res.status(200).json({
      success: true,
      message: `Projeto ${deleteResult.rows[0].project} excluído com sucesso.`
    });
  } catch (error) {
    console.error('❌ Erro ao excluir projeto:', error);
    return res.status(500).json({ success: false, message: `Erro ao excluir projeto: ${error.message}` });
  }
};

/**
 * Obtém todas as marcas únicas cadastradas na tabela maestro.project
 * @route GET /api/jira/projects/brands
 */
export const obterMarcasUnicas = async (req, res) => {
  try {
    console.log('📋 Buscando marcas únicas do banco de dados...');
    
    const query = `
      SELECT DISTINCT brand 
      FROM maestro.project 
      WHERE brand IS NOT NULL AND brand != ''
      ORDER BY brand ASC
    `;
    
    const result = await pool.query(query);
    const marcas = result.rows.map(row => row.brand);
    
    console.log(`✅ ${marcas.length} marcas únicas encontradas`);
    
    return res.status(200).json({
      success: true,
      data: marcas
    });
  } catch (error) {
    console.error('❌ Erro ao buscar marcas únicas:', error);
    return res.status(500).json({
      success: false,
      message: `Erro ao buscar marcas: ${error.message}`
    });
  }
};

/**
 * Reprograma datas Comtec automaticamente (próximo dia útil)
 */
/**
 * Busca todas as issues para o relatório geral de PCP
 */
export const getPCPRelatorio = async (req, res) => {
  try {
    console.log('🔍 Iniciando busca de issues para Relatório PCP...');

    let credentials;
    try {
      credentials = await getUserJiraCredentials(req.user.id);
    } catch (credError) {
      return res.status(400).json({
        success: false,
        message: `Erro ao buscar credenciais: ${credError.message}`
      });
    }

    const { email, apiToken } = credentials;
    const jiraUrl = process.env.JIRA_URL;

    if (!jiraUrl) {
      return res.status(500).json({
        success: false,
        message: 'JIRA_URL não configurado no servidor. Contate o administrador.'
      });
    }

    if (!email || !apiToken) {
      return res.status(400).json({
        success: false,
        message: 'Credenciais do Jira não configuradas para seu usuário. Configure no perfil.'
      });
    }

    const jqlMantaBase = '(project = MANTA AND status IN ("A Produzir", "Liberado Engenharia"))';
    const jqlTensylonBase = '(project = TENSYLON AND status IN ("A Produzir", "Liberado Engenharia", "Aguardando Acabamento", "Aguardando Autoclave", "Aguardando Corte", "Aguardando montagem", "🔴RECEBIDO NÃO LIBERADO"))';
    const jql = `${jqlMantaBase} OR ${jqlTensylonBase}`;

    const url = `${jiraUrl}/rest/api/3/search/jql`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    console.log('🔍 [PCP RELATORIO] JQL:', jql);

    let allIssues = [];
    let nextPageToken = null;
    let pageCount = 0;

    while (true) {
      pageCount++;
      console.log(`📄 [PCP RELATORIO PÁGINA ${pageCount}] Buscando issues...`);

      const params = {
        jql,
        maxResults: 100,
        fields: [
          'issuetype',
          'summary',
          'status',
          'customfield_10039',
          'customfield_11298',
          'customfield_10245',
          'customfield_11353'
        ].join(',')
      };

      if (nextPageToken) {
        params.nextPageToken = nextPageToken;
      }

      const response = await axios.get(url, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${auth}`
        },
        params
      });

      const issues = response.data.issues || [];
      const isLast = !!response.data.isLast;

      console.log(`✅ [PCP RELATORIO PÁGINA ${pageCount}] Recebidas ${issues.length} issues`);

      allIssues = [...allIssues, ...issues];

      if (isLast) break;

      nextPageToken = response.data.nextPageToken || null;
      if (!nextPageToken) {
        console.log('⚠️ [PCP RELATORIO] nextPageToken ausente; encerrando paginação.');
        break;
      }
    }

    console.log(`🎯 [PCP RELATORIO] Total de issues coletadas: ${allIssues.length}`);

    const processedData = allIssues.map((issue) => {
      const fields = issue.fields;

      let situacao = '';
      const situacaoRaw = fields.customfield_10039;
      if (situacaoRaw && typeof situacaoRaw === 'object' && situacaoRaw.value) {
        situacao = situacaoRaw.value;
      } else if (situacaoRaw) {
        situacao = situacaoRaw;
      }

      let veiculo = '';
      const veiculoRaw = fields.customfield_11298;
      if (veiculoRaw && typeof veiculoRaw === 'object' && veiculoRaw.value) {
        veiculo = veiculoRaw.value;
      } else if (veiculoRaw) {
        veiculo = veiculoRaw;
      }

      let previsao = '';
      const previsaoRaw = fields.customfield_10245;
      if (previsaoRaw) {
        previsao = formatJiraDate(previsaoRaw);
      }

      let numeroProjeto = '';
      const numeroProjetoRaw = fields.customfield_11353;
      if (numeroProjetoRaw && typeof numeroProjetoRaw === 'object' && numeroProjetoRaw.value) {
        numeroProjeto = String(numeroProjetoRaw.value).trim();
      } else if (numeroProjetoRaw) {
        numeroProjeto = String(numeroProjetoRaw).trim();
      }

      if (!numeroProjeto) {
        const resumoValue = String(fields.summary || '').trim();
        const projetoMatch = resumoValue.match(/\b[A-Z]\d{1,2}\.\d{6,8}\.[A-Z]{2}\b/i);
        numeroProjeto = projetoMatch ? projetoMatch[0].toUpperCase() : '';
      }

      const resumoTexto = fields.summary || '';
      const numerosEncontrados = resumoTexto.match(/\d+/g);
      const resumoNumero = numerosEncontrados ? parseInt(numerosEncontrados[0], 10) : 0;

      return {
        key: issue.key,
        resumo: resumoNumero,
        status: fields.status?.name || '',
        situacao,
        veiculo,
        previsao,
        numeroProjeto: numeroProjeto || '-'
      };
    });

    processedData.sort((a, b) => {
      const veiculoA = (a.veiculo || '').toLowerCase();
      const veiculoB = (b.veiculo || '').toLowerCase();
      return veiculoA.localeCompare(veiculoB);
    });

    // Enrich with DB project data: project code + plate dimensions from cutting plans
    try {
      const dbProjects = await fetchAllProjects();
      const dbMap = new Map();
      for (const p of dbProjects) {
        if (p.project) dbMap.set(String(p.project).trim().toUpperCase(), p);
      }
      for (const item of processedData) {
        const np = String(item.numeroProjeto || '').trim().toUpperCase();
        const dbProject = np && np !== '-' ? dbMap.get(np) : null;
        if (dbProject) {
          const dims = new Set();
          for (const plan of (dbProject.cutting_plans || [])) {
            if (plan.plate_width && plan.plate_height) {
              const w = (Number(plan.plate_width) / 1000).toFixed(2).replace('.', ',');
              const h = (Number(plan.plate_height) / 1000).toFixed(2).replace('.', ',');
              dims.add(`${w}m×${h}m`);
            }
          }
          item.projeto  = dbProject.project || item.numeroProjeto || '';
          item.tamanhos = [...dims].join(', ') || '—';
        } else {
          item.projeto  = item.numeroProjeto && item.numeroProjeto !== '-' ? item.numeroProjeto : '';
          item.tamanhos = '—';
        }
      }
    } catch (dbErr) {
      console.warn('[getPCPRelatorio] Enriquecimento DB falhou (não crítico):', dbErr.message);
    }

    console.log(`✅ [PCP RELATORIO] ${processedData.length} issues processadas`);

    return res.json({
      success: true,
      total: allIssues.length,
      filtered: processedData.length,
      data: processedData
    });

  } catch (error) {
    console.error('❌ Erro ao buscar issues para Relatório PCP:', error.message);

    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        message: `Erro na API do Jira (${error.response.status}): ${error.response.data?.errorMessages?.[0] || error.response.statusText}`,
        details: error.response.data
      });
    }

    if (error.request) {
      return res.status(503).json({
        success: false,
        message: 'Não foi possível conectar ao Jira. Verifique a URL e a conexão de rede.'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Erro ao buscar dados do Jira: ' + error.message
    });
  }
};

export const getMantaRelatorio = async (req, res) => {
  try {
    console.log('🔍 Iniciando busca de issues para Relatório MANTA...');

    let credentials;
    try {
      credentials = await getUserJiraCredentials(req.user.id);
    } catch (credError) {
      return res.status(400).json({
        success: false,
        message: `Erro ao buscar credenciais: ${credError.message}`
      });
    }

    const { email, apiToken } = credentials;
    const jiraUrl = process.env.JIRA_URL;

    if (!jiraUrl) {
      return res.status(500).json({
        success: false,
        message: 'JIRA_URL não configurado no servidor. Contate o administrador.'
      });
    }

    if (!email || !apiToken) {
      return res.status(400).json({
        success: false,
        message: 'Credenciais do Jira não configuradas para seu usuário. Configure no perfil.'
      });
    }

    const jql = 'project = MANTA';
    const url = `${jiraUrl}/rest/api/3/search/jql`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    console.log('🔍 [MANTA RELATORIO] JQL:', jql);

    let allIssues = [];
    let nextPageToken = null;
    let pageCount = 0;

    while (true) {
      pageCount++;

      const params = {
        jql,
        maxResults: 100,
        fields: ['summary', 'status', 'customfield_10039'].join(',')
      };

      if (nextPageToken) {
        params.nextPageToken = nextPageToken;
      }

      const response = await axios.get(url, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${auth}`
        },
        params
      });

      const issues = response.data.issues || [];
      allIssues = [...allIssues, ...issues];

      if (response.data.isLast) break;

      nextPageToken = response.data.nextPageToken || null;
      if (!nextPageToken) break;
    }

    console.log(`🎯 [MANTA RELATORIO] Total de issues coletadas: ${allIssues.length}`);

    const processedData = allIssues.map((issue) => {
      const fields = issue.fields;

      let situacao = '';
      const situacaoRaw = fields.customfield_10039;
      if (situacaoRaw && typeof situacaoRaw === 'object' && situacaoRaw.value) {
        situacao = situacaoRaw.value;
      } else if (situacaoRaw) {
        situacao = situacaoRaw;
      }

      const osMatches = String(fields.summary || '').match(/\b(\d{4,10})\b/g);
      const os = osMatches ? osMatches[osMatches.length - 1] : '';

      return {
        key: issue.key,
        os,
        situacao,
        status: fields.status?.name || ''
      };
    });

    return res.json({
      success: true,
      total: allIssues.length,
      data: processedData
    });

  } catch (error) {
    console.error('❌ Erro ao buscar issues para Relatório MANTA:', error.message);

    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        message: `Erro na API do Jira (${error.response.status}): ${error.response.data?.errorMessages?.[0] || error.response.statusText}`,
        details: error.response.data
      });
    }

    if (error.request) {
      return res.status(503).json({
        success: false,
        message: 'Não foi possível conectar ao Jira. Verifique a URL e a conexão de rede.'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Erro ao buscar dados do Jira: ' + error.message
    });
  }
};

// ===========================================================================
// RELATÓRIO CARBON
// O arquivo é pré-gerado pelo cron (carbonExportJob -> carbonReportService);
// aqui apenas servimos o último xlsx pronto para download na tela do PCP.
// ===========================================================================
export const getCarbonRelatorio = async (req, res) => {
  if (!fs.existsSync(LATEST_FILE)) {
    return res.status(404).json({
      success: false,
      message: 'Relatório Carbon ainda não foi gerado. Aguarde o próximo ciclo (até 15 min).'
    });
  }
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.download(LATEST_FILE, `carbon-relatorio-${ts}.xlsx`);
};

export const getCarbonRelatorioStatus = async (req, res) => {
  res.json({ success: true, ...readStatus(), running: isRunning() });
};