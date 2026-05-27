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
    // 42P07 = duplicate_table/index/constraint — objeto já existe, ok ignorar em migrations
    if (error?.code === '42P07') {
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

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.project
    ADD COLUMN IF NOT EXISTS product_alert TEXT NOT NULL DEFAULT '';
  `, 'maestro.project.product_alert');

  await ensureFileStorageTable();
  await ensureCuttingPlansTable();
  await ensureCuttingPlanAttachmentTable();
  await ensureAuditTables();
  await ensureQualityCertificatesTable();
  await ensureJiraCardsProducedAt();
  await ensurePlateSupplierTable();
  await ensurePlateSizeTable();
  await ensureFabricSupplierTable();
  await ensureOsPlanningTable();
  await ensureOsPrintAuditTable();
  await ensureProductionPackTable();
  await ensureOsPlanningPackId();
  await ensureCronRunsTable();
  await ensureCronJobsTables();
  await ensureUserSecurityColumns();
  await ensureCargosTable();
  await ensureUserProfileColumns();
  await ensureRbacTables();
  await ensureOsGeneratedMeasureTable();
  await ensureMaterialsTable();
  await ensureMaterialMeasureTypesTable();
  await ensureProductionConfigTable();
  await ensureAppPreferencesTable();
  await ensureConformityCertificatesTable();
  await ensureRastreabilidadesTable();
}

// Preferências globais da aplicação (flags de comportamento de páginas).
// Diferente de production_config (constantes de TR/IIS): aqui ficam toggles
// que admins ligam/desligam para alterar o comportamento de telas.
async function ensureAppPreferencesTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.app_preferences (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      description TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, 'maestro.app_preferences');

  await runCompatibilityQuery(`
    INSERT INTO maestro.app_preferences (key, value, description) VALUES
      ('corte_romaneio_opera_enabled', '0', 'Permite gerar romaneio para registros de corte cujo único fornecedor é OPERA (0 = desabilitado, 1 = habilitado)')
    ON CONFLICT (key) DO NOTHING
  `, 'app_preferences seed');
}

// Catálogo de materiais (entidade referenciada por conformity_certificates).
// tipo segue a lista padrão da operação (VIDRO, AÇO, MANTA, TENSYLON, SUP.VIDRO).
async function ensureMaterialsTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.materials (
      id          SERIAL PRIMARY KEY,
      nome        TEXT NOT NULL UNIQUE,
      tipo        TEXT,
      ativo       BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ
    )
  `, 'maestro.materials');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.materials
    ADD COLUMN IF NOT EXISTS tipo TEXT
  `, 'maestro.materials.tipo');

  // Limpeza: espessura e descricao foram realocadas para conformity_certificates.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.materials
    DROP CONSTRAINT IF EXISTS materials_espessura_requires_aco
  `, 'drop materials_espessura_requires_aco');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.materials
    DROP COLUMN IF EXISTS espessura_mm
  `, 'drop maestro.materials.espessura_mm');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.materials
    DROP COLUMN IF EXISTS descricao
  `, 'drop maestro.materials.descricao');
}

// Configuração global da produção — valores fixos usados na composição dos
// códigos de Rastreabilidade e IIS (TR, tipo de embalagem, país, CEP).
// Key/value para permitir alteração via UI sem migração de schema.
async function ensureMaterialMeasureTypesTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.material_measure_types (
      id          SERIAL PRIMARY KEY,
      nome        TEXT NOT NULL UNIQUE,
      unidade     TEXT,
      ativo       BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ
    )
  `, 'maestro.material_measure_types');

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.material_measure_type_map (
      material_id     INTEGER NOT NULL REFERENCES maestro.materials(id) ON DELETE CASCADE,
      measure_type_id INTEGER NOT NULL REFERENCES maestro.material_measure_types(id) ON DELETE CASCADE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (material_id, measure_type_id)
    )
  `, 'maestro.material_measure_type_map');

  await runCompatibilityQuery(`
    INSERT INTO maestro.material_measure_types (nome, unidade) VALUES
      ('Espessura', 'mm'),
      ('Camadas', NULL)
    ON CONFLICT (nome) DO NOTHING
  `, 'material_measure_types seed');
}

