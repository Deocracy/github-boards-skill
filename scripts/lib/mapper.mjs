// scripts/lib/mapper.mjs — the M2 mapper's PURE core.
//
// The mapper itself is the LLM; this module is the deterministic harness that
// (a) prepares the LLM's input packet and (b) validates + applies the LLM's
// proposals back onto the ledger, fail-closed. No network, no board.

import { createHash } from 'node:crypto';

const DEFAULT_RULES = {
  maxLanes: 8,
  useTags: false,
  defaultOwner: 'human',
  granularity: 'fine',
  escalateConfidenceBelow: 0.6,
  escalateBatchOver: 12,
  promoteConfidenceBelow: 0.8,
};

/**
 * Merge a board.json `rules` block over the defaults. A missing/!object rules
 * value yields the defaults (back-compat with M1 configs).
 * @param {object|null} config
 * @returns {object} resolved rules
 */
export function resolveRules(config) {
  const raw = config && config.rules;
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { ...DEFAULT_RULES, ...r };
}

/**
 * Build the input packet handed to the LLM mapper. Includes only unmapped
 * candidates (status === 'candidate'), the allowed lanes/owners, the resolved
 * rules, and the optional live-session snapshot.
 * @param {object|null} ledger  the M1 ledger object (or null)
 * @param {object} config       the board config (needs stageOptions [+ optional rules])
 * @param {string|null} session a freeform live-session-work summary, or null
 * @returns {object} the mapper input packet
 */
export function prepareInput(ledger, config, session = null) {
  const allowedLanes = Object.keys((config && config.stageOptions) || {});
  const candidates = ((ledger && ledger.candidates) || [])
    .filter((c) => c.status === 'candidate')
    .map((c) => ({ candidateId: c.id, title: c.title, note: c.note || '', source: c.source || 'unknown' }));
  return {
    candidates,
    allowedLanes,
    allowedOwners: ['agent', 'human'],
    defaultLane: allowedLanes[0] ?? null,
    rules: resolveRules(config),
    session: session || null,
  };
}

/**
 * Fail-closed validation of a single proposal against the board config + rules.
 * Per-proposal only; the cross-proposal maxLanes cap is enforced in applyProposals.
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateProposal(p, config, rules) {
  const errors = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['proposal is not an object'] };
  const allowed = new Set(Object.keys((config && config.stageOptions) || {}));

  if (!p.candidateId) errors.push('missing candidateId');
  if (!['card', 'comment', 'skip'].includes(p.kind)) errors.push(`invalid kind '${p.kind}' (card|comment|skip)`);
  if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1) errors.push('confidence must be a number 0..1');

  if (p.kind === 'card' && !p.split) {
    if (!p.lane || !allowed.has(p.lane)) errors.push(`lane '${p.lane}' not in allowed lanes [${[...allowed].join(', ')}]`);
    if (!['agent', 'human'].includes(p.owner)) errors.push(`owner '${p.owner}' must be agent|human`);
  }
  if (p.kind === 'comment') {
    if (!Number.isInteger(p.commentTarget)) errors.push('comment requires an integer commentTarget');
  }
  if (p.split != null) {
    if (!Array.isArray(p.split) || p.split.length < 2) {
      errors.push('split must be an array of 2+ children');
    } else {
      for (const ch of p.split) {
        if (!ch || !ch.lane || !allowed.has(ch.lane)) errors.push(`split child lane '${ch && ch.lane}' not in allowed lanes`);
        if (!ch || !['agent', 'human'].includes(ch.owner)) errors.push(`split child owner '${ch && ch.owner}' must be agent|human`);
      }
    }
  }
  // Mutually-exclusive intents: at most one disposition; skip/comment carry none.
  // (Prevents a contradictory proposal from silently resolving by branch order.)
  if ((p.kind === 'skip' || p.kind === 'comment') && (p.split != null || p.mergeWith != null || p.needsDecision != null)) {
    errors.push(`kind '${p.kind}' cannot combine with split/mergeWith/needsDecision`);
  }
  const dispositions = ['split', 'mergeWith', 'needsDecision'].filter((k) => p[k] != null);
  if (dispositions.length > 1) errors.push(`only one of split/mergeWith/needsDecision may be set (got ${dispositions.join(', ')})`);
  return { ok: errors.length === 0, errors };
}

function splitChildId(parentId, index, title) {
  // index-salted so two children of the same parent can never collide, while
  // re-running the same split (same parent, same order) stays deterministic.
  return createHash('sha256').update(parentId + '::' + index + '::' + String(title).trim().toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * Apply validated proposals to a COPY of the ledger (pure — returns the new
 * ledger, never mutates the input). Fail-closed: invalid proposals, unknown or
 * settled candidates, and a batch exceeding maxLanes are rejected (not written)
 * and reported. Returns { ledger, report, questions }.
 */
