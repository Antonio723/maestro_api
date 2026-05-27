// Etapa 8 da SPEC-faturamento-paineis.md
// Importa o histórico da planilha "Fábrica de Opaco - Rev2.xlsx":
//   - aba `Notas Recebidas`  → maestro.panel_receipts (upsert por
//                             supplier+external_batch+invoice_number).
//   - aba `Base` (Aramida)   → maestro.panel_consumptions (cada linha tem
//                             até 3 tuplas NF+Lote+m²; cutting_record_id
//                             fica NULL porque cutting_records vive no
//                             backend CarbonProduction).
// Aba `Tensylon` não é importada — é produção interna OPERA, sem painel
// externo, então não vira panel_consumptions. Quando o backend
// CarbonProduction estiver disponível, estender com inserts em
// cutting_records/consumptions + vínculo via cutting_record_id real.
//
// Idempotência:
//   - panel_receipts: chave (supplier, external_batch, invoice_number);
//     update conservador no caso de duplicata.
//   - panel_consumptions: soft-cancel das alocações históricas
//     (cutting_record_id IS NULL) por OS antes de reimportar. Re-execução
//     reseta o histórico daquela OS, então o resultado é determinístico.
//
// Saída:
//   - log no stdout com contagens
//   - import-divergencias.csv (ao lado do .xlsx) com lotes apontados sem
//     recebimento correspondente, NFs sem match, etc.
//
// Uso:
//   npm install                          # instala exceljs se ainda não tiver
//   npm run import-opaco -- <arquivo.xlsx>
// Ex.: npm run import-opaco -- "../Fábrica de Opaco - Rev2.xlsx"

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import pool from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DEFAULT_FILE = path.resolve(__dirname, '..', '..', 'Fábrica de Opaco - Rev2.xlsx');

