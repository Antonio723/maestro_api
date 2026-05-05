import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Validar variáveis de ambiente obrigatórias
const requiredEnvVars = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Variáveis de ambiente faltando:', missingVars.join(', '));
  console.error('💡 Certifique-se de criar o arquivo .env na pasta backend/');
  process.exit(1);
}

// Configuração do pool de conexões
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD),
  max: 20, // Número máximo de conexões no pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // Schema padrão + fuso de Brasília na sessão (afeta now(), exibição de
  // TIMESTAMPTZ e parse de strings sem fuso). TIMESTAMPTZ continua armazenado
  // em UTC internamente — a TZ só muda apresentação e cálculos relativos.
  options: '-c search_path=maestro,public -c timezone=America/Sao_Paulo'
});

// Teste de conexão
pool.on('connect', () => {
  console.log('✅ Conectado ao banco de dados PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ Erro inesperado no pool de conexões:', err);
  process.exit(-1);
});

// Função para executar queries
export const query = (text, params) => pool.query(text, params);

async function runCompatibilityQuery(sql, label) {
  try {
    await pool.query(sql);
  } catch (error) {
    if (error?.code === '42501') {
      console.warn(`⚠️ Sem permissão para ajuste automático: ${label}`);
      return;
    }

    throw error;
  }
}

async function ensureFileStorageTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.file_storage (
      id            uuid PRIMARY KEY,
      original_name text,
      stored_name   text,
      path          text,
      mime_type     text,
      size          bigint,
      created_at    timestamp DEFAULT now()
    )
  `, 'maestro.file_storage');
}

async function ensureCuttingPlanAttachmentTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.cutting_plan_attachment (
      id               serial PRIMARY KEY,
      cutting_plan_id  int  NOT NULL,
      file_id          uuid NOT NULL,
      type             text NOT NULL,
      created_at       timestamp DEFAULT now(),
      CONSTRAINT fk_cp   FOREIGN KEY (cutting_plan_id) REFERENCES maestro.cutting_plan(id) ON DELETE CASCADE,
      CONSTRAINT fk_file FOREIGN KEY (file_id)         REFERENCES maestro.file_storage(id) ON DELETE CASCADE,
      CONSTRAINT unique_attachment UNIQUE (cutting_plan_id, type)
    )
  `, 'maestro.cutting_plan_attachment');
}

async function ensureCuttingPlansTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.cutting_plan (
      id               SERIAL PRIMARY KEY,
      project_id       INTEGER NOT NULL REFERENCES maestro.project(id) ON DELETE CASCADE,
      plate_width      NUMERIC(8,3) NOT NULL DEFAULT 0,
      plate_height     NUMERIC(8,3) NOT NULL DEFAULT 0,
      linear_meters    JSONB NOT NULL DEFAULT '{}'::jsonb,
      square_meters    JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes            TEXT NOT NULL DEFAULT '',
      plate_consumption JSONB NOT NULL DEFAULT '{}'::jsonb,
      attachments      JSONB NOT NULL DEFAULT '[]'::jsonb,
      reviews          JSONB NOT NULL DEFAULT '{"cutting": false, "labeling": false, "ki_Layout": false, "nesting_report": false, "folder_template": false}'::jsonb,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, 'maestro.cutting_plan');
}

// Garante colunas esperadas para versões antigas do banco.
export async function ensureDatabaseCompatibility() {
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS menu_access JSONB NOT NULL DEFAULT '[]'::jsonb;
  `, 'maestro.users.menu_access');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  `, 'maestro.users.updated_at');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS api_token TEXT;
  `, 'maestro.users.api_token');

  // VARCHAR(255) é curta demais para tokens Jira longos (~200 chars) +
  // overhead da criptografia AES-GCM (~2× em hex). Converter para TEXT.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ALTER COLUMN api_token TYPE TEXT;
  `, 'maestro.users.api_token TYPE TEXT');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.project
    ADD COLUMN IF NOT EXISTS linear_meters JSONB NOT NULL DEFAULT '{"8C": "", "9C": "", "11C": ""}'::jsonb;
  `, 'maestro.project.linear_meters');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.project
    ADD COLUMN IF NOT EXISTS square_meters JSONB NOT NULL DEFAULT '{"8C": "", "9C": "", "11C": ""}'::jsonb;
  `, 'maestro.project.square_meters');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.project
    ADD COLUMN IF NOT EXISTS plate_consumption JSONB NOT NULL DEFAULT '{"8C": "", "9C": "", "11C": ""}'::jsonb;
  `, 'maestro.project.plate_consumption');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.project
    ADD COLUMN IF NOT EXISTS reviews JSONB NOT NULL DEFAULT '{"cutting": false, "labeling": false, "ki_Layout": false, "nesting_report": false, "folder_template": false}'::jsonb;
  `, 'maestro.project.reviews');

  await ensureFileStorageTable();
  await ensureCuttingPlansTable();
  await ensureCuttingPlanAttachmentTable();
  await ensureAuditTables();
}

async function ensureAuditTables() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.project_audit (
      id            SERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor_user_id INTEGER,
      actor_email   TEXT,
      action        TEXT NOT NULL,
      project_id    INTEGER NOT NULL,
      project_code  TEXT,
      "before"      JSONB,
      "after"       JSONB,
      metadata      JSONB,
      request_id    UUID,
      ip            TEXT
    )
  `, 'maestro.project_audit');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS project_audit_project_id_idx
      ON maestro.project_audit (project_id, created_at DESC)
  `, 'project_audit_project_id_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS project_audit_actor_idx
      ON maestro.project_audit (actor_user_id, created_at DESC)
  `, 'project_audit_actor_idx');

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.os_generation_audit (
      id                   SERIAL PRIMARY KEY,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor_user_id        INTEGER,
      actor_email          TEXT,
      request_id           UUID NOT NULL,
      total_requested      INTEGER NOT NULL DEFAULT 0,
      total_success        INTEGER NOT NULL DEFAULT 0,
      total_failed         INTEGER NOT NULL DEFAULT 0,
      total_field_warnings INTEGER NOT NULL DEFAULT 0,
      entries              JSONB NOT NULL DEFAULT '[]'::jsonb,
      ip                   TEXT,
      user_agent           TEXT
    )
  `, 'maestro.os_generation_audit');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_generation_audit_actor_idx
      ON maestro.os_generation_audit (actor_user_id, created_at DESC)
  `, 'os_generation_audit_actor_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_generation_audit_request_id_idx
      ON maestro.os_generation_audit (request_id)
  `, 'os_generation_audit_request_id_idx');
}

export default pool;
