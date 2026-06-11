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
  'dismissed-but-live': ['settle', 'keep'],
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
 * @returns {{safeHeals:object[], resumePending:object[], uncertain:object[], duplicates:object[], clean:boolean}}
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
  const resumePending = [];
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
    } else if (c.status === 'promoted') {
      // clean (even if recorded refs are stale — YAGNI).
    } else if (c.status === 'dismissed') {
      // DISMISSED-BUT-LIVE: the user dismissed the candidate, yet its card is
      // live on the board. Auto-resurrecting would silently reverse deliberate
      // intent; leaving it would drift forever. Ask.
      uncertain.push({
        kind: 'dismissed-but-live', candidateId: cid, title: c.title, refs,
        question: `"${c.title}" was dismissed in the ledger, but its card (#${it.issueNumber}) is live on the board. Settle it as promoted, or keep it dismissed?`,
        options: [...RECONCILE_ACTIONS['dismissed-but-live']],
      });
    } else if (c.promotion && c.promotion.issueNumber != null) {
      // RESUME-PENDING: refs persisted but promote's chain may be unfinished
      // (setStage/setLabels may never have run — the only crash states a board
      // scan can actually observe carry refs). Settling here would foreclose
      // promote's resume and freeze a half-configured card forever. Report it;
      // `promote apply` finishes the chain and settles the status itself.
      resumePending.push({ kind: 'resume-pending', candidateId: cid, title: c.title, refs });
    } else {
      // CRASH-ORPHAN: live marker, NO promotion refs (ledger restored/wiped or
      // hand-edited — unreachable from a real M3a crash, which persists refs
      // before the item can appear on the board). Settling adopts board
      // reality and prevents promote from creating a duplicate for this cid.
      safeHeals.push({ kind: 'crash-orphan', candidateId: cid, title: c.title, refs });
    }
  }

  // Cids already classified above must not double-bucket into dead-source —
  // answering a dead-source question about a safe-heal cid would poison the
  // whole apply (resolveReconcileDecisions rejects decisions on safe heals).
  const markerClassified = new Set([
    ...safeHeals.map((s) => s.candidateId),
    ...resumePending.map((r) => r.candidateId),
    ...uncertain.map((u) => u.candidateId),
  ]);

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
    if (markerClassified.has(c.id)) continue;
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
    safeHeals, resumePending, uncertain, duplicates,
    clean: safeHeals.length === 0 && resumePending.length === 0 && uncertain.length === 0 && duplicates.length === 0,
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
  const resumeIds = new Set(((drift && drift.resumePending) || []).map((r) => r.candidateId));

  for (const [cid, d] of Object.entries(dec)) {
    if (resumeIds.has(cid)) {
      errors.push({ candidateId: cid, error: "resume-pending — run 'promote apply' to finish the chain; reconcile takes no decision here" });
      continue;
    }
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
