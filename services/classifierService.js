import { parseDimension, filterPlansByDimension } from '../utils/dimensionMatcher.js';
import { validatePlans } from '../utils/reviewValidator.js';

// Issues that block a project from being "ready" for OS generation.
// Pending review issues (NO_LABELING, NO_KI_LAYOUT, etc.) are non-blocking:
// they appear as tags on the ReadyCard but don't prevent OS generation.
const BLOCKING_ISSUES = new Set([
  'NO_ATTACHMENT',
  'NO_CUTTING',
  'NO_LABEL_8C',
  'NO_LABEL_9C',
  'NO_LABEL_11C',
  'NO_LABEL_TENSYLON',
]);

function isBlocked(issues) {
  return issues.some(code => BLOCKING_ISSUES.has(code));
}

/**
 * Determine whether a DB project is Tensylon.
 * material_type is the authoritative source; project code is the fallback.
 *
 * @param {import('./mirrorProjectRepository.js').DbProject} project
 * @returns {boolean}
 */
function isTensylonProject(project) {
  const mt = String(project.material_type || '').trim().toUpperCase();
  if (mt) return mt === 'TENSYLON';
  return String(project.project || '').toUpperCase().includes('TENSYLON');
}

/**
 * Build a lookup map from normalized project code → DB project.
 *
 * @param {import('./mirrorProjectRepository.js').DbProject[]} dbProjects
 * @returns {Map<string, import('./mirrorProjectRepository.js').DbProject>}
 */
function buildProjectMap(dbProjects) {
  const map = new Map();
  for (const p of dbProjects) {
    if (!p.project) continue;
    map.set(String(p.project).trim().toUpperCase(), p);
  }
  return map;
}

/**
 * Merge a DB project's fields with the matching Jira card's fields.
 * cutting_plans is included so ReadyCard can display dimensions.
 *
 * @param {import('./mirrorProjectRepository.js').DbProject} dbProject
 * @param {import('./jiraService.js').JiraCard} card
 * @param {import('./mirrorProjectRepository.js').DbCuttingPlan[]} [plansOverride]
 *   When provided, replaces cutting_plans in the response (used to put
 *   dimension-matched plans first so ReadyCard.firstPlan shows the right size).
 * @returns {Object}
 */
function mergeItem(dbProject, card, plansOverride) {
  return {
    id:              dbProject.id,
    project:         dbProject.project,
    material_type:   dbProject.material_type,
    brand:           dbProject.brand,
    model:           dbProject.model,
    roof_config:     dbProject.roof_config,
    total_parts_qty: dbProject.total_parts_qty,
    lid_parts_qty:   dbProject.lid_parts_qty,
    cutting_plans:   plansOverride ?? (dbProject.cutting_plans || []),
    jiraKey:         card.jiraKey,
    osNumber:        card.osNumber,
    veiculo:         card.veiculo,
    numeroProjeto:   card.numeroProjeto,
    status:          card.status || '',
  };
}

/**
 * Classify all Jira cards against internal DB projects for a given
 * dimension filter and material tab.
 *
 * Classification rules
 * ─────────────────────────────────────────────────────────────────
 * MISSING      No DB project found for card.numeroProjeto.
 *
 * noDimension  DB project found, but it has NO cutting_plan whose
 *              plate dimensions match the selected filter (Aramida only).
 *
 * PENDING      Matching plan(s) found, but at least one blocking issue:
 *              NO_ATTACHMENT | NO_CUTTING | NO_LABEL_8C | NO_LABEL_9C | NO_LABEL_11C | NO_LABEL_TENSYLON.
 *
 * READY        Matching plan(s) found, no blocking issues.
 *              Non-blocking issues (NO_LABELING, NO_KI_LAYOUT, NO_NESTING_REPORT,
 *              NO_FOLDER_TEMPLATE) are still surfaced as tags on the card.
 *
 * Tensylon:    Dimension filter is skipped entirely.  All plans are
 *              validated together; cards without a DB match go to missing.
 *
 * Material tab: Cards from the wrong Jira project (MANTA vs TENSYLON) are
 * skipped.  DB projects whose material_type conflicts with the tab are also
 * skipped — prevents cross-contamination when numeroProjeto collides.
 *
 * @param {import('./jiraService.js').JiraCard[]}            jiraCards
 * @param {import('./mirrorProjectRepository.js').DbProject[]} dbProjects
 * @param {string}  dimensionStr - e.g. "1.60x3.00" (ignored for Tensylon tab)
 * @param {string}  material     - "aramida" | "tensylon"
 * @returns {{
 *   ready:       Object[],
 *   pending:     Object[],
 *   missing:     Object[],
 *   noDimension: Object[],
 *   meta: { totalJira: number, dimension: string|null, material: string }
 * }}
 */
