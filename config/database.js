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
    // 42P01 = undefined_table. Pode acontecer em DDL dependente quando uma
    // criação anterior foi ignorada por falta de permissão (42501), como índice
    // ou FK sobre tabelas public.* compartilhadas com o Spring. Não derruba o
    // bootstrap; o endpoint real ainda falhará se a tabela necessária não existir.
    if (error?.code === '42P01') {
      console.warn(`⚠️ Objeto dependente ausente para ajuste automático: ${label}`);
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
      sha256_hash   varchar(64),
      created_at    timestamp DEFAULT now()
    )
  `, 'maestro.file_storage');

  // Compat: ambientes antigos podem não ter sha256_hash. Os arquivos legados
  // ficam com NULL e podem ser revalidados sob demanda (recomputar do disco).
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.file_storage
    ADD COLUMN IF NOT EXISTS sha256_hash varchar(64)
  `, 'maestro.file_storage.sha256_hash');
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
  await ensureCuttingRecordsJiraKey();
  await ensurePlateSupplierTable();
  await ensurePlateSizeTable();
  await ensurePanelReceiptTable();
  await ensurePanelReservationTable();
  await ensurePanelConsumptionTable();
  await ensureJiraNfAttachmentTable();
  await ensureFabricSupplierTable();
  await ensureWorkorderSharedTables();
  await ensureCarbonSharedTables();
  await ensureOsPlanningTable();
  await ensureOsPrintAuditTable();
  await ensureProductionPackTable();
  await ensureOsPlanningPackId();
  await ensureCronRunsTable();
  await ensureCronJobsTables();
  await ensureReportTemplatesTables();
  await ensureUserSecurityColumns();
  await ensureCargosTable();
  await ensureUserProfileColumns();
  await ensureRbacTables();
  await ensureOsGeneratedMeasureTable();
  await ensureMaterialsTable();
  await ensureMaterialVariantsTable();
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
      ('corte_romaneio_opera_enabled', '0', 'Permite gerar romaneio para registros de corte cujo único fornecedor é OPERA (0 = desabilitado, 1 = habilitado)'),
      ('quality_certificate_signature_user_id', '', 'Usuário exibido como assinante do certificado de qualidade')
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

  // Código numérico (1 dígito) do material usado no sequencial da Rastreabilidade.
  // Ex.: 1=Aramida, 2=Polietileno, 3=Aço — editável no cadastro de materiais.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.materials
    ADD COLUMN IF NOT EXISTS codigo_rastreabilidade SMALLINT
      CHECK (codigo_rastreabilidade IS NULL OR codigo_rastreabilidade BETWEEN 0 AND 9)
  `, 'maestro.materials.codigo_rastreabilidade');

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

async function ensureMaterialVariantsTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.material_variants (
      id          SERIAL PRIMARY KEY,
      material_id INTEGER NOT NULL REFERENCES maestro.materials(id) ON DELETE CASCADE,
      nome        TEXT NOT NULL,
      ativo       BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ,
      UNIQUE (material_id, nome)
    )
  `, 'maestro.material_variants');
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
      material_variant_id INTEGER REFERENCES maestro.material_variants(id),
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
    ADD COLUMN IF NOT EXISTS material_variant_id INTEGER REFERENCES maestro.material_variants(id)
  `, 'maestro.conformity_certificates.material_variant_id');

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

  // Vínculo com fornecedor de material balístico — chave usada pelo auto-fill
  // do Cert. de Qualidade junto com quantidade_camadas para escolher o cert.
  // aplicável. (Renomeado de plate_supplier_id; o cadastro fonte mudou de
  // maestro.plate_supplier para maestro.fabric_supplier.)
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.conformity_certificates
    ADD COLUMN IF NOT EXISTS fabric_supplier_id INTEGER REFERENCES maestro.fabric_supplier(id)
  `, 'maestro.conformity_certificates.fabric_supplier_id');

  // Compat: migra dados gravados em plate_supplier_id (modelo antigo) para
  // fabric_supplier_id, casando pelo nome do fornecedor. Idempotente — só
  // toca linhas onde fabric_supplier_id ainda é NULL e plate_supplier_id
  // tem valor mapeável. Se a coluna antiga não existe, no-op.
  await runCompatibilityQuery(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'maestro'
           AND table_name   = 'conformity_certificates'
           AND column_name  = 'plate_supplier_id'
      ) THEN
        UPDATE maestro.conformity_certificates c
           SET fabric_supplier_id = fs.id
          FROM maestro.plate_supplier ps
          JOIN maestro.fabric_supplier fs ON UPPER(fs.name) = UPPER(ps.name)
         WHERE c.plate_supplier_id = ps.id
           AND c.fabric_supplier_id IS NULL;
      END IF;
    END $$;
  `, 'maestro.conformity_certificates.plate_supplier_id→fabric_supplier_id');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS conformity_certificates_material_idx
      ON maestro.conformity_certificates (material_id)
  `, 'conformity_certificates_material_idx');

  // Índice de lookup do auto-fill: (fabric_supplier_id, quantidade_camadas).
  // Drop do antigo (plate_supplier_id) é seguro — não bloqueia o boot mesmo
  // se ele já não existir.
  await runCompatibilityQuery(`
    DROP INDEX IF EXISTS maestro.conformity_certificates_lookup_idx
  `, 'drop legacy conformity_certificates_lookup_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS conformity_certificates_lookup_idx
      ON maestro.conformity_certificates (fabric_supplier_id, quantidade_camadas)
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

  await runCompatibilityQuery(`
    WITH job AS (
      INSERT INTO maestro.cron_jobs (name, description)
      VALUES ('invoice-integrity', 'Valida hash SHA-256 e existencia dos documentos de NF ativos')
      ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
      RETURNING id
    )
    INSERT INTO maestro.cron_job_versions
      (job_id, version_number, status, cron_expression, code, notes)
    SELECT id, 1.00, 'OPE', '0 0 2 * * 1',
      'const { run } = require(''./invoiceIntegrity.cjs''); await run(ctx);',
      'Seed automatico da migracao Spring -> Node'
    FROM job
    ON CONFLICT (job_id, version_number) DO UPDATE SET
      status = 'OPE',
      cron_expression = EXCLUDED.cron_expression,
      code = EXCLUDED.code,
      notes = EXCLUDED.notes
  `, 'cron invoice-integrity seed');
}