function parseLayersValue(value) {
  if (value === null || value === undefined || value === '') return null;
  // "8 CAMADAS", "8", 8 → 8
  const m = String(value).match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseM2Value(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDateValue(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function normalizeStatus(value) {
  if (!value) return 'AUTO';
  const v = String(value).trim().toLowerCase();
  if (v.includes('ok') || v.includes('valid')) return 'VALIDATED';
  return 'AUTO';
}

function trimOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

async function importPanelReceipts(worksheet) {
  // Linha 1 é cabeçalho; mapeamos colunas pelo header (case-insensitive).
  const headerRow = worksheet.getRow(1);
  const colByHeader = new Map();
  headerRow.eachCell((cell, colNumber) => {
    const k = String(cell.value || '').trim().toLowerCase();
    if (k && !colByHeader.has(k)) colByHeader.set(k, colNumber);
  });
  const col = (...keys) => {
    for (const k of keys) {
      const idx = colByHeader.get(k.toLowerCase());
      if (idx) return idx;
    }
    return null;
  };

  const idx = {
    receivedAt:    col('dt. recebimento', 'data recebimento', 'data'),
    invoiceNumber: col('nota', 'nf', 'nota fiscal'),
    externalBatch: col('lote'),
    layers:        col('camadas'),
    receivedM2:    col('metragem recebida', 'metragem'),
    status:        col('status', 'obs'),
    supplier:      col('fornecedor'),
  };

  const required = ['receivedAt', 'externalBatch', 'layers', 'receivedM2', 'supplier'];
  const missing = required.filter(k => !idx[k]);
  if (missing.length) {
    throw new Error(`Colunas obrigatórias não encontradas no header: ${missing.join(', ')}`);
  }

  const stats = { read: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    stats.read++;

    const supplier      = trimOrNull(row.getCell(idx.supplier).value)?.toUpperCase();
    const externalBatch = trimOrNull(row.getCell(idx.externalBatch).value)?.toUpperCase();
    const invoiceNumber = idx.invoiceNumber ? trimOrNull(row.getCell(idx.invoiceNumber).value) : null;
    const layers        = parseLayersValue(row.getCell(idx.layers).value);
    const receivedM2    = parseM2Value(row.getCell(idx.receivedM2).value);
    const receivedAt    = parseDateValue(row.getCell(idx.receivedAt).value);
    const status        = idx.status ? normalizeStatus(row.getCell(idx.status).value) : 'AUTO';

    // Linhas vazias / sem fornecedor → pula sem warn
    if (!supplier && !externalBatch && !receivedAt) {
      stats.skipped++;
      continue;
    }
    if (!supplier || !externalBatch || layers === null || receivedM2 === null || !receivedAt) {
      stats.skipped++;
      stats.errors.push(`linha ${rowNumber}: campos obrigatórios faltando (supplier=${supplier}, batch=${externalBatch}, layers=${layers}, m2=${receivedM2}, data=${receivedAt})`);
      continue;
    }

    try {
      // Tenta achar registro existente (mesma chave de duplicidade da migration).
      const existing = await pool.query(
        invoiceNumber
          ? `SELECT id FROM maestro.panel_receipts
              WHERE supplier = $1 AND external_batch = $2 AND invoice_number = $3`
          : `SELECT id FROM maestro.panel_receipts
              WHERE supplier = $1 AND external_batch = $2 AND invoice_number IS NULL`,
        invoiceNumber ? [supplier, externalBatch, invoiceNumber] : [supplier, externalBatch],
      );

      if (existing.rows.length) {
        // Update conservador: só atualiza received_m2/data/status — preserva
        // validated_by/validated_at, notes e o saldo derivado (consumed/reserved).
        await pool.query(
          `UPDATE maestro.panel_receipts
              SET layers = $2,
                  received_m2 = $3,
                  received_at = $4,
                  validation_status = CASE
                    WHEN $5 = 'VALIDATED' AND validation_status = 'AUTO' THEN 'VALIDATED'
                    ELSE validation_status
                  END,
                  updated_at = now()
            WHERE id = $1`,
          [existing.rows[0].id, layers, receivedM2, receivedAt, status],
        );
        stats.updated++;
      } else {
        await pool.query(
          `INSERT INTO maestro.panel_receipts
             (supplier, external_batch, invoice_number, layers, received_m2, received_at, validation_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [supplier, externalBatch, invoiceNumber, layers, receivedM2, receivedAt, status],
        );
        stats.inserted++;
      }
    } catch (err) {
      stats.errors.push(`linha ${rowNumber}: ${err.message}`);
    }
  }

  return stats;
}

// ─── Aba Base (Aramida) → panel_consumptions ───────────────────────────────

// Acha o recebimento mais provável para (lote, NF, fornecedor=null).
// Como a aba Base não tem fornecedor explícito, casamos só por lote (e
// preferimos NF batendo quando informada). Em caso de empate, escolhe o
// recebimento com saldo livre maior (panel_receipts.received_m2 puro,
// porque saldo derivado mudaria durante o import).
async function lookupReceiptForBatch(externalBatch, invoiceNumber) {
  if (!externalBatch) return null;
  // 1) Tenta match exato (batch + invoice). Mais forte.
  if (invoiceNumber) {
    const r1 = await pool.query(
      `SELECT id, supplier FROM maestro.panel_receipts
        WHERE external_batch = $1 AND invoice_number = $2
        LIMIT 1`,
      [externalBatch, invoiceNumber],
    );
    if (r1.rows[0]) return r1.rows[0];
  }
  // 2) Match só por batch — pega o que tiver maior received_m2 (heurística).
  const r2 = await pool.query(
    `SELECT id, supplier FROM maestro.panel_receipts
      WHERE external_batch = $1
      ORDER BY received_m2 DESC, received_at DESC
      LIMIT 1`,
    [externalBatch],
  );
  return r2.rows[0] || null;
}

async function importBaseConsumptions(worksheet) {
  // Header pode ter duplicatas ("Camadas" aparece 2x). Pegamos índices fixos
  // baseado no layout descoberto durante a inspeção:
  //   A Data | B OS | C Veiculo | D Camadas | E NF1 | F Lote1 | G m²1
  //   H NF2 | I Lote2 | J m²2 | K (vazio) | L NF3 | M Lote3 | N m²3 | O m² Total
  const COL = { os: 2, nf: [5, 8, 12], lote: [6, 9, 13], m2: [7, 10, 14] };

  const stats = {
    read: 0,
    inserted: 0,
    skipped: 0,
    divergences: [],   // { row, os, batch, invoice, m2, reason }
    osesTouched: new Set(),
  };

  // Lista todas as OSs que aparecem na Base — soft-cancel histórico delas.
  const oses = new Set();
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const os = trimOrNull(worksheet.getRow(rowNumber).getCell(COL.os).value);
    if (os) oses.add(String(os));
  }
  if (oses.size > 0) {
    await pool.query(
      `UPDATE maestro.panel_consumptions
          SET cancelled_at = now()
        WHERE cancelled_at IS NULL
          AND cutting_record_id IS NULL
          AND order_number = ANY($1::text[])`,
      [[...oses]],
    );
  }

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    stats.read++;
    const os = trimOrNull(row.getCell(COL.os).value);
    if (!os) continue;
    const orderNumber = String(os);

    for (let i = 0; i < 3; i++) {
      const invoiceNumber = trimOrNull(row.getCell(COL.nf[i]).value);
      const externalBatch = trimOrNull(row.getCell(COL.lote[i]).value)?.toUpperCase();
      const m2 = parseM2Value(row.getCell(COL.m2[i]).value);
      if (!externalBatch || m2 === null || m2 <= 0) continue; // tupla vazia

      const receipt = await lookupReceiptForBatch(externalBatch, invoiceNumber);
      if (!receipt) {
        stats.divergences.push({
          row: rowNumber, os: orderNumber, batch: externalBatch,
          invoice: invoiceNumber || '', m2,
          reason: 'recebimento não encontrado para o lote',
        });
        continue;
      }

      try {
        await pool.query(
          `INSERT INTO maestro.panel_consumptions
             (panel_receipt_id, cutting_record_id, order_number, invoice_number,
              used_m2, supplier, external_batch)
           VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
          [receipt.id, orderNumber, invoiceNumber, m2, receipt.supplier, externalBatch],
        );
        stats.inserted++;
        stats.osesTouched.add(orderNumber);
      } catch (err) {
        stats.divergences.push({
          row: rowNumber, os: orderNumber, batch: externalBatch,
          invoice: invoiceNumber || '', m2,
          reason: `falha ao inserir: ${err.message}`,
        });
      }
    }
  }

  stats.skipped = stats.read - stats.osesTouched.size;
  return stats;
}

function writeDivergencesCsv(file, divergences) {
  if (divergences.length === 0) return null;
  const outPath = path.resolve(path.dirname(file), 'import-divergencias.csv');
  const header = 'linha;os;lote;nf;m2;motivo\n';
  const body = divergences
    .map(d => `${d.row};${d.os};${d.batch};${d.invoice};${String(d.m2).replace('.', ',')};${d.reason}`)
    .join('\n');
  fs.writeFileSync(outPath, header + body, 'utf8');
  return outPath;
}

async function main() {
  const file = process.argv[2] || DEFAULT_FILE;
  console.log(`📂 Lendo planilha: ${file}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  // 1) Notas Recebidas → panel_receipts
  const wsReceipts = wb.getWorksheet('Notas Recebidas');
  if (!wsReceipts) throw new Error('Aba "Notas Recebidas" não encontrada.');
  console.log(`\n=== Notas Recebidas (${wsReceipts.rowCount - 1} linhas) ===`);
  const receiptStats = await importPanelReceipts(wsReceipts);
  console.log(`   Lidas:        ${receiptStats.read}`);
  console.log(`   Inseridas:    ${receiptStats.inserted}`);
  console.log(`   Atualizadas:  ${receiptStats.updated}`);
  console.log(`   Ignoradas:    ${receiptStats.skipped}`);
  if (receiptStats.errors.length) {
    console.log(`\n⚠️ Avisos panel_receipts (${receiptStats.errors.length}):`);
    receiptStats.errors.slice(0, 20).forEach(e => console.log(`   - ${e}`));
    if (receiptStats.errors.length > 20) {
      console.log(`   ... e mais ${receiptStats.errors.length - 20}`);
    }
  }

  // 2) Base (Aramida) → panel_consumptions
  const wsBase = wb.getWorksheet('Base');
  let baseStats = null;
  if (wsBase) {
    console.log(`\n=== Base / Aramida (${wsBase.rowCount - 1} linhas) ===`);
    baseStats = await importBaseConsumptions(wsBase);
    console.log(`   Linhas lidas:           ${baseStats.read}`);
    console.log(`   Alocações inseridas:    ${baseStats.inserted}`);
    console.log(`   OSs com vínculo:        ${baseStats.osesTouched.size}`);
    console.log(`   Divergências:           ${baseStats.divergences.length}`);
  } else {
    console.log('\n⚠️ Aba "Base" não encontrada — pulando consumos Aramida.');
  }

  // 3) Tensylon (interno, sem painel externo) — apenas reportamos.
  const wsTensylon = wb.getWorksheet('Tensylon');
  if (wsTensylon) {
    console.log(`\n=== Tensylon (${wsTensylon.rowCount - 1} linhas) ===`);
    console.log('   Produção interna OPERA — não gera panel_consumptions. Skip.');
  }

  // 4) Relatório de divergências
  if (baseStats?.divergences?.length) {
    const csv = writeDivergencesCsv(file, baseStats.divergences);
    console.log(`\n📄 Relatório de divergências: ${csv}`);
  }

  console.log('\n💡 cutting_records (abas Base e Tensylon) NÃO foram inseridos — depende do backend');
  console.log('   da CarbonProduction. Os m² consumidos da Aramida já alimentam consumed_m2 dos');
  console.log('   recebimentos via panel_consumptions (com cutting_record_id NULL).');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Falha na importação:', err);
    process.exit(1);
  });
