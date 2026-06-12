// Relatório "Dashboard de Processos" gerado a partir do BANCO (Produção Unificada):
//   maestro.os_snapshot (espelho do card-pai AP) ⋈ maestro.producao_<material>.
// Reproduz as colunas do export do Carbon, exceto "PREVISÃO ENTREGA" (não existe
// em lugar nenhum). As colunas calculadas via changelog (DEV. CARBON/VIDRO,
// ENCAMINHAMENTO EXÉRCITO, DESMONTAGEM, AGUARDANDO VALIDAÇÕES) e OPCIONAIS ainda
// não têm fonte no banco — saem em branco. Ver "De-Para Dashboard de Processos".
import ExcelJS from 'exceljs';
import { query } from '../config/database.js';

// Status do material (Recebido/Pendente), validado contra o export do Carbon:
//   "Pendente" só quando existe um card ATIVO (não cancelado) que ainda NÃO chegou
//   — i.e., num status diferente de Recebido Carbon/Concluído/Atendido/Produzido.
//   Caso contrário "Recebido": sem card (material não faz parte da OS), todos os
//   cards cancelados, ou já recebido/concluído.
const STATUS_FINAL = "'Recebido Carbon','Concluído','Atendido','Produzido','Cancelado'";
function statusMaterialSql(tabela, alias) {
  return `COALESCE((
    SELECT CASE WHEN bool_or(status NOT IN (${STATUS_FINAL})) THEN 'Pendente' ELSE 'Recebido' END
      FROM maestro.${tabela} x WHERE x.numero_os = o.numero_os
  ), 'Recebido') AS ${alias}`;
}

// [cabeçalho exatamente como o export do Carbon | chave na linha do SELECT | tipo]
const COLUMNS = [
  ['OS', 'numero_os', 'text'],
  ['VEÍCULO', 'veiculo_compras', 'text'],
  ['COR', 'cor', 'text'],
  ['BLINDAGEM', 'blindagem', 'text'],
  ['Vidro', 'fabrica_vidro', 'text'],
  ['ETAPA', 'etapa', 'text'],             // híbrido: estágio do PB; fallback situação do AP
  ['ETAPA AP', 'etapa_ap', 'text'],       // situação do AP (apontamento) — coluna extra
  ['DEV. CARBON', null, 'text'],          // changelog — sem fonte no banco
  ['DEV.VIDRO', null, 'text'],            // changelog
  ['DATA OS', 'data_pedido', 'date'],
  ['RECEBIMENTO', 'data_recebimento', 'date'],
  ['ENCAMINHAMENTO EXÉRCITO', null, 'date'], // changelog
  ['LIBERAÇÃO EXÉRCITO', 'liberacao_exercito', 'date'],
  ['PRAZO CONTRATO', 'prazo_contrato', 'text'],
  ['DATA CONTRATO', 'data_contrato', 'date'],
  ['DESMONTAGEM', null, 'date'],          // changelog
  ['AGUARDANDO VALIDAÇÕES', null, 'date'],// changelog
  // (PREVISÃO ENTREGA removida — não existe no banco nem no modelo legado)
  ['PREVISÃO RECEB. VIDRO', 'prev_vidro', 'date'],
  ['PREVISÃO RECEB. AÇO', 'prev_aco', 'date'],
  ['PREVISÃO RECEB. OPACO', 'prev_manta', 'date'],
  ['PREVISÃO RECEB TENSYLON', 'prev_tensylon', 'date'],
  ['PREVISÃO RECEB SUP. VIDRO', 'prev_sup_vidro', 'date'],
  ['OBS', 'obs', 'text'],
  ['VIDRO', 'st_vidro', 'text'],
  ['AÇO', 'st_aco', 'text'],
  ['MANTA', 'st_manta', 'text'],
  ['TENSYLON', 'st_tensylon', 'text'],
  ['SUP. VIDRO', 'st_sup_vidro', 'text'],
  ['OPCIONAIS', null, 'text'],            // legado labelO — sem fonte no banco
  ['CHASSIS', 'chassi', 'text'],
  ['PARCEIRO', 'parceiro', 'text'],
];

const SQL = `
  SELECT
    o.numero_os, o.veiculo_compras, o.cor, o.blindagem,
    COALESCE(o.etapa_pb, upper(o.status)) AS etapa,
    upper(o.status) AS etapa_ap,
    o.data_pedido, o.data_recebimento, o.liberacao_exercito, o.prazo_contrato,
    o.data_contrato, o.prev_vidro, o.prev_aco, o.prev_manta, o.prev_tensylon,
    o.prev_sup_vidro, o.obs, o.chassi, o.parceiro,
    (SELECT fabrica FROM maestro.producao_vidro v
      WHERE v.numero_os = o.numero_os AND v.fabrica IS NOT NULL
      ORDER BY v.last_updated_at DESC LIMIT 1) AS fabrica_vidro,
    ${statusMaterialSql('producao_vidro', 'st_vidro')},
    ${statusMaterialSql('producao_aco', 'st_aco')},
    ${statusMaterialSql('producao_manta', 'st_manta')},
    ${statusMaterialSql('producao_tensylon', 'st_tensylon')},
    ${statusMaterialSql('producao_sup_vidro', 'st_sup_vidro')}
  FROM maestro.os_snapshot o
  ORDER BY NULLIF(regexp_replace(o.numero_os, '[^0-9]', '', 'g'), '')::bigint NULLS LAST, o.numero_os
`;

export const getDashboardProcessos = async (req, res) => {
  try {
    const { rows } = await query(SQL);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data');
    ws.addRow(COLUMNS.map((c) => c[0]));
    ws.getRow(1).font = { bold: true };

    for (const r of rows) {
      ws.addRow(COLUMNS.map(([, key, type]) => {
        if (!key) return null;
        const v = r[key];
        if (v == null) return null;
        if (type === 'date') {
          const d = v instanceof Date ? v : new Date(v);
          return Number.isNaN(d.getTime()) ? null : d;
        }
        return v;
      }));
    }

    ws.columns.forEach((col) => { col.width = 18; });
    ws.eachRow((row, i) => {
      if (i === 1) return;
      row.eachCell((cell) => { if (cell.value instanceof Date) cell.numFmt = 'dd/mm/yyyy'; });
    });

    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="dashboard-processos-${ts}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('❌ Erro ao gerar Dashboard de Processos:', error.message);
    res.status(500).json({ success: false, message: 'Erro ao gerar o relatório Dashboard de Processos.' });
  }
};