async function ensureReportTemplatesTables() {
  // Registry de relatórios Jasper versionados. Espelha o modelo de cron_jobs:
  // o Node é a fonte da verdade (guarda o .jrxml + variáveis parseadas + JS) e
  // decide qual versão está "no ar" (OPE); o Spring renderiza de forma genérica.
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.report_templates (
      id          SERIAL PRIMARY KEY,
      key         TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      description TEXT,
      created_by  INTEGER REFERENCES maestro.users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ
    )
  `, 'maestro.report_templates');

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.report_template_versions (
      id                  BIGSERIAL PRIMARY KEY,
      template_id         INTEGER NOT NULL REFERENCES maestro.report_templates(id) ON DELETE CASCADE,
      version_number      NUMERIC(6,2) NOT NULL,
      status              TEXT NOT NULL CHECK (status IN ('DVP','SAT','REL','OPE')),
      jrxml               TEXT NOT NULL,
      variables           JSONB,
      code                TEXT,
      notes               TEXT,
      created_by          INTEGER REFERENCES maestro.users(id),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      status_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      status_changed_by   INTEGER REFERENCES maestro.users(id),
      CONSTRAINT report_template_versions_tpl_ver_unique UNIQUE (template_id, version_number)
    )
  `, 'maestro.report_template_versions');

  // Apenas uma versão por relatório pode estar em OPE (a que responde no /render/:key).
  await runCompatibilityQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS report_template_versions_ope_unique
      ON maestro.report_template_versions (template_id) WHERE status = 'OPE'
  `, 'report_template_versions_ope_unique');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS report_template_versions_tpl_idx
      ON maestro.report_template_versions (template_id, version_number DESC)
  `, 'report_template_versions_tpl_idx');
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

  // Nº da Nota Fiscal (customfield_10101 no Jira) — usado pra preencher a NF
  // do certificado de qualidade emitido pelo corte.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.jira_cards
    ADD COLUMN IF NOT EXISTS nota_fiscal TEXT;
  `, 'maestro.jira_cards.nota_fiscal');
}

async function ensureCuttingRecordsJiraKey() {
  // Congela o card Jira correspondente ao registro de corte no momento da
  // gravação. Sem isso, quando o certificado de qualidade é gerado depois, o
  // card pode já ter saído do kanban e o anexo perde destino. NULL é OK:
  // legítimo pra cortes produzidos sem card.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS public.cutting_records
    ADD COLUMN IF NOT EXISTS jira_key TEXT;
  `, 'public.cutting_records.jira_key');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS cutting_records_jira_key_idx
      ON public.cutting_records (jira_key)
  `, 'cutting_records_jira_key_idx');
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

  // Código numérico (2 dígitos) do fornecedor usado no sequencial da Rastreabilidade.
  // Ex.: 1=Protecta, 2=Dupont, 3=Dyneema, 4=APERAM — editável no cadastro de fornecedores.
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.fabric_supplier
    ADD COLUMN IF NOT EXISTS codigo_rastreabilidade SMALLINT
      CHECK (codigo_rastreabilidade IS NULL OR codigo_rastreabilidade BETWEEN 0 AND 99)
  `, 'maestro.fabric_supplier.codigo_rastreabilidade');
}