export function applyProposals(ledger, proposals, config) {
  const rules = resolveRules(config);
  const out = JSON.parse(JSON.stringify(ledger || { candidates: [] }));
  if (!Array.isArray(out.candidates)) out.candidates = [];
  const byId = new Map(out.candidates.map((c) => [c.id, c]));
  const report = { mapped: [], comments: [], skipped: [], merged: [], split: [], needsDecision: [], rejected: [] };
  const questions = [];

  // Pass 1 — validate + filter to actionable proposals.
  const actionable = [];
  for (const p of (proposals || [])) {
    const v = validateProposal(p, config, rules);
    if (!v.ok) { report.rejected.push({ candidateId: p && p.candidateId ? p.candidateId : null, errors: v.errors }); continue; }
    const cand = byId.get(p.candidateId);
    if (!cand) { report.rejected.push({ candidateId: p.candidateId, errors: ['candidateId not present in ledger'] }); continue; }
    if (cand.status !== 'candidate') { report.rejected.push({ candidateId: p.candidateId, errors: [`candidate status '${cand.status}' is already settled`] }); continue; }
    actionable.push(p);
  }

  // Cross-proposal maxLanes cap (count distinct lanes used by cards + split children).
  const lanes = new Set();
  for (const p of actionable) {
    if (p.kind === 'card' && !p.split && p.lane) lanes.add(p.lane);
    if (Array.isArray(p.split)) for (const ch of p.split) lanes.add(ch.lane);
  }
  if (lanes.size > rules.maxLanes) {
    report.rejected.push({ candidateId: null, errors: [`batch uses ${lanes.size} distinct lanes > maxLanes ${rules.maxLanes}`] });
    return { ledger: out, report, questions }; // fail closed — write nothing
  }

  // Pass 2 — apply.
  for (const p of actionable) {
    const cand = byId.get(p.candidateId);
    if (p.needsDecision) {
      cand.status = 'needs-decision';
      cand.needsDecision = p.needsDecision;
      report.needsDecision.push({ candidateId: p.candidateId, question: p.needsDecision.question });
      questions.push({ candidateId: p.candidateId, question: p.needsDecision.question, options: p.needsDecision.options || [] });
      continue;
    }
    if (p.mergeWith) {
      cand.status = 'merged';
      cand.mergedInto = p.mergeWith;
      report.merged.push({ candidateId: p.candidateId, into: p.mergeWith });
      continue;
    }
    if (Array.isArray(p.split)) {
      cand.status = 'split';
      const childIds = [];
      for (let ci = 0; ci < p.split.length; ci++) {
        const ch = p.split[ci];
        const id = splitChildId(p.candidateId, ci, ch.title);
        childIds.push(id);
        if (!byId.has(id)) {
          const child = { id, title: ch.title, note: '', source: cand.source, suggestedLane: ch.lane, suggestedOwner: ch.owner, kind: 'card', confidence: p.confidence, parent: p.candidateId, addedAt: cand.addedAt, status: 'mapped' };
          out.candidates.push(child);
          byId.set(id, child);
        }
      }
      cand.splitInto = childIds;
      report.split.push({ candidateId: p.candidateId, into: childIds });
      continue;
    }
    if (p.kind === 'skip') {
      cand.status = 'dismissed';
      report.skipped.push({ candidateId: p.candidateId });
      continue;
    }
    if (p.kind === 'comment') {
      cand.status = 'mapped';
      cand.kind = 'comment';
      cand.commentTarget = p.commentTarget;
      cand.suggestedOwner = null;
      cand.confidence = p.confidence;
      cand.rationale = p.rationale || '';
      report.comments.push({ candidateId: p.candidateId, target: p.commentTarget });
      continue;
    }
    // plain card
    cand.status = 'mapped';
    cand.kind = 'card';
    cand.suggestedLane = p.lane;
    cand.suggestedOwner = p.owner;
    cand.title = p.title || cand.title;
    cand.confidence = p.confidence;
    cand.rationale = p.rationale || '';
    report.mapped.push({ candidateId: p.candidateId, lane: p.lane, owner: p.owner });
  }
  return { ledger: out, report, questions };
}