async function ensureProductionConfigTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.production_config (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      description TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, 'maestro.production_config');

  // Seed inicial — só insere se a chave não existir.
  await runCompatibilityQuery(`
    INSERT INTO maestro.production_config (key, value, description) VALUES
      ('tr_numero',          '0430',  'Número do TR (4 dígitos) usado em Rastreabilidade e IIS'),
      ('iis_tipo_embalagem', '6',     'Tipo de embalagem do IIS (1 dígito)'),
      ('iis_pais',           '789',   'Código do país no IIS (3 dígitos)'),
      ('iis_cep',            '06460', 'CEP no IIS (5 dígitos)')
    ON CONFLICT (key) DO NOTHING
  `, 'production_config seed');
}

// Certificado de Conformidade RETEX — emitido para o produto, vincula
// material e quantidade de camadas. Referenciado pelas rastreabilidades.
async function ensureConformityCertificatesTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.conformity_certificates (
      id                 SERIAL PRIMARY KEY,
      numero             TEXT NOT NULL UNIQUE,
      nome_comercial     TEXT NOT NULL,
      material_id        INTEGER NOT NULL REFERENCES maestro.materials(id),
      quantidade_camadas INTEGER CHECK (quantidade_camadas > 0),
      espessura_mm       NUMERIC(8,3),
      medidas            JSONB NOT NULL DEFAULT '{}'::jsonb,
      descricao          TEXT,
      ativo              BOOLEAN NOT NULL DEFAULT true,
      created_by         INTEGER REFERENCES maestro.users(id),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ
    )
  `, 'maestro.conformity_certificates');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.conformity_certificates
    ADD COLUMN IF NOT EXISTS espessura_mm NUMERIC(8,3)
  `, 'maestro.conformity_certificates.espessura_mm');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.conformity_certificates
    ADD COLUMN IF NOT EXISTS medidas JSONB NOT NULL DEFAULT '{}'::jsonb
  `, 'maestro.conformity_certificates.medidas');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.conformity_certificates
    ALTER COLUMN quantidade_camadas DROP NOT NULL
  `, 'maestro.conformity_certificates.quantidade_camadas nullable');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.conformity_certificates
    ADD COLUMN IF NOT EXISTS descricao TEXT
  `, 'maestro.conformity_certificates.descricao');

  // Vínculo com fornecedor de placa — chave usada pelo auto-fill do Cert. de
  // Qualidade junto com quantidade_camadas para escolher o cert. aplicável.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.conformity_certificates
    ADD COLUMN IF NOT EXISTS plate_supplier_id INTEGER REFERENCES maestro.plate_supplier(id)
  `, 'maestro.conformity_certificates.plate_supplier_id');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS conformity_certificates_material_idx
      ON maestro.conformity_certificates (material_id)
  `, 'conformity_certificates_material_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS conformity_certificates_lookup_idx
      ON maestro.conformity_certificates (plate_supplier_id, quantidade_camadas)
  `, 'conformity_certificates_lookup_idx');
}

// Rastreabilidade + IIS na mesma linha (1:1, IIS é totalmente derivado).
// codigo_rastreabilidade (13 dig) e codigo_iis (24 dig) são GENERATED.
// Os campos iis_* guardam snapshot dos fixos no momento da emissão para
// que mudanças futuras na production_config não afetem registros antigos.
async function ensureRastreabilidadesTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.rastreabilidades (
      id                     SERIAL PRIMARY KEY,
      certificate_id         INTEGER NOT NULL REFERENCES maestro.conformity_certificates(id),
      tipo_material          CHAR(1) NOT NULL CHECK (tipo_material IN ('M','V')),
      tr                     VARCHAR(4) NOT NULL CHECK (tr ~ '^[0-9]{4}$'),
      mes                    VARCHAR(2) NOT NULL CHECK (mes ~ '^(0[1-9]|1[0-2])$'),
      ano                    VARCHAR(2) NOT NULL CHECK (ano ~ '^[0-9]{2}$'),
      sequencial             VARCHAR(6) NOT NULL CHECK (sequencial ~ '^[0-9]{6}$'),
      iis_tipo_embalagem     VARCHAR(1) NOT NULL CHECK (iis_tipo_embalagem ~ '^[0-9]$'),
      iis_pais               VARCHAR(3) NOT NULL CHECK (iis_pais ~ '^[0-9]{3}$'),
      iis_cep                VARCHAR(5) NOT NULL CHECK (iis_cep ~ '^[0-9]{5}$'),
      iis_dv                 VARCHAR(1) NOT NULL CHECK (iis_dv ~ '^[0-9]$'),
      codigo_rastreabilidade VARCHAR(13) GENERATED ALWAYS AS
        (tipo_material || tr || mes || ano || sequencial) STORED,
      codigo_iis             VARCHAR(24) GENERATED ALWAYS AS
        (iis_tipo_embalagem || iis_pais || tr || iis_cep || mes || ano || sequencial || iis_dv) STORED,
      created_by             INTEGER REFERENCES maestro.users(id),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ,
      CONSTRAINT rastreabilidades_unique UNIQUE (tipo_material, tr, mes, ano, sequencial)
    )
  `, 'maestro.rastreabilidades');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS rastreabilidades_cert_idx
      ON maestro.rastreabilidades (certificate_id)
  `, 'rastreabilidades_cert_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS rastreabilidades_codigo_idx
      ON maestro.rastreabilidades (codigo_rastreabilidade)
  `, 'rastreabilidades_codigo_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS rastreabilidades_iis_codigo_idx
      ON maestro.rastreabilidades (codigo_iis)
  `, 'rastreabilidades_iis_codigo_idx');
}

