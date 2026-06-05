// Etiquetagem — endpoints que servem a tela de impressão de etiquetas ZPL.
// Lê os .txt da pasta LABELS_DIR (a mesma onde o generateOS grava os TXT da OS).

import {
  listFileSummaries,
  loadFileData,
  findItemByKey,
  buildItemLabel,
  buildLabelPdf,
  printZpl,
  isPrinterConfigured,
  listWindowsPrinters,
  LABELS_DIR,
} from '../services/labelService.js';

// GET /api/labels/files — lista os arquivos (OS) disponíveis na pasta.
export const listFiles = async (req, res) => {
  try {
    const files = await listFileSummaries();
    return res.status(200).json({ success: true, data: files, dir: LABELS_DIR, printerConfigured: isPrinterConfigured() });
  } catch (error) {
    console.error('❌ Erro ao listar arquivos de etiqueta:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/labels/items?file=<nome> — itens (peças) de um arquivo.
export const listItems = async (req, res) => {
  try {
    const fileName = req.query.file;
    if (!fileName) return res.status(400).json({ success: false, message: 'Parâmetro "file" é obrigatório.' });
    const data = await loadFileData(String(fileName));
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    if (/não encontrado|permitida/.test(error.message)) {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error('❌ Erro ao carregar itens de etiqueta:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/labels/preview.pdf?key=<file#id> — PDF de modelo da etiqueta.
export const labelPreviewPdf = async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ success: false, message: 'Parâmetro "key" é obrigatório.' });
    const item = await findItemByKey(String(key));
    if (!item) return res.status(404).json({ success: false, message: 'Item não encontrado.' });

    const pdf = buildLabelPdf(item);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="modelo-etiqueta.pdf"');
    res.setHeader('Content-Length', pdf.length);
    return res.end(pdf);
  } catch (error) {
    console.error('❌ Erro ao gerar PDF de etiqueta:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/labels/zpl?key=<file#id> — baixa o .zpl do item.
export const downloadZpl = async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ success: false, message: 'Parâmetro "key" é obrigatório.' });
    const item = await findItemByKey(String(key));
    if (!item) return res.status(404).json({ success: false, message: 'Item não encontrado.' });

    const zpl = buildItemLabel(item);
    const safe = `${item.order || 'sem-os'}-N${item.id}`.replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.zpl"`);
    return res.end(zpl);
  } catch (error) {
    console.error('❌ Erro ao gerar ZPL:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/labels/printers — impressoras do Windows (para o seletor da tela).
// Em backend não-Windows volta lista vazia.
export const listPrinters = async (req, res) => {
  try {
    const printers = await listWindowsPrinters();
    return res.status(200).json({ success: true, data: printers, platform: process.platform });
  } catch (error) {
    console.error('❌ Erro ao listar impressoras do Windows:', error);
    return res.status(200).json({ success: true, data: [], platform: process.platform });
  }
};

// POST /api/labels/print  { key, mode, printerName, printerHost, printerPort }
//   mode 'network' → Zebra de rede (TCP 9100).
//   mode 'windows' → impressora compartilhada do Windows (copy /B \\host\share).
// A configuração da tela (por dispositivo) tem prioridade sobre o env. Sem nenhuma
// impressora configurada, devolve o ZPL para download no cliente.
export const printItem = async (req, res) => {
  try {
    const key = req.body?.key;
    if (!key) return res.status(400).json({ success: false, message: 'Item não informado.' });
    const item = await findItemByKey(String(key));
    if (!item) return res.status(404).json({ success: false, message: 'Item não encontrado.' });

    const zpl = buildItemLabel(item);

    const mode = req.body?.mode ? String(req.body.mode).toLowerCase() : '';
    const reqHost = req.body?.printerHost ? String(req.body.printerHost).trim() : '';
    const reqPort = req.body?.printerPort ? Number(req.body.printerPort) : undefined;
    const reqName = req.body?.printerName ? String(req.body.printerName).trim() : '';

    // O que a tela informou para o modo escolhido?
    const screenHasTarget = mode === 'windows' ? Boolean(reqName) : Boolean(reqHost);

    if (!screenHasTarget && !isPrinterConfigured()) {
      // Sem impressora (nem da tela, nem do servidor): cliente baixa o ZPL.
      return res.status(200).json({ success: true, status: 'zpl', zpl, message: 'Nenhuma impressora configurada — ZPL retornado para download.' });
    }

    const result = await printZpl(zpl, {
      mode: mode || undefined,
      // Modo Windows usa o host do compartilhamento (localhost/env), NUNCA o
      // campo de IP da rede — senão um "IP:porta" vira UNC inválida (\\ip:porta\share).
      host: mode === 'windows' ? undefined : (reqHost || undefined),
      port: reqPort,
      name: reqName || undefined,
    });
    return res.status(200).json({ success: true, status: 'printed', printer: result.printer, mode: result.mode });
  } catch (error) {
    console.error('❌ Erro ao imprimir etiqueta:', error);
    return res.status(502).json({ success: false, message: `Falha ao imprimir: ${error.message}` });
  }
};
