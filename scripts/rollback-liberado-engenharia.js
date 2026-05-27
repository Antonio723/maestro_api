/**
 * Rollback em massa da coluna "Liberado Engenharia".
 *
 * Replica o rollback da página Auditoria (controllers/auditController.js),
 * mas iterando TODOS os cards atualmente na coluna "Liberado Engenharia"
 * (Aramida + Tensylon) em vez das entries de um único registro de auditoria.
 *
 * Para cada card:
 *   1. Apaga os anexos PDF cujo nome começa com "OS-"
 *   2. Limpa os custom fields de m² preenchidos na geração da OS
 *   3. Devolve o card de "Liberado Engenharia" → "A Produzir"
 *
 * Uso:
 *   node scripts/rollback-liberado-engenharia.js <userId>            # dry-run (não altera nada)
 *   node scripts/rollback-liberado-engenharia.js <userId> --apply    # executa de verdade
 *
 *   <userId>  ID do usuário dono das credenciais Jira (tabela maestro.users / jira_credentials).
 *
 * O <userId> é necessário porque toda chamada ao Jira usa as credenciais
 * desse usuário (getCredentials(userId) em services/jiraService.js).
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from '../config/database.js';
import {
  fetchLiberadoEngenhariaIssues,
  listJiraIssueAttachments,
  deleteJiraAttachment,
  updateJiraIssueFields,
  transitionJiraIssue,
} from '../services/jiraService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

// Mesmos campos usados em auditController.js
const ARAMIDA_SQM_FIELDS = [
  'customfield_13625',
  'customfield_13626',
  'customfield_13627',
  'customfield_13631',
  'customfield_13632',
  'customfield_13633',
];
const TENSYLON_SQM_FIELDS = [
  'customfield_13636', // Tensylon M²
  'customfield_13634', // Tensylon M² real
];

function isGeneratedOsPdf(attachment) {
  const filename = String(attachment?.filename || '').trim();
  const mimeType = String(attachment?.mimeType || '').toLowerCase();
  return /^os-.*\.pdf$/i.test(filename) || (filename.toLowerCase().startsWith('os-') && mimeType === 'application/pdf');
}

function fieldsToClear(isTensylon) {
  if (isTensylon) return TENSYLON_SQM_FIELDS;
  return ARAMIDA_SQM_FIELDS;
}

async function main() {
  const userId = Number(process.argv[2]);
  const apply = process.argv.includes('--apply');

  if (!Number.isFinite(userId)) {
    console.error('❌ Informe o userId: node scripts/rollback-liberado-engenharia.js <userId> [--apply]');
    process.exit(1);
  }

  console.log(`\n${apply ? '🔴 MODO APPLY (vai alterar o Jira)' : '🟡 MODO DRY-RUN (nenhuma alteração será feita)'}`);
  console.log(`👤 userId (credenciais Jira): ${userId}\n`);

  // Sem fábrica => traz Aramida (todas as fábricas) + Tensylon na coluna Liberado Engenharia.
  const cards = await fetchLiberadoEngenhariaIssues(userId);
  console.log(`📋 ${cards.length} card(s) em "Liberado Engenharia".\n`);

  if (cards.length === 0) {
    console.log('Nada a fazer.');
    return;
  }

  let deletedAttachments = 0;
  let clearedFieldGroups = 0;
  let movedCards = 0;
  const errors = [];

  for (const card of cards) {
    const key = card.jiraKey;
    const tag = card.isTensylonCard ? 'TENSYLON' : 'ARAMIDA';
    console.log(`• ${key} [${tag}]`);

    // 1. Anexos OS-*.pdf
    try {
      const attachments = await listJiraIssueAttachments(userId, key);
      const generated = attachments.filter(isGeneratedOsPdf);
      for (const att of generated) {
        if (apply) {
          try {
            await deleteJiraAttachment(userId, att.id);
            deletedAttachments++;
            console.log(`    [OK] anexo removido: ${att.filename}`);
          } catch (err) {
            errors.push({ key, msg: `remover anexo ${att.filename}: ${err.message}` });
            console.log(`    [ERRO] remover anexo ${att.filename}: ${err.message}`);
          }
        } else {
          console.log(`    [dry-run] removeria anexo: ${att.filename}`);
        }
      }
      if (generated.length === 0) console.log('    (sem anexos OS-*.pdf)');
    } catch (err) {
      errors.push({ key, msg: `listar anexos: ${err.message}` });
      console.log(`    [ERRO] listar anexos: ${err.message}`);
    }

    // 2. Campos de m²
    const fieldIds = fieldsToClear(card.isTensylonCard);
    if (fieldIds.length) {
      if (apply) {
        try {
          const payload = Object.fromEntries(fieldIds.map((id) => [id, null]));
          await updateJiraIssueFields(userId, key, payload);
          clearedFieldGroups++;
          console.log(`    [OK] m² limpos (${fieldIds.length} campo(s))`);
        } catch (err) {
          const msg = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
          errors.push({ key, msg: `limpar m²: ${msg}` });
          console.log(`    [ERRO] limpar m²: ${msg}`);
        }
      } else {
        console.log(`    [dry-run] limparia m²: ${fieldIds.join(', ')}`);
      }
    }

    // 3. Transição Liberado Engenharia -> A Produzir
    if (apply) {
      try {
        const tr = await transitionJiraIssue(userId, key, 'A Produzir', 'Liberado Engenharia');
        if (tr.changed) {
          movedCards++;
          console.log(`    [OK] movido "${tr.from}" -> "A Produzir"`);
        } else {
          console.log(`    [AVS] não movido (status atual: "${tr.from}", motivo: ${tr.reason})`);
          if (tr.reason === 'unexpected-source-status') {
            errors.push({ key, msg: `status atual "${tr.from}" inesperado` });
          }
        }
      } catch (err) {
        const msg = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
        errors.push({ key, msg: `transição: ${msg}` });
        console.log(`    [ERRO] transição: ${msg}`);
      }
    } else {
      console.log('    [dry-run] moveria "Liberado Engenharia" -> "A Produzir"');
    }
  }

  console.log('\n──────── RESUMO ────────');
  console.log(`Cards processados:   ${cards.length}`);
  console.log(`Anexos removidos:    ${deletedAttachments}`);
  console.log(`Cards com m² limpos: ${clearedFieldGroups}`);
  console.log(`Cards devolvidos:    ${movedCards}`);
  console.log(`Avisos/erros:        ${errors.length}`);
  for (const e of errors) console.log(`   - ${e.key}: ${e.msg}`);
  if (!apply) console.log('\n(Isto foi um DRY-RUN. Rode novamente com --apply para executar.)');
}

main()
  .then(async () => { await pool.end(); process.exit(0); })
  .catch(async (err) => { console.error('❌ Falha:', err); await pool.end(); process.exit(1); });
