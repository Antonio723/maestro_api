import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

const { Pool } = pg;

// Produção Unificada de Materiais:
//   - os_snapshot: tabela-mãe (1 linha por OS), espelho do card-pai
//     Apontamento Produção (AP) — veículo + etapa + previsões por material.
//     (O PB só é aberto quando a produção é autorizada; o pai de tudo é o AP.)
//   - producao_<material>: 1 tabela por fábrica (VIDRO/AÇO/MANTA/TENSYLON/SUP.VIDRO),
//     ligada à mãe por numero_os (join solto, SEM FK rígida — os crons são
//     independentes e podem gravar fora de ordem).
const MATERIALS = ['vidro', 'aco', 'manta', 'tensylon', 'sup_vidro'];

const OS_SNAPSHOT = `
CREATE TABLE IF NOT EXISTS maestro.os_snapshot (
  numero_os       VARCHAR(40) PRIMARY KEY,
  ap_key          VARCHAR(40),
  veiculo         TEXT,
  marca           TEXT,
  modelo          TEXT,
  ano             VARCHAR(20),
  etapa           VARCHAR(120),
  etapa_pb        VARCHAR(120),
  status          VARCHAR(80),
  prev_vidro      DATE,
  prev_aco        DATE,
  prev_manta      DATE,
  prev_tensylon   DATE,
  prev_sup_vidro  DATE,
  veiculo_compras    TEXT,
  cor                TEXT,
  blindagem          TEXT,
  chassi             VARCHAR(40),
  parceiro           TEXT,
  data_pedido        DATE,
  data_recebimento   DATE,
  data_contrato      DATE,
  prazo_contrato     VARCHAR(20),
  liberacao_exercito DATE,
  obs                TEXT,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

function materialTable(m) {
  return `
CREATE TABLE IF NOT EXISTS maestro.producao_${m} (
  id              BIGSERIAL PRIMARY KEY,
  numero_os       VARCHAR(40),
  jira_key        VARCHAR(40) UNIQUE NOT NULL,
  situacao        VARCHAR(120),
  status          VARCHAR(80),
  pedido_carbon   TEXT,
  previsao        DATE,
  campos          JSONB,
  produced_at     TIMESTAMPTZ,
  fabrica         TEXT,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_producao_${m}_os ON maestro.producao_${m} (numero_os);
`;
}

async function run() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: '-c search_path=maestro,public',
  });
  try {
    console.log('🔄 Conectando ao banco de dados...');
    await pool.query(OS_SNAPSHOT);
    console.log('✅ maestro.os_snapshot');
    for (const m of MATERIALS) {
      await pool.query(materialTable(m));
      console.log(`✅ maestro.producao_${m}`);
    }
    const check = await pool.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'maestro'
         AND table_name IN ('os_snapshot', ${MATERIALS.map((m) => `'producao_${m}'`).join(', ')})
       ORDER BY table_name
    `);
    console.log('📋 Tabelas:', check.rows.map((r) => r.table_name).join(', '));
  } catch (error) {
    console.error('❌ Erro na migração:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
