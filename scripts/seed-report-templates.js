/**
 * Seed dos relatórios Jasper legados no registry (maestro.report_templates).
 *
 * Lê os 4 .jrxml de printServiceCarbon/src/main/resources/Reports/, parseia as
 * variáveis e cria a versão 1.00 em OPE de cada relatório, com o código JS que
 * monta os parâmetros equivalentes aos endpoints legados do Spring.
 *
 * Idempotente: se o relatório já tiver QUALQUER versão, não cria outra (não
 * sobrescreve edições feitas pela UI). Só faz upsert de name/description.
 *
 * Uso:  node scripts/seed-report-templates.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pool, { ensureDatabaseCompatibility } from '../config/database.js';
import { parseJrxml } from '../services/jrxmlParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../printServiceCarbon/src/main/resources/Reports');

// key → uso lógico; code → param-builder equivalente ao endpoint Spring legado.
const REPORTS = [
  {
    key: 'production-label',
    name: 'Etiqueta de Produção',
    file: 'BR_PROCUTION_LABEL.jrxml',
    description: 'Etiqueta de placa por OT. Legado: GET /etiqueta?otid=.',
    code: 'return { params: { otid: input.otid } };',
  },
  {
    key: 'test-body-label',
    name: 'Etiqueta de Corpo de Prova',
    file: 'BR_LABEL_TEST_BODY.jrxml',
    description: 'Etiqueta de validação de engenharia. Legado: GET /etiqueta2?...',
    code: 'return { params: input };',
  },
  {
    key: 'receipt-label',
    name: 'Etiqueta de Recebimento',
    file: 'BR_LABEL_RECEIPT.jrxml',
    description: 'Etiqueta de recebimento de matéria-prima. Legado: GET /etiquetaReceipt?id=.',
    code: 'return { params: { id: input.id } };',
  },
  {
    key: 'enfesto-report',
    name: 'Relatório de Enfesto',
    file: 'BR_REPORT_ENFESTO REPORT.jrxml',
    description: 'Relatório de enfesto (sem parâmetros). Legado: GET /reportEnfesto.',
    code: 'return { params: {} };',
  },
];

async function seedOne(r) {
  let xml;
  try {
    xml = readFileSync(path.join(REPORTS_DIR, r.file), 'utf8');
  } catch (e) {
    console.warn(`! ${r.key}: arquivo não encontrado (${r.file}) — pulando. ${e.code || e.message}`);
    return;
  }

  const variables = parseJrxml(xml);

  const tpl = await pool.query(
    `INSERT INTO maestro.report_templates (key, name, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
     RETURNING id`,
    [r.key, r.name, r.description]
  );
  const templateId = tpl.rows[0].id;

  const existing = await pool.query(
    `SELECT COUNT(*)::int AS n FROM maestro.report_template_versions WHERE template_id = $1`,
    [templateId]
  );
  if (existing.rows[0].n > 0) {
    console.log(`= ${r.key}: já possui versões — mantido (sem novo insert).`);
    return;
  }

  await pool.query(
    `INSERT INTO maestro.report_template_versions
       (template_id, version_number, status, jrxml, variables, code, notes)
     VALUES ($1, 1.00, 'OPE', $2, $3, $4, $5)`,
    [templateId, xml, variables, r.code, 'Seed automático dos relatórios legados do Spring']
  );

  const params = variables.parameters.filter((p) => !p.isImage).map((p) => p.name).join(', ') || '—';
  console.log(`+ ${r.key}: v1.00 OPE criada (params: ${params}).`);
}

(async () => {
  try {
    console.log('Garantindo schema (ensureDatabaseCompatibility)...');
    await ensureDatabaseCompatibility();
    for (const r of REPORTS) await seedOne(r);
    console.log('Seed de report templates concluído.');
  } catch (e) {
    console.error('Erro no seed de report templates:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
