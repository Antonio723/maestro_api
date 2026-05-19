require("dotenv").config();

const { scheduleMaterialJob, readOptionOrString, readDate } = require("./jiraSyncHelper.cjs");

// Custom fields específicos do board FÁBRICA VIDRO (projeto VIDRO).
// Os campos comuns (status, situação, marca, modelo, OS/PD, etc.) já são
// solicitados pelo helper — aqui só os exclusivos da filha.
const EXTRA_FIELDS = [
  "customfield_10035", // DT. RECEBIMENTO
  "customfield_10100", // FÁBRICA DE VIDRO (= "tipo vidro": GRAFFENO, etc.)
  "customfield_10101", // Nº da Nota Fiscal
  "customfield_10154", // Origem
  "customfield_11067", // BLINDAGEM
  "customfield_11743", // Motivo RNC
  "customfield_11764", // Liberado para produção (DATE)
  "customfield_11765", // Desenvolvimento (DATE)
  "customfield_11766", // Em Produção (DATE)
  "customfield_11767", // Produzido (DATE)
  "customfield_11769", // Recebido Carbon (DATE)
  "customfield_11843", // Data NF
];

// Pega cards em qualquer status do board VIDRO. O cron grava todos e mantém
// o último status (decisão do PCP em vez de filtrar por "abertos").
const JQL = `project = VIDRO`;

scheduleMaterialJob({
  jobName: "sync_vidro",
  cronExpr: "*/5 * * * *",
  syncConfig: {
    material: "VIDRO",
    jql: JQL,
    extraFields: EXTRA_FIELDS,
    childTable: "producao_vidro",
    childColumns: [
      "nf",
      "tipo_vidro",
      "dt_recebimento",
      "blindagem",
      "origem",
      "motivo_rnc",
      "liberado_producao_at",
      "desenvolvimento_at",
      "em_producao_at",
      "produzido_at",
      "recebido_carbon_at",
      "data_nf",
    ],
    mapChild(issue) {
      const f = issue.fields || {};
      const nfRaw = f.customfield_10101;
      const nf = nfRaw == null ? null : String(nfRaw).replace(/\.0$/, "");
      return {
        nf,
        tipo_vidro:           readOptionOrString(f.customfield_10100) || null,
        dt_recebimento:       readDate(f.customfield_10035),
        blindagem:            readOptionOrString(f.customfield_11067) || null,
        origem:               readOptionOrString(f.customfield_10154) || null,
        motivo_rnc:           readOptionOrString(f.customfield_11743) || null,
        liberado_producao_at: readDate(f.customfield_11764),
        desenvolvimento_at:   readDate(f.customfield_11765),
        em_producao_at:       readDate(f.customfield_11766),
        produzido_at:         readDate(f.customfield_11767),
        recebido_carbon_at:   readDate(f.customfield_11769),
        data_nf:              readDate(f.customfield_11843),
      };
    },
  },
});
