// Single source of truth for RBAC resources, actions, and route gates.
// Consumed by:
//   - middleware/rbac.js           (server-side enforcement)
//   - scripts/seed-rbac.js        (seeds permissions + roles into DB)
//   - GET /api/auth/permissions-catalog (exposes catalog to frontend)
//
// To add a resource: add an entry to RESOURCES and map its routes in
// ROUTE_PERMISSIONS. Never hard-code resource strings in route handlers.

export const RESOURCES = {
  // Projetos / Planos de Corte
  cutting_projects:    ['read', 'create', 'update', 'delete', 'clone', 'export'],
  cutting_plans:       ['read', 'create', 'update', 'delete'],
  cutting_attachments: ['read', 'upload', 'remove', 'download'],

  // PCP
  pcp_orders:         ['read', 'create', 'update', 'delete'],
  pcp_acompanhamento: ['read'],
  pcp_reports:        ['read', 'export'],

  // Espelhos
  espelhos: ['read', 'create', 'update', 'delete', 'export'],

  // Qualidade
  certificates: ['read', 'create', 'update', 'delete'],

  // Produção — Rastreabilidade + IIS
  materials:             ['read', 'create', 'update', 'delete'],
  conformity_certificates: ['read', 'create', 'update', 'delete'],
  rastreabilidades:      ['read', 'create', 'update', 'delete'],
  production_config:     ['read', 'update'],
  workorders:            ['read', 'create', 'update', 'delete'],
  plates:                ['read', 'create', 'update'],
  autoclave:             ['read', 'create', 'update', 'approve', 'upload', 'download'],
  cutting_records:       ['read', 'create', 'update', 'delete'],
  etiquetas:             ['read', 'print', 'download'],

  // Faturamento
  invoices:            ['read', 'create', 'update', 'upload', 'download', 'approve'],
  receipts:            ['read', 'create', 'update', 'delete'],

  // Cadastros
  plate_suppliers:  ['read', 'create', 'update', 'delete'],
  fabric_suppliers: ['read', 'create', 'update', 'delete'],

  // Recebimento de painéis externos (substitui aba "Notas Recebidas" da planilha)
  panel_receipts:     ['read', 'create', 'update', 'delete', 'validate'],
  panel_reservations: ['read', 'create', 'delete'],
  panel_consumptions: ['read', 'manage'],

  // Auditoria
  audit_logs:   ['read', 'export'],
  cron_runs:    ['read'],
  cron_jobs:    ['read', 'create', 'update', 'delete', 'execute', 'promote'],
  access_audit: ['read'],

  // Relatórios Jasper versionados (registry no Node + render no Spring)
  report_templates: ['read', 'create', 'update', 'delete', 'execute', 'promote'],

  // Dashboard / Métricas
  metrics: ['read'],

  // Gestão de usuários e acessos
  users:       ['read', 'create', 'update', 'delete'],
  roles:       ['read', 'create', 'update', 'delete'],
  user_access: ['manage'],

  // Preferências globais da aplicação (flags de comportamento de páginas).
  // Leitura é liberada para qualquer autenticado pelo próprio endpoint; o
  // gate aqui controla apenas quem pode editar.
  app_preferences: ['update'],
};

// Flat array of { resource, action } — seeded into maestro.permissions.
export const ALL_PERMISSIONS = Object.entries(RESOURCES).flatMap(
  ([resource, actions]) => actions.map((action) => ({ resource, action })),
);

// Human-readable labels for resources (pages) — used in the permissions tree UI.
export const RESOURCE_LABELS = {
  cutting_projects:    'Projetos de Corte',
  cutting_plans:       'Planos de Corte',
  cutting_attachments: 'Anexos de Planos',
  pcp_orders:          'Ordens de Produção',
  pcp_acompanhamento:  'Acompanhamento',
  pcp_reports:         'Relatórios de PCP',
  espelhos:            'Espelhos',
  certificates:            'Certificados de Qualidade',
  materials:               'Materiais',
  conformity_certificates: 'Certificados de Conformidade RETEX',
  rastreabilidades:        'Rastreabilidade e IIS',
  production_config:       'Configuração de Produção',
  workorders:              'Enfesto e Plates',
  plates:                  'Placas',
  autoclave:               'Autoclave',
  cutting_records:         'Apontamento de Corte',
  etiquetas:               'Etiquetagem',
  invoices:            'Notas Fiscais',
  receipts:            'Recebimentos',
  plate_suppliers:     'Fornecedores de Placa',
  panel_receipts:      'Recebimento de Painéis',
  panel_reservations:  'Reservas de Painéis',
  panel_consumptions:  'Alocações de Consumo em Painel',
  fabric_suppliers:    'Fornecedores de Material Balístico',
  audit_logs:          'Logs de Auditoria',
  cron_runs:           'Histórico de Cron',
  cron_jobs:           'Cron Jobs',
  report_templates:    'Relatórios Jasper',
  access_audit:        'Auditoria de Acessos',
  metrics:             'Dashboard / Métricas',
  users:               'Usuários',
  roles:               'Roles',
  user_access:         'Acessos de Usuários',
  app_preferences:     'Preferências da Aplicação',
};

