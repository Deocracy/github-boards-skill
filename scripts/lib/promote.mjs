// scripts/lib/promote.mjs — M3a promotion PURE core.
//
// Classifies mapped/needs-decision ledger candidates into promotion buckets,
// resolves pre-gathered human decisions, and stamps/parses the durable
// candidateId body marker. No network, no board, no ledger I/O — board-manager's
// `promote` verb owns those side effects.

import { resolveRules } from './mapper.mjs';

// candidateId (and splitChildId) are always 12 lowercase-hex chars.
const MARKER_RE = /<!--\s*gboards:cid=([0-9a-f]{12})\s*-->/;

/**
 * The durable external-id marker stamped into a promoted issue's body.
 * @param {string} cid  a 12-hex candidateId
 * @returns {string}
 */
export function cidMarker(cid) {
  return `<!-- gboards:cid=${cid} -->`;
}

/**
 * Extract the candidateId from an issue body, or null if absent.
 * @param {string} body
 * @returns {string|null}
 */
export function parseCid(body) {
  const m = MARKER_RE.exec(String(body || ''));
  return m ? m[1] : null;
}

/**
 * Classify ledger candidates into promotion buckets. PURE + read-only.
 * @param {object} ledger  the M1/M2 ledger ({candidates:[...]})
 * @param {object} config  board config (needs stageOptions [+ optional rules])
 * @returns {{confident:object[], uncertain:object[], comments:object[], skipped:object[], allowedLanes:string[], owners:string[]}}
 */
export function classify(ledger, config) {
  const threshold = resolveRules(config).promoteConfidenceBelow;
  const allowedLanes = Object.keys((config && config.stageOptions) || {});
  const confident = [], uncertain = [], comments = [], skipped = [];

  for (const c of ((ledger && ledger.candidates) || [])) {
    const conf = typeof c.confidence === 'number' ? c.confidence : 0;

    if (c.status === 'promoted' || c.status === 'dismissed' || c.status === 'merged' || c.status === 'split') {
      skipped.push({ candidateId: c.id, reason: c.status });
      continue;
    }
    if (c.status === 'needs-decision') {
      uncertain.push({
        candidateId: c.id, kind: 'card', title: c.title,
        lane: c.suggestedLane ?? null, owner: c.suggestedOwner ?? null, confidence: conf,
        reason: 'needs-decision',
        question: (c.needsDecision && c.needsDecision.question) || `Promote "${c.title}"?`,
        options: (c.needsDecision && c.needsDecision.options) || [],
      });
      continue;
    }
    if (c.status !== 'mapped') {
      skipped.push({ candidateId: c.id, reason: c.status === 'candidate' ? 'not-mapped' : `unknown-status:${c.status}` });
      continue;
    }

    // status === 'mapped'
    if (c.kind === 'comment') {
      const item = { candidateId: c.id, kind: 'comment', title: c.title, commentTarget: c.commentTarget, text: c.note || c.title, confidence: conf };
      if (conf >= threshold) comments.push(item);
      else uncertain.push({ ...item, reason: 'low-confidence', question: `Add comment to #${c.commentTarget}: "${c.title}"?`, options: [] });
      continue;
    }
    const item = { candidateId: c.id, kind: 'card', title: c.title, lane: c.suggestedLane ?? null, owner: c.suggestedOwner ?? null, confidence: conf };
    if (conf >= threshold) confident.push(item);
    else uncertain.push({ ...item, reason: 'low-confidence', question: `Promote "${c.title}" → ${item.lane} (${item.owner})?`, options: allowedLanes });
  }
  return { confident, uncertain, comments, skipped, allowedLanes, owners: ['agent', 'human'] };
}

/**
 * Resolve pre-gathered human decisions against a classify() plan. PURE.
 * commit set = confident + comments (auto) + uncertain where action='promote'.
 * Fail-closed: unknown candidateId, bad action, invalid lane/owner override, or a
 * card with no resolvable lane -> errors (the verb refuses the whole run).
 * @param {object} plan      classify() output
 * @param {object} decisions { [candidateId]: { action:'promote'|'hold', lane?, owner? } }
 * @returns {{toCommit:object[], held:object[], errors:object[]}}
 */
export function resolveDecisions(plan, decisions) {
  const dec = decisions || {};
  const uncertainById = new Map((plan.uncertain || []).map((u) => [u.candidateId, u]));
  const allowed = new Set(plan.allowedLanes || []);
  const errors = [];
  const poisoned = new Set();

  // Validate every decision key references a real uncertain item with a legal payload.
  for (const cid of Object.keys(dec)) {
    const d = dec[cid] || {};
    if (!uncertainById.has(cid)) { errors.push({ candidateId: cid, error: 'no uncertain item with this candidateId' }); poisoned.add(cid); continue; }
    if (d.action !== 'promote' && d.action !== 'hold') { errors.push({ candidateId: cid, error: `action '${d.action}' must be promote|hold` }); poisoned.add(cid); continue; }
    if (d.lane != null && !allowed.has(d.lane)) { errors.push({ candidateId: cid, error: `lane override '${d.lane}' not in allowed lanes` }); poisoned.add(cid); continue; }
    if (d.owner != null && d.owner !== 'agent' && d.owner !== 'human') { errors.push({ candidateId: cid, error: `owner override '${d.owner}' must be agent|human` }); poisoned.add(cid); continue; }
  }

  const toCommit = [...(plan.confident || []), ...(plan.comments || [])];
  const held = [];
  for (const u of (plan.uncertain || [])) {
    const d = dec[u.candidateId];
    if (poisoned.has(u.candidateId)) { held.push(u); continue; }
    if (!d || d.action === 'hold') { held.push(u); continue; }
    if (d.action !== 'promote') continue; // invalid action already recorded as an error
    const merged = { ...u, lane: d.lane ?? u.lane, owner: d.owner ?? u.owner };
    delete merged.reason; delete merged.question; delete merged.options;
    if (merged.kind === 'card' && !merged.lane) {
      errors.push({ candidateId: u.candidateId, error: 'promote requires a lane (none mapped — supply one in the decision)' });
      continue;
    }
    toCommit.push(merged);
  }
  return { toCommit, held, errors };
}
