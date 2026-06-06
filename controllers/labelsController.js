// Etiquetagem — endpoints que servem a tela de impressão de etiquetas ZPL.
// Lê os .txt da pasta LABELS_DIR (a mesma onde o generateOS grava os TXT da OS).

import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  listFileSummaries,
  loadFileData,
  findItemByKey,
  buildItemLabel,
  buildLabelPdf,
  LABELS_DIR,
} from '../services/labelService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(__dirname, '../print-agent');

// GET /api/labels/agent — baixa o Agente de Impressão (PowerShell) zipado, para
// rodar na estação Windows. Sem o agente, a tela imprime pelo diálogo do navegador.
export const downloadAgent = async (req, res) => {
  try {
    const names = await readdir(AGENT_DIR);
    const zip = new JSZip();
    const folder = zip.folder('orquestra-agente-impressao');
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const buf = await readFile(path.join(AGENT_DIR, name));
      folder.file(name, buf);
    }
    const content = await zip.generateAsync({ type: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="orquestra-agente-impressao.zip"');
    res.setHeader('Content-Length', content.length);
    return res.end(content);
  } catch (error) {
    console.error('❌ Erro ao gerar zip do agente:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};

// GET /api/labels/files — lista os arquivos (OS) disponíveis na pasta.
export const listFiles = async (req, res) => {
  try {
    const files = await listFileSummaries();
    return res.status(200).json({ success: true, data: files, dir: LABELS_DIR });
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