// Human-readable labels for actions — used in the permissions tree UI.
export const ACTION_LABELS = {
  read:     'Visualizar',
  create:   'Criar',
  update:   'Editar',
  delete:   'Excluir',
  export:   'Exportar',
  clone:    'Clonar',
  upload:   'Enviar arquivos',
  remove:   'Remover arquivos',
  download: 'Baixar arquivos',
  execute:  'Executar',
  promote:  'Promover',
  manage:   'Gerenciar',
  print:    'Imprimir',
};

// Module = business area grouping a set of resources (pages).
// Used by the permissions tree UI in user management.
// The order here defines the display order in the UI.
export const MODULES = [
  { id: 'projetos',    label: 'Projetos',      resources: ['cutting_projects', 'cutting_plans', 'cutting_attachments', 'espelhos'] },
  { id: 'pcp',         label: 'PCP',           resources: ['pcp_orders', 'pcp_acompanhamento', 'pcp_reports'] },
  { id: 'producao',    label: 'Produção',      resources: ['workorders', 'rastreabilidades', 'production_config'] },
  { id: 'qualidade',   label: 'Qualidade',     resources: ['certificates'] },
  { id: 'faturamento', label: 'Faturamento',   resources: ['invoices', 'receipts'] },
  { id: 'cadastros',   label: 'Cadastros',     resources: ['plate_suppliers', 'panel_receipts', 'panel_reservations', 'panel_consumptions', 'fabric_suppliers', 'materials', 'conformity_certificates'] },
  { id: 'auditoria',   label: 'Auditoria',     resources: ['audit_logs', 'cron_runs', 'cron_jobs', 'access_audit'] },
  { id: 'dashboard',   label: 'Dashboard',     resources: ['metrics'] },
  { id: 'admin',       label: 'Administração', resources: ['users', 'roles', 'user_access', 'app_preferences', 'report_templates'] },
];

// Frontend route → minimum permission to enter that page.
// Keys: always with leading '/', never with trailing '/'.
// null = always accessible to any authenticated user.
const productionModule = MODULES.find((m) => m.id === 'producao');
if (productionModule) {
  productionModule.resources = ['workorders', 'plates', 'autoclave', 'cutting_records', 'etiquetas', 'rastreabilidades', 'production_config'];
}

export const ROUTE_PERMISSIONS = {
  '/home':                         { resource: 'metrics',             action: 'read'   },
  '/metricas':                     { resource: 'metrics',             action: 'read'   },
  '/pcp/ordens':                   { resource: 'pcp_orders',          action: 'read'   },
  '/pcp/acompanhamento':           { resource: 'pcp_acompanhamento',  action: 'read'   },
  '/pcp/relatorios':               { resource: 'pcp_reports',         action: 'read'   },
  '/pcp/gestao':                   { resource: 'pcp_orders',          action: 'read'   },
  '/projetos/corte':               { resource: 'cutting_projects',    action: 'read'   },
  '/projetos/espelhos':            { resource: 'espelhos',            action: 'read'   },
  '/qualidade/certificados':       { resource: 'certificates',        action: 'read'   },
  '/invoicing':                    { resource: 'invoices',            action: 'read'   },
  '/invoicing/aging':              { resource: 'invoices',            action: 'read'   },
  '/invoicing/integrity':          { resource: 'invoices',            action: 'read'   },
  '/recebimento-materias':         { resource: 'receipts',            action: 'read'   },
  '/CreateCicleAutoClave':         { resource: 'autoclave',           action: 'read'   },
  '/corte':                        { resource: 'cutting_records',     action: 'read'   },
  '/etiquetas':                    { resource: 'etiquetas',           action: 'read'   },
  '/cadastros/fornecedores-placa':         { resource: 'plate_suppliers',         action: 'read' },
  '/recebimento-paineis':                  { resource: 'panel_receipts',          action: 'read' },
  '/cadastros/fornecedores-tecido':        { resource: 'fabric_suppliers',        action: 'read' },
  '/cadastros/materiais':                  { resource: 'materials',               action: 'read' },
  '/cadastros/certificados-conformidade':  { resource: 'conformity_certificates', action: 'read' },
  '/producao/rastreabilidade':             { resource: 'rastreabilidades',        action: 'read' },
  '/producao/config':                      { resource: 'production_config',       action: 'read' },
  '/enfesto':                              { resource: 'workorders',              action: 'read' },
  '/create-ot':                            { resource: 'workorders',              action: 'create' },
  '/audit':                        { resource: 'audit_logs',          action: 'read'   },
  '/audit/cron-runs':              { resource: 'cron_runs',           action: 'read'   },
  '/audit/cron-jobs-manage':       { resource: 'cron_jobs',           action: 'read'   },
  '/users':                        { resource: 'users',               action: 'read'   },
  '/users/acesso':                 { resource: 'user_access',         action: 'manage' },
  '/admin/preferencias':           { resource: 'app_preferences',     action: 'update' },
  '/admin/relatorios':             { resource: 'report_templates',    action: 'read'   },
  '/settings':                     null,
};