// Cargos (funções) catalogados — referenciados por users.cargo_id.
// CRUD restrito a usuários com permissão "users:manage" / master.
async function ensureCargosTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.cargos (
      id         SERIAL PRIMARY KEY,
      nome       VARCHAR(120) NOT NULL UNIQUE,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `, 'maestro.cargos');
}

// Identidade + cargo + expiração do token Jira no perfil do usuário.
async function ensureUserProfileColumns() {
  // username: login passa a ser por username em vez de email.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS username VARCHAR(60);
  `, 'maestro.users.username');

  // Backfill: usuários sem username herdam o prefixo do e-mail.
  // Em caso de colisão entre prefixos iguais, anexa o id para garantir unicidade.
  await runCompatibilityQuery(`
    WITH backfill AS (
      SELECT id,
        CASE
          WHEN ROW_NUMBER() OVER (
            PARTITION BY lower(split_part(email, '@', 1))
            ORDER BY id
          ) = 1
            THEN lower(split_part(email, '@', 1))
          ELSE lower(split_part(email, '@', 1)) || '_' || id::text
        END AS new_username
      FROM maestro.users
      WHERE username IS NULL
    )
    UPDATE maestro.users u
    SET username = b.new_username
    FROM backfill b
    WHERE u.id = b.id;
  `, 'maestro.users.username backfill');

  await runCompatibilityQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
      ON maestro.users (lower(username));
  `, 'users_username_unique');

  // Cargo referencia o catálogo. ON DELETE SET NULL para não impedir
  // remoção de cargo que ainda esteja atribuído.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS cargo_id INTEGER REFERENCES maestro.cargos(id) ON DELETE SET NULL;
  `, 'maestro.users.cargo_id');

  // Expiração do token Jira informada manualmente pelo usuário ao salvar
  // o token. Usado para banner "vence em N dias" / "vencido" no /auth/me.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS jira_token_expires_at DATE;
  `, 'maestro.users.jira_token_expires_at');
}

// Registra em qual medida (dimensão da chapa) + material a OS de cada card
// foi gerada. Uma linha por (jira_key, dimension) — o card acumula as
// medidas em que já foi gerado. Consumido pela tela "Liberado Engenharia".
async function ensureOsGeneratedMeasureTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.os_generated_measure (
      id           SERIAL PRIMARY KEY,
      jira_key     TEXT NOT NULL,
      os_number    TEXT,
      project      TEXT,
      material     TEXT,
      dimension    TEXT NOT NULL,
      generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT os_generated_measure_unique UNIQUE (jira_key, dimension)
    )
  `, 'maestro.os_generated_measure');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_generated_measure_jira_idx
      ON maestro.os_generated_measure (jira_key)
  `, 'os_generated_measure_jira_idx');
}

async function ensureCronJobsTables() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.cron_jobs (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_by  INTEGER REFERENCES maestro.users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ
    )
  `, 'maestro.cron_jobs');

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.cron_job_versions (
      id                  BIGSERIAL PRIMARY KEY,
      job_id              INTEGER NOT NULL REFERENCES maestro.cron_jobs(id) ON DELETE CASCADE,
      version_number      NUMERIC(6,2) NOT NULL,
      status              TEXT NOT NULL CHECK (status IN ('DVP','SAT','REL','OPE')),
      cron_expression     TEXT NOT NULL,
      code                TEXT NOT NULL,
      notes               TEXT,
      created_by          INTEGER REFERENCES maestro.users(id),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      status_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      status_changed_by   INTEGER REFERENCES maestro.users(id),
      CONSTRAINT cron_job_versions_job_ver_unique UNIQUE (job_id, version_number)
    )
  `, 'maestro.cron_job_versions');

  // Apenas uma versão por job pode estar em OPE (a que será agendada).
  await runCompatibilityQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS cron_job_versions_ope_unique
      ON maestro.cron_job_versions (job_id) WHERE status = 'OPE'
  `, 'cron_job_versions_ope_unique');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS cron_job_versions_job_idx
      ON maestro.cron_job_versions (job_id, version_number DESC)
  `, 'cron_job_versions_job_idx');
}

async function ensureCronRunsTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.cron_runs (
      id                 BIGSERIAL PRIMARY KEY,
      job_name           TEXT NOT NULL,
      started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at        TIMESTAMPTZ,
      status             TEXT NOT NULL CHECK (status IN ('running','success','error','skipped')),
      records_processed  INTEGER,
      error_message      TEXT,
      details            JSONB
    )
  `, 'maestro.cron_runs');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS cron_runs_job_started_idx
      ON maestro.cron_runs (job_name, started_at DESC)
  `, 'cron_runs_job_started_idx');
}

async function ensureJiraCardsProducedAt() {
  // Marco temporal da primeira transição p/ "Produzido" — alimentado pelo cron
  // de sync. Permite janela de visibilidade pós-entrega na tela do PCP.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.jira_cards
    ADD COLUMN IF NOT EXISTS produced_at TIMESTAMPTZ;
  `, 'maestro.jira_cards.produced_at');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS jira_cards_produced_at_idx
      ON maestro.jira_cards (produced_at)
  `, 'jira_cards_produced_at_idx');

  // Fábrica de Manta (customfield_11329 no Jira) — dropdown que indica em qual
  // unidade fabril a OS é produzida (ex.: COMTEC, MATRIZ).
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.jira_cards
    ADD COLUMN IF NOT EXISTS fabrica_manta TEXT;
  `, 'maestro.jira_cards.fabrica_manta');
}

