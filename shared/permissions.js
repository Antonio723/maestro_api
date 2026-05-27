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

  // Faturamento
  invoicing:           ['read', 'create', 'update', 'delete'],
  invoicing_aging:     ['read'],
  invoicing_integrity: ['read'],

  // Cadastros
  plate_suppliers: ['read', 'create', 'update', 'delete'],

  // Recebimento de painéis externos (substitui aba "Notas Recebidas" da planilha)
  panel_receipts:     ['read', 'create', 'update', 'delete', 'validate'],
  panel_reservations: ['read', 'create', 'delete'],
  panel_consumptions: ['read', 'manage'],

  // Auditoria
  audit_logs:   ['read', 'export'],
  cron_runs:    ['read'],
  cron_jobs:    ['read', 'create', 'update', 'delete', 'execute', 'promote'],
  access_audit: ['read'],

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
  certificates:        'Certificados de Qualidade',
  invoicing:           'Apontamento de NF',
  invoicing_aging:     'Aging de Faturamento',
  invoicing_integrity: 'Integridade de Documentos',
  plate_suppliers:     'Fornecedores de Placa',
  panel_receipts:      'Recebimento de Painéis',
  panel_reservations:  'Reservas de Painéis',
  panel_consumptions:  'Alocações de Consumo em Painel',
  audit_logs:          'Logs de Auditoria',
  cron_runs:           'Histórico de Cron',
  cron_jobs:           'Cron Jobs',
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
};

// Module = business area grouping a set of resources (pages).
// Used by the permissions tree UI in user management.
// The order here defines the display order in the UI.
export const MODULES = [
  { id: 'projetos',    label: 'Projetos',      resources: ['cutting_projects', 'cutting_plans', 'cutting_attachments', 'espelhos'] },
  { id: 'pcp',         label: 'PCP',           resources: ['pcp_orders', 'pcp_acompanhamento', 'pcp_reports'] },
  { id: 'qualidade',   label: 'Qualidade',     resources: ['certificates'] },
  { id: 'faturamento', label: 'Faturamento',   resources: ['invoicing', 'invoicing_aging', 'invoicing_integrity'] },
  { id: 'cadastros',   label: 'Cadastros',     resources: ['plate_suppliers', 'panel_receipts', 'panel_reservations', 'panel_consumptions'] },
  { id: 'auditoria',   label: 'Auditoria',     resources: ['audit_logs', 'cron_runs', 'cron_jobs', 'access_audit'] },
  { id: 'dashboard',   label: 'Dashboard',     resources: ['metrics'] },
  { id: 'admin',       label: 'Administração', resources: ['users', 'roles', 'user_access', 'app_preferences'] },
];

// Frontend route → minimum permission to enter that page.
// Keys: always with leading '/', never with trailing '/'.
// null = always accessible to any authenticated user.
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
  '/invoicing':                    { resource: 'invoicing',           action: 'read'   },
  '/invoicing/aging':              { resource: 'invoicing_aging',     action: 'read'   },
  '/invoicing/integrity':          { resource: 'invoicing_integrity', action: 'read'   },
  '/cadastros/fornecedores-placa': { resource: 'plate_suppliers',     action: 'read'   },
  '/recebimento-paineis':          { resource: 'panel_receipts',      action: 'read'   },
  '/audit':                        { resource: 'audit_logs',          action: 'read'   },
  '/audit/cron-runs':              { resource: 'cron_runs',           action: 'read'   },
  '/audit/cron-jobs-manage':       { resource: 'cron_jobs',           action: 'read'   },
  '/users':                        { resource: 'users',               action: 'read'   },
  '/users/acesso':                 { resource: 'user_access',         action: 'manage' },
  '/admin/preferencias':           { resource: 'app_preferences',     action: 'update' },
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
  'invoicing:read':   'Visualizar faturamento',
  'invoicing:create': 'Criar lançamentos de faturamento',
  'invoicing:update': 'Editar lançamentos de faturamento',
  'invoicing:delete': 'Excluir lançamentos de faturamento',
  'invoicing_aging:read':     'Visualizar aging de faturamento',
  'invoicing_integrity:read': 'Verificar integridade de NFs',
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
  'audit_logs:read':   'Visualizar logs de auditoria do sistema',
  'audit_logs:export': 'Exportar logs de auditoria',
  'cron_runs:read':    'Visualizar histórico de execução de cron',
  'cron_jobs:read':    'Visualizar tarefas agendadas',
  'cron_jobs:create':  'Criar novas tarefas agendadas',
  'cron_jobs:update':  'Editar tarefas agendadas e suas versões',
  'cron_jobs:delete':  'Excluir tarefas agendadas',
  'cron_jobs:execute': 'Executar tarefas agendadas manualmente (botão ▶)',
  'cron_jobs:promote': 'Promover versão DVP/SAT/REL para OPE (produção)',
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