// Tabelas de Enfesto compartilhadas com o Spring (printServiceCarbon). Criadas
// pelo Maestro porque o Spring ainda não rodou contra este banco. Schema deve
// bater com as entidades JPA do Spring (workorder_table, Plates, plate_event)
// para que ddl-auto:update fique no-op quando o Spring subir.
// NOTA: apesar de @Table(name="Workorder_table") na entidade, o
// SpringPhysicalNamingStrategy do Hibernate fez fold para minúsculas, então a
// tabela no Postgres é workorder_table (unquoted, case-insensitive).
async function ensureWorkorderSharedTables() {
  await runCompatibilityQuery(
    `CREATE SEQUENCE IF NOT EXISTS public.workorder_sequence START 250`,
    'public.workorder_sequence',
  );
  await runCompatibilityQuery(
    `CREATE SEQUENCE IF NOT EXISTS public.plate_sequence`,
    'public.plate_sequence',
  );
  await runCompatibilityQuery(
    `CREATE SEQUENCE IF NOT EXISTS public.hibernate_sequence`,
    'public.hibernate_sequence',
  );

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.workorder_table (
      id              BIGINT PRIMARY KEY DEFAULT nextval('public.workorder_sequence'),
      creation_date   TIMESTAMP,
      change_date     TIMESTAMP,
      lote            VARCHAR(255),
      plates_quantity BIGINT,
      plates_layres   BIGINT,
      cloth_type      VARCHAR(255),
      cloth_batch     VARCHAR(255),
      fabric_supplier VARCHAR(255),
      plastic_type    VARCHAR(255),
      plastic_batch   VARCHAR(255),
      resined_batch   VARCHAR(255),
      enfesto_date    DATE
    )
  `, 'public.workorder_table');

  // Compatibilidade: adiciona fabric_supplier caso a tabela tenha sido criada
  // antes por uma versão do Spring sem o campo.
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.workorder_table ADD COLUMN IF NOT EXISTS fabric_supplier VARCHAR(255)`,
    'public.workorder_table.fabric_supplier',
  );

  // Compatibilidade: bancos legados criados pelo Spring tinham id BIGINT sem
  // default (Hibernate fornecia o id via @GeneratedValue). Como o INSERT do
  // Maestro não passa id explicitamente, garantimos o DEFAULT nextval e
  // sincronizamos a sequence para que o próximo valor seja > MAX(id) existente.
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.workorder_table
       ALTER COLUMN id SET DEFAULT nextval('public.workorder_sequence')`,
    'public.workorder_table.id default',
  );
  await runCompatibilityQuery(
    `SELECT setval('public.workorder_sequence',
       GREATEST((SELECT COALESCE(MAX(id), 0) FROM public.workorder_table) + 1, 250),
       false)`,
    'public.workorder_sequence sync',
  );
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.plates
       ALTER COLUMN id SET DEFAULT nextval('public.plate_sequence')`,
    'public.plates.id default',
  );
  await runCompatibilityQuery(
    `SELECT setval('public.plate_sequence',
       GREATEST((SELECT COALESCE(MAX(id), 0) FROM public.plates) + 1, 1),
       false)`,
    'public.plate_sequence sync',
  );
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.plate_event
       ALTER COLUMN id SET DEFAULT nextval('public.hibernate_sequence')`,
    'public.plate_event.id default',
  );
  await runCompatibilityQuery(
    `SELECT setval('public.hibernate_sequence',
       GREATEST((SELECT COALESCE(MAX(id), 0) FROM public.plate_event) + 1, 1),
       false)`,
    'public.hibernate_sequence sync',
  );

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.plates (
      id              BIGINT PRIMARY KEY DEFAULT nextval('public.plate_sequence'),
      workorderid     BIGINT REFERENCES public.workorder_table(id),
      plate_sequence  BIGINT,
      status          VARCHAR(50),
      layers          BIGINT,
      actual_size     DOUBLE PRECISION,
      init_size       DOUBLE PRECISION,
      package_id      BIGINT
    )
  `, 'public.plates');

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS plates_workorder_idx ON public.plates (workorderid)`,
    'plates_workorder_idx',
  );

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.plate_event (
      id                       BIGINT PRIMARY KEY DEFAULT nextval('public.hibernate_sequence'),
      plate_id                 BIGINT REFERENCES public.plates(id),
      event_type               VARCHAR(50),
      event_date               TIMESTAMP,
      consumption_reference_id BIGINT,
      consumed_area            DOUBLE PRECISION,
      consumed_length          DOUBLE PRECISION,
      description              TEXT
    )
  `, 'public.plate_event');

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS plate_event_plate_idx ON public.plate_event (plate_id)`,
    'plate_event_plate_idx',
  );
}

// Tabelas Spring restantes (autoclave, cutting, invoices, receipts).
// Spring nunca rodou contra este banco — Maestro precisa criar tudo antes da
// Fase 1+ migrar as queries para JS. Schema bate com as entidades Hibernate
// (SpringPhysicalNamingStrategy camelCase → snake_case) para que o Spring
// legado continue funcionando enquanto sobrevive (ddl-auto:update vira no-op).
// Typos do Spring preservados: cycle_obervation, plates_layres.
async function ensureCarbonSharedTables() {
  // 5.0.1 autoclave_cycle — status migrado p/ VARCHAR (R-1). Spring não tinha
  // @Enumerated → gravava ordinal int. Aqui já nasce STRING; em Fase 2 o
  // Spring precisa receber @Enumerated(EnumType.STRING) + backfill no banco.
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.autoclave_cycle (
      id               BIGSERIAL PRIMARY KEY,
      creation_date    TIMESTAMP,
      start_time       TIMESTAMP,
      cicle_date       TIMESTAMP,
      status           VARCHAR(40),
      report_file_id   UUID REFERENCES maestro.file_storage(id),
      report_file_path TEXT,
      cycle_obervation TEXT
    )
  `, 'public.autoclave_cycle');

  // Compatibilidade: bancos legados criados pelo Spring antes da Fase 2 não
  // tinham report_file_id (a FK para maestro.file_storage foi adicionada na
  // migração). CREATE TABLE IF NOT EXISTS não adiciona colunas em tabela
  // existente — precisamos do ALTER explícito.
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.autoclave_cycle
       ADD COLUMN IF NOT EXISTS report_file_id UUID REFERENCES maestro.file_storage(id)`,
    'public.autoclave_cycle.report_file_id',
  );

  // Compatibilidade R-1: Spring antigo gravava CycleStatus como ordinal SMALLINT
  // (sem @Enumerated). Maestro espera VARCHAR. Faz backfill ordinal→string e
  // converte o tipo. Idempotente: só roda se a coluna ainda for numérica.
  await runCompatibilityQuery(`
    DO $$
    DECLARE
      current_type text;
      ck record;
    BEGIN
      SELECT data_type INTO current_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'autoclave_cycle'
         AND column_name  = 'status';

      IF current_type IN ('smallint', 'integer', 'bigint') THEN
        -- 0) Spring/Hibernate cria CHECK constraints (status >= 0 AND status <= N)
        --    para enums ordinais. Precisa dropar antes do ALTER TYPE, senão o
        --    Postgres falha ao revalidar a constraint contra a nova coluna text.
        FOR ck IN
          SELECT con.conname
            FROM pg_constraint con
            JOIN pg_class       cls ON cls.oid = con.conrelid
            JOIN pg_namespace   nsp ON nsp.oid = cls.relnamespace
           WHERE nsp.nspname = 'public'
             AND cls.relname = 'autoclave_cycle'
             AND con.contype = 'c'
             AND pg_get_constraintdef(con.oid) ILIKE '%status%'
        LOOP
          EXECUTE format('ALTER TABLE public.autoclave_cycle DROP CONSTRAINT %I', ck.conname);
        END LOOP;

        -- 1) Converte o tipo da coluna (ordinal vira string '0','1',...).
        ALTER TABLE public.autoclave_cycle
          ALTER COLUMN status TYPE VARCHAR(40) USING status::text;

        -- 2) Traduz os ordinais para os nomes do enum CycleStatus.
        UPDATE public.autoclave_cycle SET status = CASE status
          WHEN '0' THEN 'DUPLICADO'
          WHEN '1' THEN 'CRIADO'
          WHEN '2' THEN 'PENDENTE'
          WHEN '3' THEN 'EM_ANDAMENTO'
          WHEN '4' THEN 'PAUSADO'
          WHEN '5' THEN 'CANCELADO'
          WHEN '6' THEN 'REPASSE'
          WHEN '7' THEN 'FINALIZADO'
          ELSE status
        END
        WHERE status ~ '^[0-9]+$';
      END IF;
    END $$;
  `, 'public.autoclave_cycle.status ordinal→string');

  // 5.0.2 package. Apesar de @Table(name="Package") na entidade Spring, o
  // SpringPhysicalNamingStrategy faz fold para minúsculas — a tabela no
  // Postgres é "package" unquoted. Spring usa @SequenceGenerator com
  // allocationSize=1 e nome package_autoclave_sequence.
  await runCompatibilityQuery(
    `CREATE SEQUENCE IF NOT EXISTS public.package_autoclave_sequence START 1`,
    'public.package_autoclave_sequence',
  );

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.package (
      id                    BIGINT PRIMARY KEY DEFAULT nextval('public.package_autoclave_sequence'),
      package_observations  TEXT,
      cycle_id              BIGINT REFERENCES public.autoclave_cycle(id),
      creation_date         TIMESTAMP,
      finish_date           TIMESTAMP,
      package_status        VARCHAR(40)
    )
  `, 'public.package');

  // Compatibilidade: bancos legados criados pelo Spring tinham package.id BIGINT
  // sem default (Hibernate fornecia o id via @GeneratedValue). Como o INSERT do
  // Maestro não passa id explicitamente, garantimos o DEFAULT nextval e
  // sincronizamos a sequence para que o próximo valor seja > MAX(id) existente.
  // (Mesmo tratamento de workorder_table/plates/plate_event acima.)
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.package
       ALTER COLUMN id SET DEFAULT nextval('public.package_autoclave_sequence')`,
    'public.package.id default',
  );
  await runCompatibilityQuery(
    `SELECT setval('public.package_autoclave_sequence',
       GREATEST((SELECT COALESCE(MAX(id), 0) FROM public.package) + 1, 1),
       false)`,
    'public.package_autoclave_sequence sync',
  );

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS package_cycle_idx ON public.package (cycle_id)`,
    'package_cycle_idx',
  );

  // 5.0.3 FK plates.package_id → package.id. Coluna já criada em
  // ensureWorkorderSharedTables sem FK (package não existia ainda).
  // Adiciona a constraint de forma idempotente — se já existe, ignora.
  await runCompatibilityQuery(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'plates_package_fk'
          AND table_name = 'plates'
      ) THEN
        ALTER TABLE public.plates
          ADD CONSTRAINT plates_package_fk
          FOREIGN KEY (package_id) REFERENCES public.package(id);
      END IF;
    END $$;
  `, 'plates_package_fk');

  // 5.0.4 cutting_records — MaterialType e KitType como STRING.
  // created_by é metadado novo (Spring não tinha auth — ver §4.7).
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.cutting_records (
      id                BIGSERIAL PRIMARY KEY,
      production_date   TIMESTAMP NOT NULL,
      order_number      VARCHAR(120) NOT NULL,
      order_description VARCHAR(255) NOT NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      created_by        VARCHAR(120),
      material          VARCHAR(40),
      kit_type          VARCHAR(40),
      seal              VARCHAR(120)
    )
  `, 'public.cutting_records');

  // Compatibilidade: cutting_records criada pelo Spring legado não tinha
  // created_at / created_by / material / kit_type / seal. CREATE TABLE IF NOT
  // EXISTS é no-op em tabela existente — precisa ALTER explícito.
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.cutting_records
       ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`,
    'public.cutting_records.created_at',
  );
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.cutting_records
       ADD COLUMN IF NOT EXISTS created_by VARCHAR(120)`,
    'public.cutting_records.created_by',
  );
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.cutting_records
       ADD COLUMN IF NOT EXISTS material VARCHAR(40)`,
    'public.cutting_records.material',
  );
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.cutting_records
       ADD COLUMN IF NOT EXISTS kit_type VARCHAR(40)`,
    'public.cutting_records.kit_type',
  );
  await runCompatibilityQuery(
    `ALTER TABLE IF EXISTS public.cutting_records
       ADD COLUMN IF NOT EXISTS seal VARCHAR(120)`,
    'public.cutting_records.seal',
  );

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS cutting_records_order_idx
       ON public.cutting_records (order_number)`,
    'cutting_records_order_idx',
  );

  // 5.0.5 plate_consumptions — supplier (SupplierType STRING).
  // OPERA usa plate_id; COMTEC/PROTECTA não (validado no service da Fase 3).
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.plate_consumptions (
      id                BIGSERIAL PRIMARY KEY,
      used_metrage      NUMERIC(10,2) NOT NULL,
      batch_number      VARCHAR(120),
      supplier          VARCHAR(40) NOT NULL,
      layer_quantity    VARCHAR(40) NOT NULL,
      manual_batch      BOOLEAN NOT NULL,
      plate_id          BIGINT REFERENCES public.plates(id),
      cutting_record_id BIGINT NOT NULL REFERENCES public.cutting_records(id) ON DELETE CASCADE,
      square_meters     NUMERIC,
      waste_metrage     NUMERIC NOT NULL DEFAULT 0
    )
  `, 'public.plate_consumptions');

  // m² persistido (com desperdício embutido) + mm de desperdício baixado do
  // saldo. Idempotente p/ bancos que criaram a tabela antes destas colunas.
  await runCompatibilityQuery(
    `ALTER TABLE public.plate_consumptions
       ADD COLUMN IF NOT EXISTS square_meters NUMERIC,
       ADD COLUMN IF NOT EXISTS waste_metrage NUMERIC NOT NULL DEFAULT 0`,
    'plate_consumptions.square_meters/waste_metrage',
  );

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS plate_consumptions_record_idx
       ON public.plate_consumptions (cutting_record_id)`,
    'plate_consumptions_record_idx',
  );

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS plate_consumptions_plate_idx
       ON public.plate_consumptions (plate_id)`,
    'plate_consumptions_plate_idx',
  );

  // 5.0.6 invoices
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.invoices (
      id                   BIGSERIAL PRIMARY KEY,
      invoice_number       VARCHAR(120) NOT NULL UNIQUE,
      nf_file_path         TEXT,
      correction_file_path TEXT,
      created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
      created_by           VARCHAR(120)
    )
  `, 'public.invoices');

  // 5.0.7 plate_consumption_invoices (junction PlateConsumption × Invoice)
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.plate_consumption_invoices (
      id                   BIGSERIAL PRIMARY KEY,
      used_metrage         NUMERIC(10,2) NOT NULL,
      plate_consumption_id BIGINT NOT NULL REFERENCES public.plate_consumptions(id) ON DELETE CASCADE,
      invoice_id           BIGINT NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE
    )
  `, 'public.plate_consumption_invoices');

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS pci_invoice_idx
       ON public.plate_consumption_invoices (invoice_id)`,
    'pci_invoice_idx',
  );

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS pci_consumption_idx
       ON public.plate_consumption_invoices (plate_consumption_id)`,
    'pci_consumption_idx',
  );

  // 5.0.8 consumption_splits — outra junção, usada para particionar consumo
  // entre múltiplas NFs com regras de aging diferentes.
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.consumption_splits (
      id                   BIGSERIAL PRIMARY KEY,
      used_metrage         NUMERIC(10,2) NOT NULL,
      invoice_id           BIGINT NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
      plate_consumption_id BIGINT NOT NULL REFERENCES public.plate_consumptions(id) ON DELETE CASCADE
    )
  `, 'public.consumption_splits');

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS splits_invoice_idx
       ON public.consumption_splits (invoice_id)`,
    'splits_invoice_idx',
  );

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS splits_consumption_idx
       ON public.consumption_splits (plate_consumption_id)`,
    'splits_consumption_idx',
  );

  // 5.0.9 invoice_documents — versionamento via replaced_by_id + active.
  // file_id (UUID em maestro.file_storage) é preferido daqui pra frente;
  // storage_path mantido só para compat com NFs criadas antes do file_storage.
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.invoice_documents (
      id                BIGSERIAL PRIMARY KEY,
      invoice_id        BIGINT NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
      type              VARCHAR(40) NOT NULL,
      original_filename VARCHAR(255) NOT NULL,
      storage_path      TEXT NOT NULL,
      file_id           UUID REFERENCES maestro.file_storage(id),
      file_size_bytes   BIGINT NOT NULL,
      sha256_hash       VARCHAR(64) NOT NULL,
      version           INTEGER NOT NULL,
      active            BOOLEAN NOT NULL,
      replaced_by_id    BIGINT REFERENCES public.invoice_documents(id),
      uploaded_by       VARCHAR(120),
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `, 'public.invoice_documents');

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS invoice_documents_invoice_active_idx
       ON public.invoice_documents (invoice_id, active)`,
    'invoice_documents_invoice_active_idx',
  );

  // 5.0.10 document_integrity_checks — alimentado pelo cron semanal
  // (Fase 4, mover Spring @Scheduled → maestro.cron_jobs).
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public.document_integrity_checks (
      id            BIGSERIAL PRIMARY KEY,
      document_id   BIGINT NOT NULL REFERENCES public.invoice_documents(id) ON DELETE CASCADE,
      status        VARCHAR(20) NOT NULL,
      stored_hash   VARCHAR(64) NOT NULL,
      computed_hash VARCHAR(64),
      checked_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      notes         TEXT
    )
  `, 'public.document_integrity_checks');

  await runCompatibilityQuery(
    `CREATE INDEX IF NOT EXISTS integrity_doc_idx
       ON public.document_integrity_checks (document_id)`,
    'integrity_doc_idx',
  );

  // 5.0.11 "Receipt" (case-sensitive). Spring usa receipt_sequence START 250.
  // receive_date mantido como VARCHAR porque o entity Spring grava como String.
  await runCompatibilityQuery(
    `CREATE SEQUENCE IF NOT EXISTS public.receipt_sequence START 250`,
    'public.receipt_sequence',
  );

  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS public."Receipt" (
      id           BIGINT PRIMARY KEY DEFAULT nextval('public.receipt_sequence'),
      nf           VARCHAR(120),
      intern_batch VARCHAR(120),
      situation    VARCHAR(120),
      quantity     VARCHAR(120),
      responsible  VARCHAR(120),
      observation  TEXT,
      receive_date VARCHAR(40),
      created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
      created_by   VARCHAR(120)
    )
  `, 'public.Receipt');
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

// Recebimento de painéis externos (substitui aba "Notas Recebidas" da planilha
// "Fábrica de Opaco - Rev2.xlsx"). consumed_m2 e reserved_m2 ficam zerados
// nesta etapa e serão alimentados pelas etapas 3 (vínculo apontamento) e 4
// (reservas) da SPEC-faturamento-paineis.md.
async function ensurePanelReceiptTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.panel_receipts (
      id              SERIAL PRIMARY KEY,
      supplier        TEXT          NOT NULL,
      external_batch  TEXT          NOT NULL,
      invoice_number  TEXT,
      layers          INTEGER       NOT NULL CHECK (layers > 0),
      received_m2     NUMERIC(12,4) NOT NULL CHECK (received_m2 >= 0),
      consumed_m2     NUMERIC(12,4) NOT NULL DEFAULT 0,
      reserved_m2     NUMERIC(12,4) NOT NULL DEFAULT 0,
      received_at     DATE          NOT NULL,
      notes           TEXT,
      created_by      INTEGER REFERENCES maestro.users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ
    )
  `, 'maestro.panel_receipts');

  // Duplicidade lógica: (supplier, external_batch, invoice_number) único.
  // invoice_number pode ser NULL — UNIQUE NULLS NOT DISTINCT exige PG 15+;
  // usamos índice parcial para tratar NULL como "diferente de qualquer NULL"
  // (default ANSI) e índice separado para o caso com NF preenchida.
  await runCompatibilityQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS panel_receipts_supplier_batch_invoice_unique
      ON maestro.panel_receipts (supplier, external_batch, invoice_number)
      WHERE invoice_number IS NOT NULL
  `, 'panel_receipts_supplier_batch_invoice_unique');

  await runCompatibilityQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS panel_receipts_supplier_batch_no_invoice_unique
      ON maestro.panel_receipts (supplier, external_batch)
      WHERE invoice_number IS NULL
  `, 'panel_receipts_supplier_batch_no_invoice_unique');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS panel_receipts_supplier_idx
      ON maestro.panel_receipts (supplier)
  `, 'panel_receipts_supplier_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS panel_receipts_received_at_idx
      ON maestro.panel_receipts (received_at DESC)
  `, 'panel_receipts_received_at_idx');

  // Etapa 2 — status de validação manual de saldo (aba "Itens Negativos" / coluna Obs="Ok").
  // AUTO   = default ao cadastrar
  // VALIDATED = faturista revisou o saldo manualmente
  // NEGATIVE = derivado (balance_m2 < 0) — computado em SELECT, nunca persistido aqui
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.panel_receipts
    ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'AUTO'
      CHECK (validation_status IN ('AUTO', 'VALIDATED'))
  `, 'maestro.panel_receipts.validation_status');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.panel_receipts
    ADD COLUMN IF NOT EXISTS validated_by INTEGER REFERENCES maestro.users(id)
  `, 'maestro.panel_receipts.validated_by');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.panel_receipts
    ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ
  `, 'maestro.panel_receipts.validated_at');
}

// Etapa 4 — reservas de saldo (campo "Metragem Reservada" da planilha).
// reserved_m2 do panel_receipt é derivado por SUM em SELECT; nunca é gravado
// aqui — evita drift entre soma e total persistido.
async function ensurePanelReservationTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.panel_reservations (
      id                SERIAL PRIMARY KEY,
      panel_receipt_id  INTEGER NOT NULL REFERENCES maestro.panel_receipts(id) ON DELETE CASCADE,
      order_number      TEXT          NOT NULL,
      reserved_m2       NUMERIC(12,4) NOT NULL CHECK (reserved_m2 > 0),
      notes             TEXT,
      reserved_by       INTEGER REFERENCES maestro.users(id),
      reserved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      consumed_at       TIMESTAMPTZ,
      cancelled_at      TIMESTAMPTZ,
      cancelled_by      INTEGER REFERENCES maestro.users(id)
    )
  `, 'maestro.panel_reservations');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS panel_reservations_receipt_idx
      ON maestro.panel_reservations (panel_receipt_id)
      WHERE consumed_at IS NULL AND cancelled_at IS NULL
  `, 'panel_reservations_receipt_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS panel_reservations_order_idx
      ON maestro.panel_reservations (order_number)
      WHERE consumed_at IS NULL AND cancelled_at IS NULL
  `, 'panel_reservations_order_idx');
}