// Human-readable descriptions for permission catalog UI tooltips (§15.9).
export const PERMISSION_DESCRIPTIONS = {
  'cutting_projects:read':    'Visualizar projetos de corte',
  'cutting_projects:create':  'Criar novos projetos de corte',
  'cutting_projects:update':  'Editar projetos de corte existentes',
  'cutting_projects:delete':  'Excluir projetos de corte',
  'cutting_projects:clone':   'Clonar projetos de corte',
  'cutting_projects:export':  'Exportar projetos de corte',
  'cutting_plans:read':       'Visualizar planos de corte',
  'cutting_plans:create':     'Criar planos dentro de projetos',
  'cutting_plans:update':     'Editar e salvar planos de corte',
  'cutting_plans:delete':     'Excluir planos de corte',
  'cutting_attachments:read':     'Visualizar anexos de planos',
  'cutting_attachments:upload':   'Fazer upload de anexos (etiquetas, PDF)',
  'cutting_attachments:remove':   'Remover anexos de planos',
  'cutting_attachments:download': 'Baixar arquivos de planos',
  'pcp_orders:read':    'Visualizar ordens de produção',
  'pcp_orders:create':  'Criar ordens de produção',
  'pcp_orders:update':  'Editar ordens de produção',
  'pcp_orders:delete':  'Excluir ordens de produção',
  'pcp_acompanhamento:read': 'Acompanhar status de ordens em tempo real',
  'pcp_reports:read':   'Visualizar relatórios de PCP',
  'pcp_reports:export': 'Exportar relatórios de PCP',
  'espelhos:read':    'Visualizar projetos de espelhos',
  'espelhos:create':  'Criar projetos de espelhos',
  'espelhos:update':  'Editar projetos de espelhos',
  'espelhos:delete':  'Excluir projetos de espelhos',
  'espelhos:export':  'Exportar projetos de espelhos',
  'certificates:read':   'Visualizar certificados de qualidade',
  'certificates:create': 'Criar certificados de qualidade',
  'certificates:update': 'Editar certificados de qualidade',
  'certificates:delete': 'Excluir certificados de qualidade',
  'plate_suppliers:read':   'Visualizar fornecedores de placa',
  'plate_suppliers:create': 'Cadastrar fornecedores de placa',
  'plate_suppliers:update': 'Editar fornecedores de placa',
  'plate_suppliers:delete': 'Excluir fornecedores de placa',
  'panel_receipts:read':     'Visualizar recebimentos de painéis externos',
  'panel_receipts:create':   'Cadastrar recebimentos de painéis externos',
  'panel_receipts:update':   'Editar recebimentos de painéis externos',
  'panel_receipts:delete':   'Excluir recebimentos de painéis externos',
  'panel_receipts:validate': 'Validar saldo de recebimentos (Saldo Ok)',
  'panel_reservations:read':   'Visualizar reservas de saldo de painéis',
  'panel_reservations:create': 'Criar reservas de saldo de painéis',
  'panel_reservations:delete': 'Cancelar reservas de saldo de painéis',
  'panel_consumptions:read':   'Visualizar alocações de consumo em painéis',
  'panel_consumptions:manage': 'Criar/cancelar alocações de consumo em painéis',
  'fabric_suppliers:read':   'Visualizar fornecedores de material balístico',
  'fabric_suppliers:create': 'Cadastrar fornecedores de material balístico',
  'fabric_suppliers:update': 'Editar fornecedores de material balístico',
  'fabric_suppliers:delete': 'Excluir fornecedores de material balístico',
  'materials:read':   'Visualizar materiais',
  'materials:create': 'Cadastrar materiais',
  'materials:update': 'Editar materiais',
  'materials:delete': 'Excluir materiais',
  'conformity_certificates:read':   'Visualizar certificados de conformidade RETEX',
  'conformity_certificates:create': 'Cadastrar certificados de conformidade RETEX',
  'conformity_certificates:update': 'Editar certificados de conformidade RETEX',
  'conformity_certificates:delete': 'Excluir certificados de conformidade RETEX',
  'rastreabilidades:read':   'Visualizar registros de Rastreabilidade e IIS',
  'rastreabilidades:create': 'Emitir novo par Rastreabilidade + IIS',
  'rastreabilidades:update': 'Editar registros de Rastreabilidade e IIS',
  'rastreabilidades:delete': 'Excluir registros de Rastreabilidade e IIS',
  'production_config:read':   'Visualizar configurações fixas da produção (TR, CEP, país, embalagem)',
  'production_config:update': 'Editar configurações fixas da produção',
  'workorders:read':   'Visualizar Enfesto, OTs e placas',
  'workorders:create': 'Criar OTs de Enfesto e suas placas',
  'workorders:update': 'Editar OTs de Enfesto e registrar alterações de camadas',
  'workorders:delete': 'Excluir OTs de Enfesto quando não houver vínculos impeditivos',
  'plates:read':   'Visualizar placas',
  'plates:create': 'Criar placas',
  'plates:update': 'Atualizar placas e status',
  'autoclave:read':     'Visualizar ciclos e pacotes de autoclave',
  'autoclave:create':   'Criar ciclos e pacotes de autoclave',
  'autoclave:update':   'Atualizar ciclos, pacotes e placas vinculadas',
  'autoclave:approve':  'Aprovar ciclos e pacotes de autoclave',
  'autoclave:upload':   'Enviar relatorios de autoclave',
  'autoclave:download': 'Baixar relatorios de autoclave',
  'cutting_records:read':   'Visualizar apontamentos de corte',
  'cutting_records:create': 'Criar apontamentos de corte',
  'cutting_records:update': 'Editar apontamentos de corte',
  'cutting_records:delete': 'Excluir apontamentos de corte',
  'etiquetas:read':     'Visualizar e pré-visualizar etiquetas de corte (ZPL)',
  'etiquetas:print':    'Enviar etiquetas para a impressora',
  'etiquetas:download': 'Baixar arquivos ZPL das etiquetas',
  'invoices:read':     'Visualizar faturamento, notas fiscais e documentos',
  'invoices:create':   'Criar notas fiscais a partir dos apontamentos',
  'invoices:update':   'Editar apontamentos de nota fiscal',
  'invoices:upload':   'Anexar documentos de nota fiscal',
  'invoices:download': 'Baixar documentos de nota fiscal',
  'invoices:approve':  'Executar verificacao de integridade de documentos',
  'receipts:read':   'Visualizar recebimentos',
  'receipts:create': 'Criar recebimentos',
  'receipts:update': 'Editar recebimentos',
  'receipts:delete': 'Excluir recebimentos',
  'audit_logs:read':   'Visualizar logs de auditoria do sistema',
  'audit_logs:export': 'Exportar logs de auditoria',
  'cron_runs:read':    'Visualizar histórico de execução de cron',
  'cron_jobs:read':    'Visualizar tarefas agendadas',
  'cron_jobs:create':  'Criar novas tarefas agendadas',
  'cron_jobs:update':  'Editar tarefas agendadas e suas versões',
  'cron_jobs:delete':  'Excluir tarefas agendadas',
  'cron_jobs:execute': 'Executar tarefas agendadas manualmente (botão ▶)',
  'cron_jobs:promote': 'Promover versão DVP/SAT/REL para OPE (produção)',
  'report_templates:read':    'Visualizar relatórios Jasper e suas versões',
  'report_templates:create':  'Criar relatórios e enviar novos .jrxml',
  'report_templates:update':  'Editar versões (código JS, status, .jrxml)',
  'report_templates:delete':  'Excluir relatórios e versões',
  'report_templates:execute': 'Renderizar/testar relatórios (gera PDF)',
  'report_templates:promote': 'Promover versão DVP/SAT/REL para OPE (produção)',
  'access_audit:read': 'Visualizar auditoria de acessos e permissões',
  'metrics:read':      'Visualizar dashboard e métricas gerais',
  'users:read':    'Visualizar usuários do sistema',
  'users:create':  'Criar novos usuários',
  'users:update':  'Editar usuários existentes (nome, email, senha)',
  'users:delete':  'Desativar (soft delete) usuários',
  'roles:read':    'Visualizar roles e suas permissões',
  'roles:create':  'Criar novas roles customizadas',
  'roles:update':  'Editar permissões de roles existentes',
  'roles:delete':  'Excluir roles customizadas',
  'user_access:manage': 'Atribuir/revogar roles e gerenciar acessos de usuários',
  'app_preferences:update': 'Editar preferências globais da aplicação (flags de comportamento das telas)',
};
