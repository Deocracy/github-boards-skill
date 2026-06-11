// scripts/lib/reconcile.mjs — M4a drift classification PURE core.
//
// Three stores can drift: source files, the ledger, the live board. This module
// classifies that drift (classifyDrift) and resolves the human's decisions over
// it (resolveReconcileDecisions), fail-closed. No fs, no network — the caller
// (board-manager's reconcile verbs) passes board items, the ledger, and a
// sourceExists predicate in.
//
// THE HEALING RULE (spec §1): reconcile heals the LEDGER, never the board.
// Safe heals (ledger bookkeeping that mirrors board reality) need no decision;
// judgment-shaped drift goes to `uncertain` with per-kind allowed actions.

import { parseCid } from './promote.mjs';

/** Allowed decision actions per uncertain kind. */
export const RECONCILE_ACTIONS = {
  vanished: ['re-promote', 'dismiss', 'keep'],
  'dead-source': ['dismiss', 'keep'],
};

/** Does this candidate `source` string name a file path (vs 'manual' etc.)? */
function isPathLike(file) {
  return !!file && (file.includes('/') || /\.[A-Za-z0-9]+$/.test(file));
}

/**
 * Classify drift between the ledger and the live board + source files.
 * PURE and read-only.
 *
 * @param {object} args
 * @param {object|null} args.ledger        the M1 ledger (or null)
 * @param {object[]|null} args.items       engine.listItemsWithBodies() items
 *        ({itemId, issueNumber, title, stageLabel, labels, body, issueUrl})
 * @param {(path:string)=>boolean} args.sourceExists  fs existence predicate
 * @returns {{safeHeals:object[], uncertain:object[], duplicates:object[], clean:boolean}}
 */
export function classifyDrift({ ledger, items, sourceExists }) {
  const candidates = (ledger && ledger.candidates) || [];
  const list = items || [];

  // Marker index: cid -> live items carrying it (lowest issueNumber first —
  // the duplicate-resolution order). Markerless items are ignored: reconcile
  // governs only skill-created cards.
  const byCid = new Map();
  for (const it of list) {
    const cid = parseCid(it && it.body);
    if (!cid) continue;
    if (!byCid.has(cid)) byCid.set(cid, []);
    byCid.get(cid).push(it);
  }
  for (const arr of byCid.values()) {
    arr.sort((a, b) => (a.issueNumber ?? Infinity) - (b.issueNumber ?? Infinity));
  }
  const liveIssueNumbers = new Set(list.map((i) => i && i.issueNumber).filter((n) => n != null));
  const candById = new Map(candidates.map((c) => [c.id, c]));

  const safeHeals = [];
  const uncertain = [];
  const duplicates = [];

  // DUPLICATES (report-only): one cid on >= 2 live items.
  for (const [cid, arr] of byCid) {
    if (arr.length >= 2) {
      duplicates.push({ cid, issueNumbers: arr.map((i) => i.issueNumber), kept: arr[0].issueNumber });
    }
  }

  // Marker-driven classes. First (lowest-issueNumber) item wins for healing.
  for (const [cid, arr] of byCid) {
    const it = arr[0];
    const refs = { issueNumber: it.issueNumber ?? null, issueUrl: it.issueUrl ?? null, itemId: it.itemId ?? null };
    const c = candById.get(cid);
    if (!c) {
      // UNKNOWN-MARKER: skill-created card with no ledger record (ledger wiped?).
      safeHeals.push({ kind: 'unknown-marker', candidateId: cid, title: it.title ?? null, refs });
    } else if (c.status !== 'promoted') {
      // CRASH-ORPHAN: the M3a create->persist window (or any unsettled state —
      // incl. 'dismissed': a live card is board reality, and the ledger mirrors it).
      safeHeals.push({ kind: 'crash-orphan', candidateId: cid, title: c.title, refs });
    }
    // promoted + marker live -> clean (even if recorded refs are stale — YAGNI).
  }

  // VANISHED: promoted card-kind candidate with no live presence by marker OR number.
  for (const c of candidates) {
    if (c.status !== 'promoted') continue;
    const num = c.promotion && c.promotion.issueNumber;
    if (num == null) continue; // comment promotions have no issue of their own
    if (byCid.has(c.id) || liveIssueNumbers.has(num)) continue;
    uncertain.push({
      kind: 'vanished', candidateId: c.id, title: c.title,
      refs: { ...c.promotion },
      question: `Card #${num} ("${c.title}") is no longer on the board. Re-promote it, dismiss it, or keep the record as-is?`,
      options: [...RECONCILE_ACTIONS.vanished],
    });
  }

  // DEAD-SOURCE: unsettled candidate whose path-like source file is gone.
  for (const c of candidates) {
    if (!['candidate', 'mapped', 'needs-decision'].includes(c.status)) continue;
    const src = typeof c.source === 'string' ? c.source : '';
    const file = src.split('#')[0].trim();
    if (!isPathLike(file)) continue;
    if (sourceExists(file)) continue;
    uncertain.push({
      kind: 'dead-source', candidateId: c.id, title: c.title, source: c.source,
      question: `Source file ${file} for "${c.title}" no longer exists. Dismiss the candidate or keep it?`,
      options: [...RECONCILE_ACTIONS['dead-source']],
    });
  }

  return {
    safeHeals, uncertain, duplicates,
    clean: safeHeals.length === 0 && uncertain.length === 0 && duplicates.length === 0,
  };
}

/**
 * Resolve the human's decisions over a classifyDrift result, fail-closed
 * (M3a's resolveDecisions idiom). Safe heals are ALWAYS in toApply (action
 * 'settle' for crash-orphans, 'adopt' for unknown-markers). Uncertain items
 * join toApply only with a legal decided action; undecided -> held. A decision
 * naming an unknown cid, an action outside the kind's allowed set, or a
 * safe-heal item -> errors[] (the caller refuses the whole apply).
 *
 * @param {{safeHeals:object[], uncertain:object[]}} drift  classifyDrift output
 * @param {object|null} decisions  { [candidateId]: { action } }
 * @returns {{toApply:object[], held:object[], errors:{candidateId:string,error:string}[]}}
 */
export function resolveReconcileDecisions(drift, decisions) {
  const dec = decisions && typeof decisions === 'object' && !Array.isArray(decisions) ? decisions : {};
  const safeHeals = (drift && drift.safeHeals) || [];
  const uncertain = (drift && drift.uncertain) || [];

  const errors = [];
  const decided = [];
  const uncertainById = new Map(uncertain.map((u) => [u.candidateId, u]));
  const safeIds = new Set(safeHeals.map((s) => s.candidateId));

  for (const [cid, d] of Object.entries(dec)) {
    if (safeIds.has(cid)) {
      errors.push({ candidateId: cid, error: 'safe heals apply automatically — no decision accepted' });
      continue;
    }
    const u = uncertainById.get(cid);
    if (!u) {
      errors.push({ candidateId: cid, error: 'unknown candidateId (not an uncertain item in this scan)' });
      continue;
    }
    const action = d && d.action;
    const allowed = RECONCILE_ACTIONS[u.kind] || [];
    if (!allowed.includes(action)) {
      errors.push({ candidateId: cid, error: `action must be one of ${allowed.join('|')} for ${u.kind}` });
      continue;
    }
    decided.push({ ...u, action });
  }

  const held = uncertain.filter((u) => !Object.prototype.hasOwnProperty.call(dec, u.candidateId));

  const toApply = [
    ...safeHeals.map((s) => ({ ...s, action: s.kind === 'unknown-marker' ? 'adopt' : 'settle' })),
    ...decided,
  ];
  return { toApply, held, errors };
}