export function classifyAll(jiraCards, dbProjects, dimensionStr, material) {
  const isTensylonTab = String(material || '').toLowerCase() === 'tensylon';
  const targetDim     = isTensylonTab ? null : parseDimension(dimensionStr);
  const dbMap         = buildProjectMap(dbProjects);

  const ready       = [];
  const pending     = [];
  const missing     = [];
  const noDimension = [];

  for (const card of jiraCards) {
    // ── 1. Material tab filter ───────────────────────────────────────────────
    if (card.isTensylonCard !== isTensylonTab) continue;

    // ── 2. Skip cards without a usable project code ──────────────────────────
    const np = String(card.numeroProjeto || '').trim().toUpperCase();
    if (!np || np === '-') continue;

    // ── 3. Look up DB project ────────────────────────────────────────────────
    const dbProject = dbMap.get(np);
    if (!dbProject) {
      missing.push({
        jiraKey:       card.jiraKey,
        key:           card.jiraKey, // kept for backward compat with MissingCard
        numeroProjeto: card.numeroProjeto,
        resumo:        card.resumo,
        veiculo:       card.veiculo,
        osNumber:      card.osNumber,
        status:        card.status || '',
      });
      continue;
    }

    // ── 4. Guard: DB project material must match the active tab ──────────────
    //    Prevents misclassification when two Jira projects share a code.
    if (isTensylonProject(dbProject) !== isTensylonTab) continue;

    const allPlans = dbProject.cutting_plans || [];

    // ── 5a. Tensylon path — no dimension filter ──────────────────────────────
    if (isTensylonTab) {
      const issues  = validatePlans(allPlans);
      const enriched = mergeItem(dbProject, card);
      if (!isBlocked(issues)) {
        ready.push({ ...enriched, issues: issues.length ? issues : [] });
      } else {
        pending.push({ ...enriched, issues });
      }
      continue;
    }

    // ── 5b. Aramida path — apply dimension filter ────────────────────────────
    if (!targetDim) continue; // dimension string unparseable — skip card

    const matchedPlans = filterPlansByDimension(allPlans, targetDim);

    if (matchedPlans.length === 0) {
      // Project exists but has no plan for this dimension.
      noDimension.push(mergeItem(dbProject, card));
      continue;
    }

    // Validate ONLY the plans that match the requested dimension.
    // Plans from other dimensions never contribute issues here.
    const issues = validatePlans(matchedPlans);

    // Put matched plans first so ReadyCard.firstPlan shows the correct size.
    const reorderedPlans = [
      ...matchedPlans,
      ...allPlans.filter(p => !matchedPlans.includes(p)),
    ];
    const enriched = mergeItem(dbProject, card, reorderedPlans);

    if (!isBlocked(issues)) {
      ready.push({ ...enriched, issues: issues.length ? issues : [] });
    } else {
      pending.push({ ...enriched, issues });
    }
  }

  return {
    ready,
    pending,
    missing,
    noDimension,
    meta: {
      totalJira: jiraCards.length,
      dimension: isTensylonTab ? null : (dimensionStr || null),
      material,
    },
  };
}
