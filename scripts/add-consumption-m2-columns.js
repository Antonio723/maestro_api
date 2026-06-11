import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const { Pool } = pg;

// Persiste a metragem quadrada (com desperdício embutido) por consumo, e o
// desperdício em mm aplicado no saldo da placa. Antes só `used_metrage` (mm)
// era gravado e o m² era recalculado nos relatórios.
//   - square_meters: (used_metrage + waste_metrage)/1000 * largura
//   - waste_metrage: mm de desperdício baixado do saldo (necessário p/ estornar
//     corretamente o saldo da placa na edição/exclusão do apontamento).
// Idempotente; sem backfill (só vale para apontamentos novos/editados).
const SQL = `
ALTER TABLE public.plate_consumptions
  ADD COLUMN IF NOT EXISTS square_meters numeric,
  ADD COLUMN IF NOT EXISTS waste_metrage numeric NOT NULL DEFAULT 0;
`;

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
    await pool.query(SQL);
    console.log('✅ Colunas square_meters e waste_metrage garantidas em plate_consumptions.');

    const check = await pool.query(`
      SELECT column_name, data_type, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'plate_consumptions'
         AND column_name IN ('square_meters', 'waste_metrage')
       ORDER BY column_name
    `);
    console.log('📋 Colunas:', check.rows.map((r) => r.column_name).join(', '));
  } catch (error) {
    console.error('❌ Erro na migração:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
