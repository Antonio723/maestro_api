import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const { Pool } = pg;

// Tabela de geolocalização (por IP) de quem acessa o site. Idempotente.
const SQL = `
CREATE TABLE IF NOT EXISTS maestro.access_geo (
  id           BIGSERIAL PRIMARY KEY,
  ip           VARCHAR(60) NOT NULL,
  city         VARCHAR(120),
  region       VARCHAR(120),
  country      VARCHAR(120),
  country_code VARCHAR(4),
  lat          DOUBLE PRECISION,
  lon          DOUBLE PRECISION,
  isp          VARCHAR(200),
  user_email   VARCHAR(255),
  user_agent   TEXT,
  path         VARCHAR(300),
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_geo_created ON maestro.access_geo (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_geo_country ON maestro.access_geo (country);
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
    console.log('✅ Tabela maestro.access_geo criada/atualizada.');
  } catch (error) {
    console.error('❌ Erro na migração:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
