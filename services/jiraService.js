import axios from 'axios';
import { decrypt } from '../utils/crypto.js';
import pool from '../config/database.js';

const CACHE_TTL_MS = 10_000; // 10 seconds

/**
 * In-memory cache keyed by string (userId or `userId:material`).
 * @type {Map<string, { data: JiraCard[], fetchedAt: number }>}
 */
const cache    = new Map();

/**
 * In-flight requests: prevents thundering-herd when multiple callers
 * hit an expired cache key simultaneously — they all await the same Promise.
 * @type {Map<string, Promise<JiraCard[]>>}
 */
const inFlight = new Map();

const JQL_ARAMIDA =
  `project = MANTA AND "fábrica de manta[dropdown]" = "CARBON OPACO" ` +
  `AND status IN ("A Produzir", "🔴RECEBIDO NÃO LIBERADO")`;

const JQL_TENSYLON =
  `project = TENSYLON AND status IN ("A Produzir", "🔴RECEBIDO NÃO LIBERADO")`;

const JQL_COMBINED = `(${JQL_ARAMIDA}) OR (${JQL_TENSYLON})`;

/**
 * Retrieve and decrypt a user's Jira credentials from the database.
 * Throws a descriptive error if the token is missing or cannot be decrypted.
 * @param {number} userId
 * @returns {Promise<{ email: string, apiToken: string }>}
 */
async function getCredentials(userId) {
  const { rows } = await pool.query(
    'SELECT email, api_token FROM maestro.users WHERE id = $1',
    [userId]
  );

  if (!rows.length) throw new Error('Usuário não encontrado');

  const { email, api_token } = rows[0];

  if (!email || !api_token) {
    throw new Error('Credenciais Jira não configuradas para este usuário — acesse Configurações e salve o token');
  }

  const apiToken = decrypt(api_token);
  if (!apiToken) {
    throw new Error('Falha ao decifrar token Jira — reconfigure o token em Configurações');
  }

  return { email, apiToken };
}

/**
 * Internal: executes the Jira API call and populates the cache.
 * Never called directly — always go through fetchByJql.
 */
async function _doFetch(userId, jql, cacheKey) {
  const jiraUrl = process.env.JIRA_URL;
  if (!jiraUrl) {
    console.warn('[JiraService] JIRA_URL not set — returning empty list');
    return [];
  }

  const { email, apiToken } = await getCredentials(userId);
  const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  const fieldsStr = 'summary,status,customfield_11298,customfield_10245,customfield_11353';
  const allRaw    = [];
  let nextPageToken = null;

  do {
    const params = { jql, maxResults: 100, fields: fieldsStr };
    if (nextPageToken) params.nextPageToken = nextPageToken;

    const resp = await axios.get(`${jiraUrl}/rest/api/3/search/jql`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
      params,
      timeout: 20_000,
    });

    allRaw.push(...(resp.data.issues || []));
    nextPageToken = resp.data.isLast ? null : (resp.data.nextPageToken ?? null);
  } while (nextPageToken);

  const normalized = allRaw.map(normalizeIssue);
  cache.set(cacheKey, { data: normalized, fetchedAt: Date.now() });
  console.log(`[JiraService] fetched ${normalized.length} issues for "${cacheKey}"`);
  return normalized;
}

/**
 * Core fetcher: serves from cache when fresh; deduplicates concurrent
 * requests that arrive while the cache is stale (thundering-herd guard).
 *
 * @param {number} userId
 * @param {string} jql
 * @param {string} cacheKey
 * @returns {Promise<JiraCard[]>}
 */
async function fetchByJql(userId, jql, cacheKey) {
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(`[JiraService] cache hit for "${cacheKey}" (${cached.data.length} issues)`);
    return cached.data;
  }

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const promise = _doFetch(userId, jql, cacheKey).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, promise);
  return promise;
}

/**
 * Fetch open OS from both MANTA (Aramida) and TENSYLON boards.
 * @param {number} userId
 * @returns {Promise<JiraCard[]>}
 */
export async function fetchJiraIssues(userId) {
  return fetchByJql(userId, JQL_COMBINED, String(userId));
}