async function ensurePlateSupplierTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.plate_supplier (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ
    )
  `, 'maestro.plate_supplier');
}

async function ensureFabricSupplierTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.fabric_supplier (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ
    )
  `, 'maestro.fabric_supplier');
}

async function ensurePlateSizeTable() {
  // plate_size pertence a um fornecedor (1:N). UNIQUE inclui supplier_id
  // porque dois fornecedores podem ter o mesmo tamanho geométrico.
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.plate_size (
      id          SERIAL PRIMARY KEY,
      supplier_id INTEGER REFERENCES maestro.plate_supplier(id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      width       NUMERIC(8,3) NOT NULL,
      height      NUMERIC(8,3) NOT NULL,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ,
      CONSTRAINT plate_size_supplier_dim_unique UNIQUE (supplier_id, width, height)
    )
  `, 'maestro.plate_size');

  // Migration p/ DBs criados antes da junção: adiciona supplier_id e troca o UNIQUE.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.plate_size
    ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES maestro.plate_supplier(id) ON DELETE CASCADE;
  `, 'maestro.plate_size.supplier_id');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.plate_size
    DROP CONSTRAINT IF EXISTS plate_size_dim_unique;
  `, 'drop plate_size_dim_unique');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.plate_size
    ADD CONSTRAINT plate_size_supplier_dim_unique UNIQUE (supplier_id, width, height);
  `, 'add plate_size_supplier_dim_unique');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS plate_size_supplier_idx
      ON maestro.plate_size (supplier_id)
  `, 'plate_size_supplier_idx');
}

async function ensureOsPlanningTable() {
  // Vínculo lógico (sem FK) com jira_cards.key — o cron faz UPSERT em jira_cards
  // e podemos ter os_planning manuais antes do card existir (Fase 3).
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.os_planning (
      id                            SERIAL PRIMARY KEY,
      os_numero                     TEXT UNIQUE,
      card_key                      TEXT UNIQUE,
      veiculo                       TEXT,
      plate_supplier_id             INTEGER REFERENCES maestro.plate_supplier(id),
      plate_size_id                 INTEGER REFERENCES maestro.plate_size(id),
      material_assigned_at          TIMESTAMPTZ,
      material_assigned_by_user_id  INTEGER REFERENCES maestro.users(id),
      production_seq                INTEGER,
      first_printed_at              TIMESTAMPTZ,
      first_printed_by_user_id      INTEGER REFERENCES maestro.users(id),
      last_printed_at               TIMESTAMPTZ,
      last_printed_by_user_id       INTEGER REFERENCES maestro.users(id),
      print_count                   INTEGER NOT NULL DEFAULT 0,
      created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                    TIMESTAMPTZ
    )
  `, 'maestro.os_planning');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_planning_card_key_idx
      ON maestro.os_planning (card_key)
  `, 'os_planning_card_key_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_planning_supplier_idx
      ON maestro.os_planning (plate_supplier_id)
  `, 'os_planning_supplier_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_planning_size_idx
      ON maestro.os_planning (plate_size_id)
  `, 'os_planning_size_idx');
}

async function ensureOsPrintAuditTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.os_print_audit (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor_user_id   INTEGER,
      actor_email     TEXT,
      request_id      UUID NOT NULL,
      card_keys       JSONB NOT NULL DEFAULT '[]'::jsonb,
      total           INTEGER NOT NULL DEFAULT 0,
      success         INTEGER NOT NULL DEFAULT 0,
      failed          INTEGER NOT NULL DEFAULT 0,
      entries         JSONB NOT NULL DEFAULT '[]'::jsonb,
      ip              TEXT,
      user_agent      TEXT
    )
  `, 'maestro.os_print_audit');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_print_audit_actor_idx
      ON maestro.os_print_audit (actor_user_id, created_at DESC)
  `, 'os_print_audit_actor_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_print_audit_request_id_idx
      ON maestro.os_print_audit (request_id)
  `, 'os_print_audit_request_id_idx');
}

