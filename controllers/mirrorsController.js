import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';

import JSZip from 'jszip';
import { fetchJiraIssues, fetchAramidaIssues, fetchTensylonIssues, attachToJiraIssue, updateJiraIssueFields, deleteJiraAttachment, fetchJiraFields, transitionJiraIssue } from '../services/jiraService.js';
import { fetchAllProjects, fetchProjectsByIds } from '../services/mirrorProjectRepository.js';
import { classifyAll } from '../services/classifierService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── GET /api/mirrors/projects ──────────────────────────────────────────────
//
// Query params:
//   dimension  string  "1.60x3.00"  (ignored when material=tensylon)
//   material   string  "aramida" | "tensylon"  (default: aramida)
//
// Response:
//   {
//     success: true,
//     data: {
//       ready:       [...],   // project exists + plan matches + no issues
//       pending:     [...],   // project exists + plan matches + has issues[]
//       missing:     [...],   // no DB project found for Jira card
//       noDimension: [...],   // project exists but no plan for selected dimension
//       meta: { totalJira, dimension, material }
//     }
//   }
//
export const getProjects = async (req, res) => {
  const { dimension = '1.60x3.00', material = 'aramida', search = '' } = req.query;

  try {
    const [dbProjects, jiraCards] = await Promise.all([
      fetchAllProjects(),
      fetchJiraIssues(req.user.id).catch(err => {
        console.warn('[Mirrors] Jira indisponível:', err.message);
        return [];
      }),
    ]);

    const result = classifyAll(jiraCards, dbProjects, dimension, material);

    if (search.trim()) {
      const t = search.trim().toLowerCase();
      const matches = item =>
        [item.project, item.model, item.brand, item.osNumber,
        item.numeroProjeto, item.veiculo, item.resumo]
          .some(v => String(v || '').toLowerCase().includes(t));
      result.ready = result.ready.filter(matches);
      result.pending = result.pending.filter(matches);
      result.missing = result.missing.filter(matches);
      result.noDimension = result.noDimension.filter(matches);
    }

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Mirrors] getProjects error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/mirrors/projects/aramida ─────────────────────────────────────
//
// Query params:
//   dimension  string  "1.60x3.00"  (default)
//   search     string  free-text filter applied server-side
//
export const getAramidaProjects = async (req, res) => {
  const { dimension = '1.60x3.00', search = '' } = req.query;

  try {
    const [dbProjects, jiraCards] = await Promise.all([
      fetchAllProjects(),
      fetchAramidaIssues(req.user.id).catch(err => {
        console.warn('[Mirrors] Jira Aramida indisponível:', err.message);
        return [];
      }),
    ]);

    const result = classifyAll(jiraCards, dbProjects, dimension, 'aramida');

    if (search.trim()) {
      const t = search.trim().toLowerCase();
      const matches = item =>
        [item.project, item.model, item.brand, item.osNumber,
        item.numeroProjeto, item.veiculo, item.resumo]
          .some(v => String(v || '').toLowerCase().includes(t));
      result.ready = result.ready.filter(matches);
      result.pending = result.pending.filter(matches);
      result.missing = result.missing.filter(matches);
      result.noDimension = result.noDimension.filter(matches);
    }

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Mirrors] getAramidaProjects error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/mirrors/projects/tensylon ────────────────────────────────────
//
// Query params:
//   search  string  free-text filter applied server-side
//
export const getTensylonProjects = async (req, res) => {
  const { search = '' } = req.query;

  try {
    const [dbProjects, jiraCards] = await Promise.all([
      fetchAllProjects(),
      fetchTensylonIssues(req.user.id).catch(err => {
        console.warn('[Mirrors] Jira Tensylon indisponível:', err.message);
        return [];
      }),
    ]);

    const result = classifyAll(jiraCards, dbProjects, null, 'tensylon');

    if (search.trim()) {
      const t = search.trim().toLowerCase();
      const matches = item =>
        [item.project, item.model, item.brand, item.osNumber,
        item.numeroProjeto, item.veiculo, item.resumo]
          .some(v => String(v || '').toLowerCase().includes(t));
      result.ready = result.ready.filter(matches);
      result.pending = result.pending.filter(matches);
      result.missing = result.missing.filter(matches);
      result.noDimension = result.noDimension.filter(matches);
    }

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Mirrors] getTensylonProjects error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── POST /api/mirrors/generate-os ──────────────────────────────────────────
//
// Body: { projects: [{ id, jiraKey, os_number }] }
// Returns: application/zip blob with one folder per OS
//
// Each folder contains:
//   OS-XXXXX.pdf          — cover + InfoProject pages + back cover
//   XXXXX-<name>.txt      — CNC files with XXXXX replaced by the OS number
//
// RELATORIO.txt is always included and lists every step taken per OS.
// Flow per OS: Fase 1 (validação) → Fase 2 (geração PDF+TXT) → Fase 3 (Jira)
// Any error in Fase 1 or 2 aborts that OS and rolls back. Fase 3 side-effects
// (m² fields, status transition) are non-fatal — log [AVS] and continue.
//

// Retry wrapper for unstable I/O and external API calls.
async function retry(fn, attempts = 3, delayMs = 800) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// Phase 1: verify every referenced file has a path and exists on disk.
// Returns array of structured error objects; empty = project is ready to generate.
function validateProjectFiles(proj) {
  const seenIds = new Set();
  const errors = [];
  let validInfoCount = 0;

  for (const plan of (proj.cutting_plans || [])) {
    for (const att of (plan.attachments || [])) {
      if (!att.file?.id || seenIds.has(att.file.id)) continue;
      seenIds.add(att.file.id);

      if (!att.file.path) {
        errors.push({ type: 'VALIDATION_ERROR', file: att.file.name || '?', reason: 'sem path no banco' });
        continue;
      }

      if (!fs.existsSync(att.file.path)) {
        errors.push({ type: 'FILE_MISSING', file: att.file.name || '?', path: att.file.path, reason: 'arquivo não encontrado no filesystem' });
        continue;
      }

      if (att.type === 'infoproject') validInfoCount++;
    }
  }

  if (validInfoCount === 0) {
    errors.push({ type: 'VALIDATION_ERROR', file: null, reason: 'nenhum InfoProject válido e acessível encontrado' });
  }

  return errors;
}

export const generateOS = async (req, res) => {
  try {
    const { projects } = req.body;
    if (!Array.isArray(projects) || !projects.length) {
      return res.status(400).json({ success: false, message: '"projects" array é obrigatório.' });
    }

    const uniqueIds = [...new Set(
      projects.map(p => Number(p.id)).filter(id => Number.isFinite(id) && id > 0)
    )];
    if (!uniqueIds.length) {
      return res.status(400).json({ success: false, message: 'IDs inválidos.' });
    }

    const dbRows = await fetchProjectsByIds(uniqueIds);
    const rowMap = new Map(dbRows.map(r => [r.id, r]));

    const zip = new JSZip();
    const failures = [];
    const fieldWarnings = [];
    const reportLines = [
      'RELATÓRIO DE GERAÇÃO DE OS',
      `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
      `Total de OS: ${projects.length}`,
      '─'.repeat(60),
    ];

    for (const entry of projects) {
      const proj = rowMap.get(Number(entry.id));
      const meta = { osNumber: String(entry.os_number || entry.osNumber || '') };
      const folderName = `OS-${meta.osNumber || entry.jiraKey}`;
      let attachmentIds = [];
      let phase = 'validação';

      const log = [
        '',
        `OS: ${meta.osNumber}  |  Card: ${entry.jiraKey}`,
        `Projeto: ${proj?.project || '?'}  |  Modelo: ${proj?.model || '?'}`,
        `Material: ${proj?.material_type || '?'}`,
        '',
      ];

      // ── Fase 0: existência no banco ────────────────────────────────────────
      if (!proj) {
        const msg = `ID ${entry.id} não encontrado no banco`;
        log.push(`  [ERR] ${msg}`);
        log.push('  → RESULTADO: FALHA');
        reportLines.push(...log, '─'.repeat(60));
        failures.push({ jiraKey: entry.jiraKey, os_number: meta.osNumber, phase, message: msg, type: 'VALIDATION_ERROR' });
        continue;
      }

      // ── Fase 1: validação de arquivos (fail-fast antes de gerar qualquer coisa) ──
      const validationErrs = validateProjectFiles(proj);
      if (validationErrs.length) {
        for (const e of validationErrs) {
          const detail = e.path ? `${e.reason} — path verificado: ${e.path}` : e.reason;
          log.push(`  [ERR] ${e.type}: "${e.file}" — ${detail}`);
        }
        log.push('  → RESULTADO: FALHA (validação)');
        reportLines.push(...log, '─'.repeat(60));
        failures.push({
          jiraKey: entry.jiraKey,
          os_number: meta.osNumber,
          phase,
          message: validationErrs.map(e => `${e.file ?? 'InfoProject'}: ${e.reason}`).join('; '),
          type: 'VALIDATION_ERROR',
          errors: validationErrs,
        });
        continue;
      }
      log.push('  [OK] Fase 1 — validação de arquivos passou');

      try {
        const folder = zip.folder(folderName);

        // ── Fase 2a: Capa ────────────────────────────────────────────────────
        phase = 'geração da capa';
        const singlePdf = await PDFDocument.create();
        await appendFirstPage(singlePdf, proj, meta, 1);
        log.push('  [OK] Capa gerada');

        // ── Fase 2b: páginas InfoProject ─────────────────────────────────────
        phase = 'mesclagem InfoProject';
        const seenInfoIds = new Set();
        let infoPagesTotal = 0;

        for (const plan of (proj.cutting_plans || [])) {
          for (const infoAtt of (plan.attachments || []).filter(a => a.type === 'infoproject')) {
            if (seenInfoIds.has(infoAtt.file?.id)) {
              log.push(`  [SKP] InfoProject "${infoAtt.file?.name}": duplicado`);
              continue;
            }
            seenInfoIds.add(infoAtt.file?.id);

            // Existence guaranteed by Phase 1 — throw if somehow gone
            if (!infoAtt.file?.path || !fs.existsSync(infoAtt.file.path)) {
              throw new Error(`InfoProject "${infoAtt.file?.name}" não encontrado: ${infoAtt.file?.path}`);
            }

            const bytes = await retry(() => fs.promises.readFile(infoAtt.file.path));
            const infoPdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
            const copied = await singlePdf.copyPages(infoPdf, infoPdf.getPageIndices());
            copied.forEach(p => singlePdf.addPage(p));
            infoPagesTotal += copied.length;
            log.push(`  [OK] InfoProject "${infoAtt.file.name}": ${copied.length} pág(s) incluída(s)`);
          }
        }

        if (infoPagesTotal === 0) {
          throw new Error('Nenhuma página InfoProject foi incluída no PDF');
        }
        log.push(`  [OK] InfoProject total: ${infoPagesTotal} pág(s)`);

        // ── Fase 2c: Contracapa ──────────────────────────────────────────────
        phase = 'geração da contracapa';
        await appendLastPage(singlePdf, proj, meta);
        log.push('  [OK] Contracapa gerada');

        const singleBytes = await singlePdf.save();
        folder.file(`${folderName}.pdf`, Buffer.from(singleBytes));
        log.push(`  [OK] PDF salvo no ZIP: ${folderName}.pdf`);

        // ── Fase 2d: arquivos TXT (opcional — aviso, não falha) ──────────────
        phase = 'inclusão de arquivos TXT';
        const seenFileIds = new Set();
        let txtCount = 0;

        for (const plan of (proj.cutting_plans || [])) {
          for (const att of (plan.attachments || [])) {
            if (!att.file?.name?.toLowerCase().endsWith('.txt')) continue;
            if (seenFileIds.has(att.file.id)) {
              log.push(`  [SKP] TXT "${att.file.name}": duplicado`);
              continue;
            }
            seenFileIds.add(att.file.id);

            if (!att.file.path || !fs.existsSync(att.file.path)) {
              log.push(`  [AVS] TXT "${att.file.name}": não encontrado — ${att.file.path}`);
              continue;
            }

            const content = await retry(() => fs.promises.readFile(att.file.path, 'utf8'));
            const destName = `${meta.osNumber}-${att.file.name}`;
            folder.file(destName, content.replace(/XXXXX/g, meta.osNumber));
            txtCount++;
            log.push(`  [OK] TXT incluído: ${destName}`);
          }
        }

        if (txtCount === 0) log.push('  [AVS] Nenhum arquivo TXT encontrado para esta OS');

        // ── Fase 3a: anexar PDF ao Jira (obrigatório — falha desfaz tudo) ────
        phase = 'envio do PDF ao Jira';
        attachmentIds = await retry(
          () => attachToJiraIssue(req.user.id, entry.jiraKey, `${folderName}.pdf`, Buffer.from(singleBytes)),
          3, 800
        );
        log.push(`  [OK] PDF anexado ao card Jira (IDs: ${attachmentIds.join(', ')})`);

        // ── Fase 3b: atualizar campos m² (não-fatal) ─────────────────────────
        phase = 'atualização de campos m²';
        const sqm = {};
        for (const plan of (proj.cutting_plans || [])) {
          for (const [k, v] of Object.entries(plan.square_meters || {})) {
            if (sqm[k] !== undefined) continue;
            const n = parseFloat(String(v ?? '').replace(',', '.'));
            if (Number.isFinite(n) && n > 0) sqm[k] = n;
          }
        }

        const isTensylon = String(proj.material_type || '').toUpperCase() === 'TENSYLON';
        const toJiraStr = n => String(n).replace('.', ',');
        const sqmFields = {};

        if (isTensylon) {
          const f = process.env.JIRA_FIELD_SQM_TENSYLON;
          if (f && sqm.tensylon != null) sqmFields[f] = toJiraStr(sqm.tensylon);
        } else {
          if (sqm['8C'] != null) { const v = toJiraStr(sqm['8C']); sqmFields.customfield_13625 = v; sqmFields.customfield_13633 = v; }
          if (sqm['9C'] != null) { const v = toJiraStr(sqm['9C']); sqmFields.customfield_13626 = v; sqmFields.customfield_13632 = v; }
          if (sqm['11C'] != null) { const v = toJiraStr(sqm['11C']); sqmFields.customfield_13627 = v; sqmFields.customfield_13631 = v; }
        }

        if (Object.keys(sqmFields).length) {
          try {
            await updateJiraIssueFields(req.user.id, entry.jiraKey, sqmFields);
            log.push(`  [OK] Campos m² atualizados: ${JSON.stringify(sqmFields)}`);
          } catch (fieldErr) {
            const fieldMsg = fieldErr?.response?.data
              ? JSON.stringify(fieldErr.response.data)
              : fieldErr.message;
            log.push(`  [AVS] Campos m² NÃO atualizados: ${fieldMsg}`);
            fieldWarnings.push({ jiraKey: entry.jiraKey, os_number: meta.osNumber, message: fieldMsg, fields: Object.keys(sqmFields), type: 'JIRA_ERROR' });
          }
        } else {
          log.push('  [AVS] Sem valores m² no banco — campos Jira não atualizados');
          log.push(`        square_meters encontrados: ${JSON.stringify(sqm)}`);
        }

        // ── Fase 3c: transição de status (não-fatal) ─────────────────────────
        phase = 'transição de status Jira';
        try {
          const tr = await transitionJiraIssue(req.user.id, entry.jiraKey, 'Liberado Engenharia', 'A Produzir');
          if (tr.changed) {
            log.push(`  [OK] Card movido para "Liberado Engenharia" (era: "${tr.from}")`);
          } else if (tr.reason === 'already-in-target') {
            log.push('  [OK] Card já estava em "Liberado Engenharia"');
          } else {
            log.push(`  [AVS] Card não movido — status atual: "${tr.from}" (esperado: "A Produzir")`);
          }
        } catch (trErr) {
          log.push(`  [AVS] Falha na transição de status: ${trErr.message}`);
        }

        log.push('  → RESULTADO: SUCESSO');

      } catch (err) {
        // Rollback: remove quaisquer anexos já enviados ao Jira
        for (const attId of attachmentIds) {
          try {
            await deleteJiraAttachment(req.user.id, attId);
            log.push(`  [RLB] Rollback: anexo ${attId} removido do Jira`);
          } catch (delErr) {
            log.push(`  [RLB] Rollback falhou para anexo ${attId}: ${delErr.message}`);
          }
        }
        zip.remove(folderName);

        failures.push({ jiraKey: entry.jiraKey, os_number: meta.osNumber, phase, message: err.message, type: 'PROCESSING_ERROR' });
        log.push(`  [ERR] Fase "${phase}": ${err.message}`);
        log.push('  → RESULTADO: FALHA');
      }

      reportLines.push(...log, '─'.repeat(60));
    }

    const successCount = projects.length - failures.length;
    if (successCount === 0) {
      return res.status(422).json({ success: false, message: 'Todas as OS falharam ao ser geradas.', failures });
    }

    reportLines.push('', `Concluído: ${successCount} sucesso(s), ${failures.length} falha(s), ${fieldWarnings.length} aviso(s) de campos`);
    zip.file('RELATORIO.txt', reportLines.join('\n'));

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="OS-${Date.now()}.zip"`);
    res.setHeader('X-OS-Failures', JSON.stringify(failures));
    res.setHeader('X-OS-Field-Warnings', JSON.stringify(fieldWarnings));
    return res.end(zipBuffer);
  } catch (error) {
    console.error('[Mirrors] generateOS error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/mirrors/jira-fields ───────────────────────────────────────────
//
// Returns all Jira custom fields with id, name, and type.
// Use this to find the correct customfield_XXXXX IDs for m² fields.
// Optional query param ?search=<term> to filter by name.
//
export const getJiraFieldsList = async (req, res) => {
  try {
    const allFields = await fetchJiraFields(req.user.id);
    const { search = '' } = req.query;
    const filtered = search
      ? allFields.filter(f => f.name.toLowerCase().includes(search.toLowerCase()))
      : allFields;
    return res.json({ success: true, data: { fields: filtered, total: filtered.length } });
  } catch (error) {
    console.error('[Mirrors] getJiraFieldsList error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── PDF helpers ─────────────────────────────────────────────────────────────

export async function appendFirstPage(mergedPdf, project, meta, packageNumber) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const backendRoot = path.join(__dirname, '..');
  const footerCandidates = [
    path.join(backendRoot, 'scripts', 'projetos', 'logo-footer.png'),
    path.join(backendRoot, 'scripts', 'projetos', 'footer.png'),
  ];
  const footerPath = footerCandidates.find(c => fs.existsSync(c));
  const topLogoPath = path.join(backendRoot, 'scripts', 'projetos', 'logo.png');

  const marginLeft = 58;
  const isTensylonProject = String(project.material_type || '').toUpperCase() === 'TENSYLON';

  // ── Logo ──────────────────────────────────────────────────────────────────
  let yPos = height - 100;
  if (fs.existsSync(topLogoPath)) {
    try {
      let logoBytes = await fs.promises.readFile(topLogoPath);
      if (logoBytes.toString('utf8', 0, 8).startsWith('iVBORw0K')) {
        logoBytes = Buffer.from(logoBytes.toString('utf8'), 'base64');
      }
      const logoImg = await doc.embedPng(logoBytes);
      const logoW = 130;
      const logoH = (logoImg.height / logoImg.width) * logoW;
      page.drawImage(logoImg, { x: (width - logoW) / 2, y: yPos - 10, width: logoW, height: logoH });
      yPos -= 18;
    } catch {
      page.drawText('OPERA', { x: width / 2 - 30, y: yPos, size: 16, font: fontBold, color: rgb(0.4, 0.6, 0.8) });
      yPos -= 15;
      page.drawText('Armouring Materials', { x: width / 2 - 45, y: yPos, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
    }
  } else {
    page.drawText('OPERA', { x: width / 2 - 30, y: yPos, size: 16, font: fontBold, color: rgb(0.4, 0.6, 0.8) });
    yPos -= 15;
    page.drawText('Armouring Materials', { x: width / 2 - 45, y: yPos, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
  }

  // ── "Pacote N – Kit" top right ────────────────────────────────────────────
  const pkgLabel = `Pacote ${packageNumber} - Kit`;
  const pkgW = fontBold.widthOfTextAtSize(pkgLabel, 10);
  page.drawText(pkgLabel, {
    x: width - marginLeft - pkgW, y: height - 45,
    size: 10, font: fontBold, color: rgb(0.16, 0.44, 0.72),
  });

  // ── Material badge ────────────────────────────────────────────────────────
  const tituloMaterial = isTensylonProject ? 'Tensylon' : 'Aramida';
  const titleSize = 21;
  const titleW = fontBold.widthOfTextAtSize(tituloMaterial, titleSize);
  const titleX = width / 2 - titleW / 2;
  yPos -= 50;
  page.drawRectangle({ x: titleX - 8, y: yPos - 4, width: titleW + 16, height: titleSize + 7, color: rgb(1, 0.95, 0.2) });
  page.drawText(tituloMaterial, { x: titleX, y: yPos, size: titleSize, font: fontBold, color: rgb(0, 0, 0) });

  // ── Helper: centred text in a box ─────────────────────────────────────────
  const drawCentered = (text, bx, by, bw, bh, size, useBold, color) => {
    const f = useBold ? fontBold : font;
    const v = String(text || '');
    const tw = f.widthOfTextAtSize(v, size);
    page.drawText(v, { x: bx + (bw - tw) / 2, y: by + (bh - size) / 2 + 2, size, font: f, color });
  };

  // ── Document fields ───────────────────────────────────────────────────────
  yPos -= 60;
  const lineHeight = 45;
  const fieldSize = 16;

  const regras = [
    ["B.E.V-TFM", "Full Tensylon"],
    ["B.E.V-TPM", "Tensylon Parcial"],
    ["B.E.V-M", "Padrão"],
    ["TFM", "Full Tensylon"],
    ["TPM", "Tensylon Parcial"],
    ["M", "Padrão"],
  ];

  // encontra a regra
  const regra = regras.find(([prefixo]) =>
    (project.project || "").startsWith(prefixo)
  );

  // variável final com fallback
  const kit = regra ? regra[1] : "-";

  const fields = [
    ['Modelo:', project.model, project.brand || '-'],
    ['Kit:', kit], 
    ['Tipo de teto:', project.roof_config || '-'],
    ['Projeto:', project.project || '-'],
    ['Data:', new Date().toLocaleDateString('pt-BR')],
    ['Quantidade de peças:', String(project.total_parts_qty || '-')],
    ['OS:', meta.osNumber || '-'],
  ];

  // Aggregate square_meters across all plans (first non-empty value per key)
  const sqm = {};
  for (const plan of (project.cutting_plans || [])) {
    for (const [k, v] of Object.entries(plan.square_meters || {})) {
      if (v && String(v).trim() && sqm[k] === undefined) sqm[k] = String(v).trim();
    }
  }

  for (const [label, value] of fields) {
    page.drawText(label, { x: marginLeft, y: yPos, size: fieldSize, font: fontBold, color: rgb(0, 0, 0) });
    const lw = fontBold.widthOfTextAtSize(label, fieldSize);
    page.drawText(String(value), { x: marginLeft + lw + 6, y: yPos, size: fieldSize, font, color: rgb(0, 0, 0) });
    yPos -= lineHeight;

    // Consumption table immediately after OS field (Aramida only)
    if (label === 'OS:' && !isTensylonProject) {
      const consumoKeys = ['8C', '9C', '11C'];
      const consumoColors = [rgb(0.08, 0.08, 0.95), rgb(0.1, 0.45, 0.13), rgb(0.95, 0.05, 0.05)];
      const tableW = Math.min((width - marginLeft * 2) * 0.88, 520);
      const colW = tableW / 3;
      const hdrH = 30;
      const valH = 26;
      const labelY = yPos - 6;
      const tableTopY = labelY - 10 - hdrH;

      page.drawText('Consumo (m²):', { x: marginLeft, y: labelY, size: fieldSize, font: fontBold, color: rgb(0, 0, 0) });

      for (let i = 0; i < 3; i++) {
        const cx = marginLeft + i * colW;
        page.drawRectangle({ x: cx, y: tableTopY, width: colW, height: hdrH, color: consumoColors[i], borderColor: rgb(0, 0, 0), borderWidth: 1 });
        drawCentered(consumoKeys[i], cx, tableTopY, colW, hdrH, 14, false, rgb(1, 1, 1));
      }
      const valY = tableTopY - valH;
      for (let i = 0; i < 3; i++) {
        const cx = marginLeft + i * colW;
        page.drawRectangle({ x: cx, y: valY, width: colW, height: valH, color: rgb(1, 1, 1), borderColor: rgb(0, 0, 0), borderWidth: 1 });
        drawCentered(sqm[consumoKeys[i]] || '', cx, valY, colW, valH, 13, false, rgb(0, 0, 0));
      }
      yPos = valY - 18;
    }
  }

  // ── QR code ───────────────────────────────────────────────────────────────
  const qrPayload = [project.model, project.roof_config, project.project, meta.osNumber]
    .filter(v => String(v || '').trim()).join('\n');

  const qrDataUrl = await QRCode.toDataURL(qrPayload || project.project || '', { margin: 1, width: 300 });
  const qrBytes = Buffer.from(qrDataUrl.split(',')[1], 'base64');
  const qrImg = await doc.embedPng(qrBytes);

  yPos -= 30;
  const qrSize = 92;
  const qrX = width / 2 - qrSize / 2;
  const qrY = yPos - qrSize;

  // ── Footer background image ───────────────────────────────────────────────
  if (footerPath) {
    try {
      let fBytes = await fs.promises.readFile(footerPath);
      if (fBytes.toString('utf8', 0, 8).startsWith('iVBORw0K')) {
        fBytes = Buffer.from(fBytes.toString('utf8'), 'base64');
      }
      const fImg = await doc.embedPng(fBytes);
      const fH = (fImg.height / fImg.width) * width;
      page.drawImage(fImg, { x: 0, y: 0, width, height: fH, opacity: 0.9 });
    } catch { /* footer image optional */ }
  }

  // ── Footer text ───────────────────────────────────────────────────────────
  const footerY = 80;
  ['Avenida Tucunaré 421', 'Tamboré • Barueri – SP', 'CEP 06460-020', '+55 11 0000 0000', 'www.operacomposite.com']
    .forEach((line, i) => page.drawText(line, { x: marginLeft - 28, y: footerY - i * 10, size: 7, font, color: rgb(0.36, 0.36, 0.36) }));

  // ── Social icons ──────────────────────────────────────────────────────────
  const iconFill = rgb(0.08, 0.36, 0.56);
  const iconsY = footerY - 56;
  const iconStartX = marginLeft - 21;
  [{ label: 'IG', size: 5.2 }, { label: 'f', size: 8.5 }, { label: 'YT', size: 4.8 }, { label: 'in', size: 5.6 }]
    .forEach(({ label, size }, idx) => {
      const cx = iconStartX + idx * 20;
      page.drawCircle({ x: cx, y: iconsY, size: 7, color: iconFill });
      const tw = fontBold.widthOfTextAtSize(label, size);
      page.drawText(label, { x: cx - tw / 2, y: iconsY - size / 3, size, font: fontBold, color: rgb(1, 1, 1) });
    });

  // ── QR drawn last (on top) ────────────────────────────────────────────────
  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });

  const revText = 'FO 21.1 - REV. 1';
  const revW = font.widthOfTextAtSize(revText, 7);
  page.drawText(revText, { x: qrX + qrSize / 2 - revW / 2, y: qrY - 12, size: 7, font, color: rgb(0.42, 0.42, 0.42) });

  const built = await PDFDocument.load(await doc.save());
  const [copied] = await mergedPdf.copyPages(built, [0]);
  mergedPdf.addPage(copied);
}


export async function appendLastPage(mergedPdf, project, meta) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const marginLeft = 58;
  const backendRoot = path.join(__dirname, '..');
  const topLogoPath = path.join(backendRoot, 'scripts', 'projetos', 'logo.png');

  const footerCandidates = [
    path.join(backendRoot, 'scripts', 'projetos', 'logo-footer.png'),
    path.join(backendRoot, 'scripts', 'projetos', 'footer.png'),
  ];
  const footerPath = footerCandidates.find(c => fs.existsSync(c));

  const isTensylon = String(project.material_type || '').toUpperCase() === 'TENSYLON';
  const materialLabel = isTensylon ? 'Tensylon' : 'Aramida';

  let y = height - 80;

  // ── Logo ──────────────────────────────────────────────────────────────────
  if (fs.existsSync(topLogoPath)) {
    try {
      const logoBytes = await fs.promises.readFile(topLogoPath);
      const logoImg = await doc.embedPng(logoBytes);
      const logoW = 120;
      const logoH = (logoImg.height / logoImg.width) * logoW;

      page.drawImage(logoImg, {
        x: (width - logoW) / 2,
        y: height - 100,
        width: logoW,
        height: logoH,
      });

      y -= 40;
    } catch {
      page.drawText('OPERA', {
        x: width / 2 - 30,
        y: height - 80,
        size: 14,
        font: fontBold,
      });
    }
  }

  // ── Header right ──────────────────────────────────────────────────────────
  page.drawText('Pacote 2 - Tampa', {
    x: width - 180,
    y: height - 50,
    size: 10,
    font,
    color: rgb(0.2, 0.4, 0.6),
  });

  y -= 50;

  // ── Material label ────────────────────────────────────────────────────────
  const matSize = 18;
  const matWidth = fontBold.widthOfTextAtSize(materialLabel, matSize);
  const matX = width / 2 - matWidth / 2;

  page.drawRectangle({
    x: matX - 12,
    y: y - 6,
    width: matWidth + 26,
    height: matSize + 10,
    color: rgb(1, 1, 0),
  });

  page.drawText(materialLabel, {
    x: matX,
    y,
    size: matSize + 2,
    font: fontBold,
  });

  y -= 60;

  // ── Tag ───────────────────────────────────────────────────────────────────
  page.drawRectangle({
    x: marginLeft,
    y: y - 4,
    width: 145,
    height: 22,
    color: rgb(0.1, 0.1, 0.5),
  });

  page.drawText('Tampa traseira', {
    x: marginLeft + 6,
    y,
    size: matSize,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  y -= 45;

  // ── Helper para valores seguros ───────────────────────────────────────────
  const safe = v => (v === null || v === undefined || v === '' ? '-' : String(v));

  // ── Info fields (COM OS INTEGRADO) ────────────────────────────────────────
  const labelSize = 16;
  const lineGap = 32;
  const spacing = 6;

  const info = [
    ['Modelo:', safe(project.model)],
    ['Projeto:', safe(project.project)],
    ['Quantidade:', safe(project.lid_parts_qty)],
    ['OS:', safe(meta?.osNumber)],
  ];

  for (const [label, value] of info) {
    page.drawText(label, {
      x: marginLeft,
      y,
      size: labelSize,
      font: fontBold,
    });

    const lw = fontBold.widthOfTextAtSize(label, labelSize);

    page.drawText(value, {
      x: marginLeft + lw + spacing,
      y,
      size: labelSize,
      font,
    });

    y -= lineGap;
  }

  // ── Footer image ──────────────────────────────────────────────────────────
  if (footerPath) {
    try {
      let fBytes = await fs.promises.readFile(footerPath);
      if (fBytes.toString('utf8', 0, 8).startsWith('iVBORw0K')) {
        fBytes = Buffer.from(fBytes.toString('utf8'), 'base64');
      }

      const fImg = await doc.embedPng(fBytes);
      const fH = (fImg.height / fImg.width) * width;

      page.drawImage(fImg, {
        x: 0,
        y: 0,
        width,
        height: fH,
        opacity: 0.9,
      });
    } catch {
      // opcional
    }
  }

  // ── Footer text ───────────────────────────────────────────────────────────
  const footerY = 80;

  [
    'Avenida Tucunaré 421',
    'Tamboré • Barueri – SP',
    'CEP 06460-020',
    '+55 11 0000 0000',
    'www.operacomposite.com'
  ].forEach((line, i) => {
    page.drawText(line, {
      x: marginLeft - 28,
      y: footerY - i * 10,
      size: 7,
      font,
      color: rgb(0.36, 0.36, 0.36),
    });
  });

  // ── Social icons ──────────────────────────────────────────────────────────
  const iconFill = rgb(0.08, 0.36, 0.56);
  const iconsY = footerY - 56;
  const iconStartX = marginLeft - 21;

  [
    { label: 'IG', size: 5.2 },
    { label: 'f', size: 8.5 },
    { label: 'YT', size: 4.8 },
    { label: 'in', size: 5.6 },
  ].forEach(({ label, size }, idx) => {
    const cx = iconStartX + idx * 20;

    page.drawCircle({
      x: cx,
      y: iconsY,
      size: 7,
      color: iconFill,
    });

    const tw = fontBold.widthOfTextAtSize(label, size);

    page.drawText(label, {
      x: cx - tw / 2,
      y: iconsY - size / 3,
      size,
      font: fontBold,
      color: rgb(1, 1, 1),
    });
  });

  // ── Revision ──────────────────────────────────────────────────────────────
  const revText = 'FO.21.1 - REV. 1';
  const revW = font.widthOfTextAtSize(revText, 8);

  page.drawText(revText, {
    x: width / 2 - revW / 2,
    y: 40,
    size: 8,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  // ── Merge no PDF final ────────────────────────────────────────────────────
  const built = await PDFDocument.load(await doc.save());
  const [copied] = await mergedPdf.copyPages(built, [0]);
  mergedPdf.addPage(copied);
}