// Etapa 7 — tabela-ponte de alocação de consumo a recebimentos de painel.
// Como o backend da CarbonProduction (cutting_consumptions) não está no
// workspace, esta tabela vive no maestro_api e é populada pelo frontend
// após salvar o consumo via PUT /cutting-records/invoices. Cada linha
// representa "x m² do consumo Y (cutting_consumption_id) foram alocados ao
// recebimento Z, faturado na NF W". É a fonte da verdade para
// panel_receipts.consumed_m2 (derivado no BASE_SELECT).
async function ensurePanelConsumptionTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.panel_consumptions (
      id                       SERIAL PRIMARY KEY,
      panel_receipt_id         INTEGER NOT NULL REFERENCES maestro.panel_receipts(id) ON DELETE RESTRICT,
      cutting_record_id        INTEGER,           -- id no backend CarbonProduction (referência fraca)
      cutting_consumption_id   INTEGER,           -- id no backend CarbonProduction (referência fraca)
      cutting_split_id         INTEGER,           -- id do split (quando vier fracionado por NF)
      order_number             TEXT,
      invoice_number           TEXT,
      used_m2                  NUMERIC(12,4) NOT NULL CHECK (used_m2 > 0),
      supplier                 TEXT,
      external_batch           TEXT,
      created_by               INTEGER REFERENCES maestro.users(id),
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      cancelled_at             TIMESTAMPTZ,
      cancelled_by             INTEGER REFERENCES maestro.users(id)
    )
  `, 'maestro.panel_consumptions');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS panel_consumptions_receipt_idx
      ON maestro.panel_consumptions (panel_receipt_id)
      WHERE cancelled_at IS NULL
  `, 'panel_consumptions_receipt_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS panel_consumptions_record_idx
      ON maestro.panel_consumptions (cutting_record_id)
      WHERE cancelled_at IS NULL
  `, 'panel_consumptions_record_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS panel_consumptions_order_idx
      ON maestro.panel_consumptions (order_number)
      WHERE cancelled_at IS NULL
  `, 'panel_consumptions_order_idx');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS panel_consumptions_invoice_idx
      ON maestro.panel_consumptions (invoice_number)
      WHERE cancelled_at IS NULL
  `, 'panel_consumptions_invoice_idx');
}

// Etapa 5 — registro de anexos de NF enviados ao Jira via attachToJiraIssue.
// Permite mostrar badge "Sincronizado com Jira" no DocumentUpload sem chamar
// o Jira a cada renderização.
async function ensureJiraNfAttachmentTable() {
  await runCompatibilityQuery(`
    CREATE TABLE IF NOT EXISTS maestro.jira_nf_attachments (
      id                  SERIAL PRIMARY KEY,
      invoice_number      TEXT NOT NULL,
      order_number        TEXT,
      jira_issue_key      TEXT,
      jira_attachment_id  TEXT,
      filename            TEXT,
      status              TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILED')),
      error_message       TEXT,
      attached_by         INTEGER REFERENCES maestro.users(id),
      attached_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, 'maestro.jira_nf_attachments');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS jira_nf_attachments_invoice_idx
      ON maestro.jira_nf_attachments (invoice_number, attached_at DESC)
  `, 'jira_nf_attachments_invoice_idx');
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

  // Geolocalização (aproximada, por IP) de quem acessa o site. Alimentada pelo
  // middleware accessGeoLogger e consultada na página de Auditoria > Localização.
  await runCompatibilityQuery(`
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
    )
  `, 'maestro.access_geo');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS idx_access_geo_created
      ON maestro.access_geo (created_at DESC)
  `, 'idx_access_geo_created');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS idx_access_geo_country
      ON maestro.access_geo (country)
  `, 'idx_access_geo_country');

  // Produção Unificada de Materiais: tabela-mãe os_snapshot (espelho do card-pai
  // Apontamento Produção / AP) + uma tabela por material/fábrica (join solto
  // por numero_os, sem FK rígida — crons independentes). Alimentadas pelos jobs
  // sync_os_snapshot / sync_fabrica_<material> (ver cron_jobs/jiraFabricaSync.cjs).
  await runCompatibilityQuery(`
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
    )
  `, 'maestro.os_snapshot');

  // Colunas do Dashboard de Processos (adicionadas após a v1 da os_snapshot).
  // Idempotente: ADD COLUMN IF NOT EXISTS não falha em tabela já existente.
  await runCompatibilityQuery(`
    ALTER TABLE maestro.os_snapshot
      ADD COLUMN IF NOT EXISTS etapa_pb           VARCHAR(120),
      ADD COLUMN IF NOT EXISTS veiculo_compras    TEXT,
      ADD COLUMN IF NOT EXISTS cor                TEXT,
      ADD COLUMN IF NOT EXISTS blindagem          TEXT,
      ADD COLUMN IF NOT EXISTS chassi             VARCHAR(40),
      ADD COLUMN IF NOT EXISTS parceiro           TEXT,
      ADD COLUMN IF NOT EXISTS data_pedido        DATE,
      ADD COLUMN IF NOT EXISTS data_recebimento   DATE,
      ADD COLUMN IF NOT EXISTS data_contrato      DATE,
      ADD COLUMN IF NOT EXISTS prazo_contrato     VARCHAR(20),
      ADD COLUMN IF NOT EXISTS liberacao_exercito DATE,
      ADD COLUMN IF NOT EXISTS obs                TEXT
  `, 'os_snapshot.dashboard_cols');

  // A mãe começou como espelho do PB; o pai real é o AP. Renomeia a coluna se a
  // tabela já existir com o nome antigo (idempotente — ignora se já for ap_key).
  await runCompatibilityQuery(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'maestro' AND table_name = 'os_snapshot' AND column_name = 'pb_key'
      ) THEN
        ALTER TABLE maestro.os_snapshot RENAME COLUMN pb_key TO ap_key;
      END IF;
    END $$;
  `, 'os_snapshot.pb_key->ap_key');

  for (const m of ['vidro', 'aco', 'manta', 'tensylon', 'sup_vidro']) {
    await runCompatibilityQuery(`
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
      )
    `, `maestro.producao_${m}`);
    await runCompatibilityQuery(
      `CREATE INDEX IF NOT EXISTS idx_producao_${m}_os ON maestro.producao_${m} (numero_os)`,
      `idx_producao_${m}_os`,
    );
    // pedido_carbon começou como VARCHAR(60); alguns cards (ACO) estouram esse
    // tamanho. Widening idempotente para TEXT em tabelas já criadas.
    await runCompatibilityQuery(
      `ALTER TABLE maestro.producao_${m} ALTER COLUMN pedido_carbon TYPE TEXT`,
      `producao_${m}.pedido_carbon->TEXT`,
    );
    // fabrica/fornecedor do material (só VIDRO preenche hoje — coluna "Vidro" do
    // Dashboard de Processos). Idempotente em tabelas já criadas.
    await runCompatibilityQuery(
      `ALTER TABLE maestro.producao_${m} ADD COLUMN IF NOT EXISTS fabrica TEXT`,
      `producao_${m}.fabrica`,
    );
  }

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
      signature_user_id         INTEGER REFERENCES maestro.users(id),
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

  // Vínculo opcional com o cutting_record que originou o cert. Permite
  // idempotência no fluxo de geração em lote a partir da tela de corte
  // (UNIQUE parcial — só vale quando preenchido, certs criados manualmente
  // continuam com NULL e não colidem entre si).
  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.quality_certificates
    ADD COLUMN IF NOT EXISTS cutting_record_id BIGINT
  `, 'maestro.quality_certificates.cutting_record_id');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.quality_certificates
    ADD COLUMN IF NOT EXISTS signature_user_id INTEGER REFERENCES maestro.users(id)
  `, 'maestro.quality_certificates.signature_user_id');

  await runCompatibilityQuery(`
    ALTER TABLE IF EXISTS maestro.quality_certificates
    ADD COLUMN IF NOT EXISTS order_number TEXT
  `, 'maestro.quality_certificates.order_number');

  await runCompatibilityQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS quality_certificates_cutting_record_uniq
      ON maestro.quality_certificates (cutting_record_id)
      WHERE cutting_record_id IS NOT NULL
  `, 'quality_certificates_cutting_record_uniq');

  await runCompatibilityQuery(`
    CREATE INDEX IF NOT EXISTS quality_certificates_order_number_idx
      ON maestro.quality_certificates (order_number)
  `, 'quality_certificates_order_number_idx');
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