async function ensureUserSecurityColumns() {
  // is_master: bypass RBAC para bootstrap e troubleshooting (§3 da spec)
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS is_master BOOLEAN NOT NULL DEFAULT false;
  `, 'maestro.users.is_master');

  // Timeout de sessão configurável por usuário (§14.1)
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS idle_timeout_enabled BOOLEAN NOT NULL DEFAULT true;
  `, 'maestro.users.idle_timeout_enabled');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS idle_timeout_minutes SMALLINT NOT NULL DEFAULT 30;
  `, 'maestro.users.idle_timeout_minutes');

  // Lockout temporário após N tentativas de login (§14.2)
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
  `, 'maestro.users.locked_until');

  // Força troca de senha no próximo login (§14.3)
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
  `, 'maestro.users.must_change_password');

  // Step-up re-auth token hash + expiração (§14.4)
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS step_up_token_hash TEXT;
  `, 'maestro.users.step_up_token_hash');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS step_up_expires TIMESTAMP;
  `, 'maestro.users.step_up_expires');

  // Soft delete: preserva integridade de audit FKs (§14.7)
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
  `, 'maestro.users.deleted_at');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES maestro.users(id);
  `, 'maestro.users.deleted_by');

  // Última atividade para badge de "ativo/inativo" no painel admin (§15.12)
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.users
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
  `, 'maestro.users.last_login_at');
}