/**
 * Fetch open OS from the MANTA (Aramida) board only.
 * @param {number} userId
 * @returns {Promise<JiraCard[]>}
 */
export async function fetchAramidaIssues(userId) {
  return fetchByJql(userId, JQL_ARAMIDA, `${userId}:aramida`);
}

/**
 * Fetch open OS from the TENSYLON board only.
 * @param {number} userId
 * @returns {Promise<JiraCard[]>}
 */
export async function fetchTensylonIssues(userId) {
  return fetchByJql(userId, JQL_TENSYLON, `${userId}:tensylon`);
}

/**
 * Attach a PDF file to a Jira issue as an attachment.
 * Jira requires multipart/form-data with the X-Atlassian-Token: no-check header.
 *
 * @param {number} userId
 * @param {string} issueKey  - e.g. "MANTA-31516"
 * @param {string} filename  - e.g. "OS-31830.pdf"
 * @param {Buffer} pdfBuffer - raw PDF bytes
 * @returns {Promise<void>}
 */
export async function attachToJiraIssue(userId, issueKey, filename, pdfBuffer) {
  const jiraUrl = process.env.JIRA_URL;
  if (!jiraUrl) throw new Error('JIRA_URL não configurado');

  const { email, apiToken } = await getCredentials(userId);
  const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  const formData = new FormData();
  formData.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), filename);

  const resp = await axios.post(`${jiraUrl}/rest/api/3/issue/${issueKey}/attachments`, formData, {
    headers: {
      Authorization: authHeader,
      'X-Atlassian-Token': 'no-check',
    },
    timeout: 30_000,
  });
  return (resp.data || []).map(a => a.id).filter(Boolean);
}

/**
 * Delete a Jira attachment by ID (used for rollback on partial failure).
 * @param {number} userId
 * @param {string|number} attachmentId
 * @returns {Promise<void>}
 */
export async function deleteJiraAttachment(userId, attachmentId) {
  const jiraUrl = process.env.JIRA_URL;
  if (!jiraUrl) throw new Error('JIRA_URL não configurado');

  const { email, apiToken } = await getCredentials(userId);
  const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  await axios.delete(`${jiraUrl}/rest/api/3/attachment/${attachmentId}`, {
    headers: { Authorization: authHeader },
    timeout: 15_000,
  });
}

/**
 * Update specific fields on a Jira issue (e.g. custom number fields).
 *
 * @param {number} userId
 * @param {string} issueKey  - e.g. "MANTA-31516"
 * @param {Object} fields    - key/value map of Jira field IDs to values
 * @returns {Promise<void>}
 */
export async function updateJiraIssueFields(userId, issueKey, fields) {
  const jiraUrl = process.env.JIRA_URL;
  if (!jiraUrl) throw new Error('JIRA_URL não configurado');

  const { email, apiToken } = await getCredentials(userId);
  const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  await axios.put(`${jiraUrl}/rest/api/3/issue/${issueKey}`, { fields }, {
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 15_000,
  });
}

/**
 * Fetch all fields defined in the Jira instance.
 * Useful for discovering the correct customfield_XXXXX IDs.
 *
 * @param {number} userId
 * @returns {Promise<Array<{id:string, name:string, type:string, custom:boolean}>>}
 */
export async function fetchJiraFields(userId) {
  const jiraUrl = process.env.JIRA_URL;
  if (!jiraUrl) throw new Error('JIRA_URL não configurado');

  const { email, apiToken } = await getCredentials(userId);
  const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  const resp = await axios.get(`${jiraUrl}/rest/api/3/field`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
    timeout: 15_000,
  });

  return (resp.data || []).map(f => ({
    id:     f.id,
    name:   f.name,
    type:   f.schema?.type || '',
    custom: !!f.custom,
  }));
}

/**
 * Transition a Jira issue to a target status via the transitions API.
 * Only transitions if the current status matches sourceStatus.
 * Returns silently (no throw) when the card is already at the target
 * or in an unexpected source status — callers decide whether to treat
 * those cases as errors.
 *
 * @param {number} userId
 * @param {string} issueKey     - e.g. "MANTA-31516"
 * @param {string} targetStatus - e.g. "Liberado Engenharia"
 * @param {string} sourceStatus - only transition when current status matches this
 * @returns {Promise<{ changed: boolean, from: string, to: string, reason: string }>}
 */
