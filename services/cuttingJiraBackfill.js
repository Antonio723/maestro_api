import pool from '../config/database.js';
import { resolveJiraCardForCutting, pickBoardForCutting } from './jiraCardLookup.js';

// Vínculo de jira_key em public.cutting_records.
//
// FONTE ÚNICA da heurística: delega ao resolveJiraCardForCutting — o MESMO
// critério usado no apontamento (create/update). Isso elimina a duplicação
// JS×SQL que existia no antigo backfill por UPDATE..JOIN e causou o bug de
// board (Tensylon casando com card MANTA). Aqui não há regra de board
// reimplementada: se a heurística mudar, muda num lugar só.
//
// Modos:
//   - fill (sempre): resolve e grava registros com jira_key NULL.
//   - reconcile (opt-in): antes do fill, zera keys já gravados cujo board
//     diverge do esperado pela heurística, pra serem re-resolvidos no fill.
//     Conserta keys errados (ex.: Tensylon→MANTA) sem SQL manual.

const KEY_BOARD_RE = /^([A-Za-z]+)-/;

// Extrai o board do key (MANTA-123 -> 'MANTA', TENSYLON-9 -> 'TENSYLON').
function keyBoard(key) {
  const m = String(key || '').match(KEY_BOARD_RE);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Preenche/concilia jira_key dos cortes.
 * @param {object} opts
 * @param {number} [opts.limit=100] teto de registros varridos por passo.
 * @param {boolean} [opts.reconcile=false] também re-resolve keys com board errado.
 * @param {import('pg').Pool|import('pg').PoolClient} [opts.client=pool]
 * @returns {Promise<{scanned:number, filled:number, reconciled:number}>}
 */
export async function backfillCuttingJiraKeys({ limit = 100, reconcile = false, client = pool } = {}) {
  const cap = Math.max(1, Math.min(5000, Number(limit) || 100));
  let reconciled = 0;

  // Passo reconcile: zera keys cujo board não bate com o esperado. Os registros
  // zerados caem no passo de fill abaixo e são re-resolvidos.
  if (reconcile) {
    const { rows } = await client.query(
      `SELECT id, order_number, material, kit_type, jira_key
         FROM public.cutting_records
        WHERE jira_key IS NOT NULL
        ORDER BY id DESC
        LIMIT $1`,
      [cap],
    );
    for (const r of rows) {
      const expected = pickBoardForCutting({ material: r.material, kitType: r.kit_type });
      const actual = keyBoard(r.jira_key);
      // Só intervém quando há board esperado E ele diverge do key atual.
      if (expected && actual && expected !== actual) {
        const upd = await client.query(
          'UPDATE public.cutting_records SET jira_key = NULL WHERE id = $1 AND jira_key = $2',
          [r.id, r.jira_key],
        );
        reconciled += upd.rowCount;
        if (upd.rowCount > 0) {
          console.warn(
            `[CuttingJiraBackfill] reconcile: OS ${r.order_number} (id ${r.id}) tinha ${r.jira_key} ` +
              `mas board esperado é ${expected} — zerado para re-resolver.`,
          );
        }
      }
    }
  }

  // Passo fill: resolve e grava os NULL (inclui os zerados pelo reconcile).
  const { rows } = await client.query(
    `SELECT id, order_number, material, kit_type
       FROM public.cutting_records
      WHERE jira_key IS NULL
      ORDER BY id DESC
      LIMIT $1`,
    [cap],
  );

  let filled = 0;
  for (const r of rows) {
    try {
      const { key } = await resolveJiraCardForCutting(
        { orderNumber: r.order_number, material: r.material, kitType: r.kit_type },
        client,
      );
      if (!key) continue; // card ainda não sincronizado — próxima passada tenta de novo.
      // Guard `jira_key IS NULL` evita corrida com apontamento concorrente.
      const upd = await client.query(
        'UPDATE public.cutting_records SET jira_key = $1 WHERE id = $2 AND jira_key IS NULL',
        [key, r.id],
      );
      filled += upd.rowCount;
    } catch (err) {
      // Falha por registro não derruba o lote.
      console.warn(`[CuttingJiraBackfill] OS ${r.order_number} (id ${r.id}) falhou: ${err.message}`);
    }
  }

  return { scanned: rows.length, filled, reconciled };
}
