import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const { Pool } = pg;

// Migração do controle de ENFESTO do Tensylon.
// Módulo próprio (o fluxo difere da aramida: sem placas/camadas/plástico).
// Tabela mãe em public, junto da aramida; lotes de material em tabela filha
// (1 enfesto -> N lotes). material_variant_id referencia maestro.material_variants.
const SQL = `
CREATE TABLE IF NOT EXISTS public.tensylon_enfesto (
  id                     serial PRIMARY KEY,
  enfesto_date           date NOT NULL,
  order_number           text,
  jira_key               text,
  material_variant_id    integer REFERENCES maestro.material_variants(id),
  material_variant_nome  text,
  fornecedor             text,
  comprimento            numeric(12,2) NOT NULL,
  lote_impresso          text,
  creation_date          timestamptz NOT NULL DEFAULT now(),
  change_date            timestamptz NOT NULL DEFAULT now()
);

-- Idempotente para tabelas já criadas antes desta coluna.
ALTER TABLE public.tensylon_enfesto ADD COLUMN IF NOT EXISTS fornecedor text;

CREATE TABLE IF NOT EXISTS public.tensylon_enfesto_lote (
  id          serial PRIMARY KEY,
  enfesto_id  integer NOT NULL REFERENCES public.tensylon_enfesto(id) ON DELETE CASCADE,
  lote        text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tensylon_enfesto_lote_enfesto_id
  ON public.tensylon_enfesto_lote (enfesto_id);

CREATE INDEX IF NOT EXISTS idx_tensylon_enfesto_date
  ON public.tensylon_enfesto (enfesto_date);
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
    console.log('✅ Tabelas tensylon_enfesto e tensylon_enfesto_lote criadas/atualizadas.');

    const check = await pool.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('tensylon_enfesto', 'tensylon_enfesto_lote')
       ORDER BY table_name
    `);
    console.log('📋 Tabelas encontradas:', check.rows.map((r) => r.table_name).join(', '));
  } catch (error) {
    console.error('❌ Erro na migração:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