async function ensureRbacTables() {
  // Roles — agrupamento nomeado de permissões
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.roles (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(60) NOT NULL UNIQUE,
      description TEXT,
      is_system   BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMP NOT NULL DEFAULT now(),
      updated_at  TIMESTAMP NOT NULL DEFAULT now()
    )
  `, 'maestro.roles');

  // Permissions — par imutável (resource, action)
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.permissions (
      id          SERIAL PRIMARY KEY,
      resource    VARCHAR(60) NOT NULL,
      action      VARCHAR(30) NOT NULL,
      description TEXT,
      created_at  TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE (resource, action)
    )
  `, 'maestro.permissions');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS idx_permissions_resource
      ON maestro.permissions (resource)
  `, 'idx_permissions_resource');

  // N:N Role × Permission
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.role_permissions (
      role_id       INT NOT NULL REFERENCES maestro.roles(id)       ON DELETE CASCADE,
      permission_id INT NOT NULL REFERENCES maestro.permissions(id) ON DELETE CASCADE,
      created_at    TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (role_id, permission_id)
    )
  `, 'maestro.role_permissions');

  // N:N User × Role (com expiração opcional — §15.4)
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.user_roles (
      user_id    INT NOT NULL REFERENCES maestro.users(id) ON DELETE CASCADE,
      role_id    INT NOT NULL REFERENCES maestro.roles(id) ON DELETE CASCADE,
      granted_by INT REFERENCES maestro.users(id),
      expires_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role_id)
    )
  `, 'maestro.user_roles');

  // Auditoria de decisões e mudanças de acesso
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.access_audit (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INT REFERENCES maestro.users(id),
      user_email     VARCHAR(255),
      event_type     VARCHAR(40) NOT NULL,
      resource       VARCHAR(60),
      action         VARCHAR(30),
      target_user_id INT REFERENCES maestro.users(id),
      details        JSONB,
      ip             VARCHAR(60),
      user_agent     TEXT,
      created_at     TIMESTAMP NOT NULL DEFAULT now()
    )
  `, 'maestro.access_audit');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS idx_access_audit_user
      ON maestro.access_audit (user_id)
  `, 'idx_access_audit_user');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS idx_access_audit_event
      ON maestro.access_audit (event_type)
  `, 'idx_access_audit_event');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS idx_access_audit_created
      ON maestro.access_audit (created_at DESC)
  `, 'idx_access_audit_created');

  // Overrides por usuário — deny/grant pontuais sem criar role nova (§14.6)
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.user_permission_overrides (
      id            SERIAL PRIMARY KEY,
      user_id       INT NOT NULL REFERENCES maestro.users(id)       ON DELETE CASCADE,
      permission_id INT NOT NULL REFERENCES maestro.permissions(id) ON DELETE CASCADE,
      effect        VARCHAR(10) NOT NULL CHECK (effect IN ('grant', 'deny')),
      reason        TEXT,
      granted_by    INT REFERENCES maestro.users(id),
      expires_at    TIMESTAMP,
      created_at    TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE (user_id, permission_id)
    )
  `, 'maestro.user_permission_overrides');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS idx_upo_user
      ON maestro.user_permission_overrides (user_id)
  `, 'idx_upo_user');
}

async function ensureProductionPackTable() {
  // Bloco de produção (visualização tipo "Excel colorido"). OSs são alocadas
  // a um pack via os_planning.pack_id. Pack agrupa OSs sem restringir tipo de
  // placa — pode misturar fornecedor/tamanho.
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.production_pack (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      color             TEXT NOT NULL DEFAULT '#3b82f6',
      seq               INTEGER NOT NULL DEFAULT 0,
      target_date       DATE,
      notes             TEXT,
      created_by_user_id INTEGER REFERENCES maestro.users(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ
    )
  `, 'maestro.production_pack');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS production_pack_seq_idx
      ON maestro.production_pack (seq)
  `, 'production_pack_seq_idx');
}

async function ensureOsPlanningPackId() {
  // Vínculo opcional: OSs podem estar em um pack ou ficar na fila "sem pack".
  // ON DELETE SET NULL — apagar pack devolve OSs para a fila.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.os_planning
    ADD COLUMN IF NOT EXISTS pack_id INTEGER REFERENCES maestro.production_pack(id) ON DELETE SET NULL;
  `, 'maestro.os_planning.pack_id');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS os_planning_pack_id_idx
      ON maestro.os_planning (pack_id)
  `, 'os_planning_pack_id_idx');
}

async function ensureQualityCertificatesTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.quality_certificates (
      id                       SERIAL PRIMARY KEY,
      numero                   TEXT NOT NULL,
      certificado              TEXT,
      paineis_balisticos       TEXT,
      produtos                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      nota_fiscal              TEXT,
      veiculo                  TEXT,
      data_emissao             DATE,
      material                 TEXT DEFAULT 'Dupont Kevlar® S745GR',
      norma                    TEXT DEFAULT 'ABNT NBR 15000:2020-2',
      nivel                    TEXT DEFAULT 'III-A',
      certificados_conformidade JSONB NOT NULL DEFAULT '[]'::jsonb,
      garantia_anos            INTEGER DEFAULT 5,
      created_by               INTEGER REFERENCES maestro.users(id),
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at               TIMESTAMPTZ
    )
  `, 'maestro.quality_certificates');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS quality_certificates_numero_idx
      ON maestro.quality_certificates (numero)
  `, 'quality_certificates_numero_idx');

  // Fornecedor de tecido — snapshot string. Vem do enfesto (workorder do
  // Carbon) e fica registrado aqui para histórico do cert. emitido.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.quality_certificates
    ADD COLUMN IF NOT EXISTS fornecedor_tecido TEXT
  `, 'maestro.quality_certificates.fornecedor_tecido');
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