export async function transitionJiraIssue(userId, issueKey, targetStatus, sourceStatus) {
  const jiraUrl = process.env.JIRA_URL;
  if (!jiraUrl) throw new Error('JIRA_URL não configurado');

  const { email, apiToken } = await getCredentials(userId);
  const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  const issueResp = await axios.get(
    `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`,
    { headers: { Authorization: authHeader, Accept: 'application/json' }, timeout: 15_000 }
  );

  const currentStatus = String(issueResp.data?.fields?.status?.name || '').trim();

  if (currentStatus.toLowerCase() === targetStatus.toLowerCase()) {
    return { changed: false, from: currentStatus, to: currentStatus, reason: 'already-in-target' };
  }

  if (currentStatus.toLowerCase() !== sourceStatus.toLowerCase()) {
    return { changed: false, from: currentStatus, to: currentStatus, reason: 'unexpected-source-status' };
  }

  const transitionsUrl = `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;
  const transResp = await axios.get(transitionsUrl, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
    timeout: 15_000,
  });

  const transitions = transResp.data.transitions || [];
  const target = transitions.find(
    t => String(t?.to?.name || '').trim().toLowerCase() === targetStatus.toLowerCase()
  ) || transitions.find(
    t => String(t?.name || '').trim().toLowerCase() === targetStatus.toLowerCase()
  );

  if (!target) {
    throw new Error(`Transição "${targetStatus}" não disponível para o card ${issueKey}`);
  }

  await axios.post(
    transitionsUrl,
    { transition: { id: target.id } },
    { headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15_000 }
  );

  return { changed: true, from: currentStatus, to: targetStatus, reason: 'transitioned' };
}

/**
 * Force-expire all cache entries for a user (e.g. after token update).
 * @param {number} userId
 */
export function invalidateCache(userId) {
  cache.delete(String(userId));
  cache.delete(`${userId}:aramida`);
  cache.delete(`${userId}:tensylon`);
}

/**
 * Normalize a raw Jira issue into a flat JiraCard object.
 * @param {Object} issue
 * @returns {JiraCard}
 */
function normalizeIssue(issue) {
  const f = issue.fields;

  // Extract numeroProjeto from custom field 11353 (dropdown or plain text)
  let numeroProjeto = '';
  const npRaw = f.customfield_11353;
  if (npRaw && typeof npRaw === 'object' && npRaw.value) {
    numeroProjeto = String(npRaw.value).trim().toUpperCase();
  } else if (npRaw) {
    numeroProjeto = String(npRaw).trim().toUpperCase();
  }

  // Fallback: extract project-code pattern from summary (e.g. "AB-1234")
  if (!numeroProjeto) {
    const m = String(f.summary || '').match(/\b([A-Z]{2,}-\d+)\b/);
    if (m) numeroProjeto = m[0].toUpperCase();
  }

  // OS number: last long numeric sequence found in the summary
  const osMatches = String(f.summary || '').match(/\b(\d{4,10})\b/g);

  // Determine material from Jira project key prefix
  const isTensylonCard = String(issue.key).toUpperCase().startsWith('TENSYLON');

  return {
    jiraKey: issue.key,
    numeroProjeto,
    resumo: String(f.summary || ''),
    veiculo: String(f.customfield_11298 || ''),
    previsao: String(f.customfield_10245 || ''),
    osNumber: osMatches ? osMatches[osMatches.length - 1] : '',
    isTensylonCard,
    status: String(f.status?.name || ''),
  };
}

/**
 * @typedef {Object} JiraCard
 * @property {string} jiraKey        - e.g. "MANTA-123" or "TENSYLON-456"
 * @property {string} numeroProjeto  - normalized project code in UPPERCASE
 * @property {string} resumo         - Jira issue summary
 * @property {string} veiculo        - vehicle name (customfield_11298)
 * @property {string} previsao       - forecast date (customfield_10245)
 * @property {string} osNumber       - extracted OS number from summary
 * @property {boolean} isTensylonCard - true when this card is from the TENSYLON Jira project
 */
