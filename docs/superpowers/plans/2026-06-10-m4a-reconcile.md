# M4a Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read back the keys M3a/M3b planted (cid markers, source provenance), classify drift between source files / ledger / board into four classes, and heal it with ledger-only writes behind the established scan→decide→apply gate.

**Architecture:** Pure core `lib/reconcile.mjs` (`classifyDrift`, `resolveReconcileDecisions` — no fs, no network); ONE new live read (`listItems` gains a `withBodies` option exposed through the DI contract as `engine.listItemsWithBodies()`); `reconcileScan`/`reconcileApply` verbs in board-manager (apply writes ONLY the ledger — board mutations stay promote's job); CLI `reconcile <scan|apply> [--decisions <file>]` on the loadConfig path (reconcile needs a configured board).

**Tech Stack:** Node ≥18 (ESM), `node:test`, no third-party deps.

**Spec:** [docs/superpowers/specs/2026-06-10-m4a-reconcile-design.md](../specs/2026-06-10-m4a-reconcile-design.md)

---

## ⚠️ SAFETY DIRECTIVE (applies to EVERY task, EVERY role: implementer, spec-reviewer, quality-reviewer, fixer)

- **NEVER set or export `GBS_LIVE=1`. NEVER run any live/integration test.** Task 8's live smoke is **operator-gated: written, never executed** in automated/subagent runs (it reads a real GitHub board).
- NEVER run `node --test tests/` with a bare directory (MODULE_NOT_FOUND). Run specific files or `npm test`.
- NEVER `git push`.

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `scripts/lib/reconcile.mjs` | **New** | Pure core: `classifyDrift({ledger, items, sourceExists})` + `resolveReconcileDecisions(drift, decisions)`. Imports only `parseCid` from `./promote.mjs`. |
| `scripts/board.mjs` | Mod | `listItems(cfg, {pageSize, withBodies})` — `withBodies:true` adds `body url` to the Issue fragment and `body`/`issueUrl` to each returned item. |
| `scripts/board-manager.mjs` | Mod | DI-contract comment line; `makeRealEngine` gains `listItemsWithBodies`; `reconcileScan`/`reconcileApply` verbs; CLI dispatch + help. |
| `tests/helpers/mock-engine.mjs` | Mod | Add `listItemsWithBodies` recorded op. |
| `tests/reconcile.test.mjs` | **New** | Pure-core unit tests. |
| `tests/reconcile-verb.test.mjs` | **New** | Verb tests against the mock engine (temp dirs). |
| `tests/reconcile-pipeline.test.mjs` | **New** | Cross-module real chain: sync→map→promote→drift→heal. |
| `tests/live-reconcile.test.mjs` | **New** | Gated live smoke (`GBS_LIVE=1`) for the `withBodies` read. **Written, never run here.** |

**Conventions:** tests use `node:test` + `assert/strict`; temp dirs `mkdtempSync(join(os.tmpdir(), 'gbs-…'))`; imports grouped at top of files (extend existing import lines, never duplicate). Ledger candidate shape reminder: `{id, title, note, source, suggestedLane, suggestedOwner, addedAt, status, kind?, confidence?, commentTarget?, promotion?}`.

---

### Task 1: `classifyDrift` (`lib/reconcile.mjs`)

**Files:**
- Create: `scripts/lib/reconcile.mjs`
- Test: `tests/reconcile.test.mjs` (new)

- [ ] **Step 1: Write the failing tests.** Create `tests/reconcile.test.mjs`:

```javascript
// tests/reconcile.test.mjs — M4a pure drift classification + decision resolution
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDrift } from '../scripts/lib/reconcile.mjs';
import { cidMarker } from '../scripts/lib/promote.mjs';

// Board item factory: a live issue whose body carries the cid marker.
const item = (cid, over = {}) => ({
  itemId: `it-${cid}-${over.issueNumber ?? 1}`,
  issueNumber: 1, title: 'Card title', stageLabel: 'Building', labels: [],
  body: `some text\n\n${cidMarker(cid)}`, issueUrl: `https://github.com/o/r/issues/${over.issueNumber ?? 1}`,
  ...over,
});

const cand = (id, over = {}) => ({
  id, title: 'Card title', note: '', source: 'manual',
  suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't',
  status: 'mapped', ...over,
});

const CID_A = 'aaaaaaaaaaaa';
const CID_B = 'bbbbbbbbbbbb';
const exists = () => true;

test('clean board: promoted candidate whose marker is live -> nothing flagged', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'promoted', promotion: { issueNumber: 1, itemId: 'it-1' } })] },
    items: [item(CID_A, { issueNumber: 1 })],
    sourceExists: exists,
  });
  assert.deepEqual(d, { safeHeals: [], uncertain: [], duplicates: [], clean: true });
});

test('clean: unpromoted candidate with no marker anywhere (normal pre-promotion)', () => {
  const d = classifyDrift({ ledger: { candidates: [cand(CID_A)] }, items: [], sourceExists: exists });
  assert.equal(d.clean, true);
});

test('CRASH-ORPHAN: live marker, candidate not promoted -> safe heal with adopted refs', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'mapped' })] },
    items: [item(CID_A, { issueNumber: 7, itemId: 'it-7' })],
    sourceExists: exists,
  });
  assert.equal(d.safeHeals.length, 1);
  const h = d.safeHeals[0];
  assert.equal(h.kind, 'crash-orphan');
  assert.equal(h.candidateId, CID_A);
  assert.deepEqual(h.refs, { issueNumber: 7, issueUrl: 'https://github.com/o/r/issues/7', itemId: 'it-7' });
  assert.equal(d.clean, false);
});

test('CRASH-ORPHAN: even a dismissed candidate with a live marker is settled (board reality wins)', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'dismissed' })] },
    items: [item(CID_A)],
    sourceExists: exists,
  });
  assert.equal(d.safeHeals[0].kind, 'crash-orphan');
});

test('UNKNOWN-MARKER: live marker, no candidate at all -> safe adopt carrying the live title', () => {
  const d = classifyDrift({
    ledger: { candidates: [] },
    items: [item(CID_B, { title: 'Orphan card', issueNumber: 3, itemId: 'it-3' })],
    sourceExists: exists,
  });
  assert.equal(d.safeHeals.length, 1);
  const h = d.safeHeals[0];
  assert.equal(h.kind, 'unknown-marker');
  assert.equal(h.candidateId, CID_B);
  assert.equal(h.title, 'Orphan card');
  assert.equal(h.refs.issueNumber, 3);
});

test('VANISHED: promoted candidate, no live item by marker OR issueNumber -> uncertain with options', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'promoted', promotion: { issueNumber: 42, itemId: 'gone' } })] },
    items: [],
    sourceExists: exists,
  });
  assert.equal(d.uncertain.length, 1);
  const u = d.uncertain[0];
  assert.equal(u.kind, 'vanished');
  assert.equal(u.candidateId, CID_A);
  assert.deepEqual(u.options, ['re-promote', 'dismiss', 'keep']);
  assert.match(u.question, /42/);
});

test('NOT vanished: marker lost (body edited) but issueNumber still on the board -> clean', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'promoted', promotion: { issueNumber: 5 } })] },
    items: [{ itemId: 'x', issueNumber: 5, title: 'Card', stageLabel: null, labels: [], body: 'marker was edited away', issueUrl: null }],
    sourceExists: exists,
  });
  assert.equal(d.clean, true);
});

test('NOT vanished: marker found on an item with a DIFFERENT issueNumber than recorded refs -> clean (marker wins; stale-ref fix is YAGNI)', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'promoted', promotion: { issueNumber: 999 } })] },
    items: [item(CID_A, { issueNumber: 5 })],
    sourceExists: exists,
  });
  assert.equal(d.clean, true);
});

test('NOT vanished: comment-kind promotion (no issueNumber) is skipped', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'promoted', kind: 'comment', promotion: { commentTarget: 12 } })] },
    items: [],
    sourceExists: exists,
  });
  assert.equal(d.clean, true);
});

test('DEAD-SOURCE: unpromoted candidate with path-like source that no longer exists -> uncertain', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'mapped', source: 'docs/superpowers/plans/gone.md#task-2' })] },
    items: [],
    sourceExists: (p) => p !== 'docs/superpowers/plans/gone.md',
  });
  assert.equal(d.uncertain.length, 1);
  const u = d.uncertain[0];
  assert.equal(u.kind, 'dead-source');
  assert.deepEqual(u.options, ['dismiss', 'keep']);
  assert.match(u.question, /gone\.md/);
});

test('DEAD-SOURCE checks only path-like sources: manual / reconcile:adopted exempt', () => {
  const d = classifyDrift({
    ledger: { candidates: [
      cand(CID_A, { source: 'manual' }),
      cand(CID_B, { source: 'reconcile:adopted' }),
    ] },
    items: [],
    sourceExists: () => false, // nothing exists — yet nothing should flag
  });
  assert.equal(d.clean, true);
});

test('DEAD-SOURCE skips settled candidates (promoted/dismissed)', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'dismissed', source: 'TODO.md' })] },
    items: [],
    sourceExists: () => false,
  });
  assert.equal(d.clean, true);
});

test('DUPLICATES: two live items with the same cid -> report-only, lowest issueNumber kept', () => {
  const d = classifyDrift({
    ledger: { candidates: [cand(CID_A, { status: 'promoted', promotion: { issueNumber: 4 } })] },
    items: [item(CID_A, { issueNumber: 9, itemId: 'it-9' }), item(CID_A, { issueNumber: 4, itemId: 'it-4' })],
    sourceExists: exists,
  });
  assert.equal(d.duplicates.length, 1);
  assert.deepEqual(d.duplicates[0], { cid: CID_A, issueNumbers: [4, 9], kept: 4 });
  assert.equal(d.safeHeals.length, 0); // candidate already promoted — no heal
});

test('markerless items (hand-made cards) are ignored entirely', () => {
  const d = classifyDrift({
    ledger: { candidates: [] },
    items: [{ itemId: 'h1', issueNumber: 8, title: 'Hand-made', stageLabel: 'Ideas', labels: [], body: 'no marker here', issueUrl: null }],
    sourceExists: exists,
  });
  assert.equal(d.clean, true);
});

test('null/empty inputs -> clean, never throws', () => {
  assert.equal(classifyDrift({ ledger: null, items: null, sourceExists: exists }).clean, true);
  assert.equal(classifyDrift({ ledger: { candidates: [] }, items: [], sourceExists: exists }).clean, true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/reconcile.test.mjs`
Expected: FAIL — `Cannot find module … reconcile.mjs`

- [ ] **Step 3: Implement.** Create `scripts/lib/reconcile.mjs`:

```javascript
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/reconcile.test.mjs`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/reconcile.mjs tests/reconcile.test.mjs
git commit -m "feat(m4a): classifyDrift — pure four-class drift detection from markers + provenance"
```

---

### Task 2: `resolveReconcileDecisions` (`lib/reconcile.mjs`)

**Files:**
- Modify: `scripts/lib/reconcile.mjs`
- Test: `tests/reconcile.test.mjs` (append; merge `resolveReconcileDecisions` into the top import line)

- [ ] **Step 1: Append the failing tests**

```javascript
test('resolveReconcileDecisions: safe heals always apply (settle/adopt actions), no decision needed', () => {
  const drift = {
    safeHeals: [
      { kind: 'crash-orphan', candidateId: CID_A, title: 't', refs: { issueNumber: 1 } },
      { kind: 'unknown-marker', candidateId: CID_B, title: 't2', refs: { issueNumber: 2 } },
    ],
    uncertain: [], duplicates: [],
  };
  const { toApply, held, errors } = resolveReconcileDecisions(drift, null);
  assert.equal(errors.length, 0);
  assert.equal(held.length, 0);
  assert.deepEqual(toApply.map((a) => a.action), ['settle', 'adopt']);
});

test('resolveReconcileDecisions: decided uncertain items join toApply with their action', () => {
  const drift = {
    safeHeals: [],
    uncertain: [
      { kind: 'vanished', candidateId: CID_A, title: 't', refs: {}, question: 'q', options: ['re-promote', 'dismiss', 'keep'] },
      { kind: 'dead-source', candidateId: CID_B, title: 't2', source: 's', question: 'q', options: ['dismiss', 'keep'] },
    ],
    duplicates: [],
  };
  const { toApply, held, errors } = resolveReconcileDecisions(drift, {
    [CID_A]: { action: 're-promote' },
    [CID_B]: { action: 'dismiss' },
  });
  assert.equal(errors.length, 0);
  assert.equal(held.length, 0);
  assert.deepEqual(toApply.map((a) => [a.candidateId, a.action]), [[CID_A, 're-promote'], [CID_B, 'dismiss']]);
});

test('resolveReconcileDecisions: undecided uncertain -> held (never blocks safe heals)', () => {
  const drift = {
    safeHeals: [{ kind: 'crash-orphan', candidateId: CID_A, title: 't', refs: {} }],
    uncertain: [{ kind: 'vanished', candidateId: CID_B, title: 't2', refs: {}, question: 'q', options: ['re-promote', 'dismiss', 'keep'] }],
    duplicates: [],
  };
  const { toApply, held, errors } = resolveReconcileDecisions(drift, null);
  assert.equal(errors.length, 0);
  assert.deepEqual(held.map((h) => h.candidateId), [CID_B]);
  assert.deepEqual(toApply.map((a) => a.action), ['settle']);
});

test('resolveReconcileDecisions: fail-closed — unknown cid, illegal action per kind, decision on a safe heal', () => {
  const drift = {
    safeHeals: [{ kind: 'crash-orphan', candidateId: CID_A, title: 't', refs: {} }],
    uncertain: [{ kind: 'dead-source', candidateId: CID_B, title: 't2', source: 's', question: 'q', options: ['dismiss', 'keep'] }],
    duplicates: [],
  };
  const { errors } = resolveReconcileDecisions(drift, {
    'ffffffffffff': { action: 'dismiss' },     // unknown cid
    [CID_B]: { action: 're-promote' },          // illegal for dead-source
    [CID_A]: { action: 'keep' },                // safe heals take no decisions
  });
  assert.equal(errors.length, 3);
  for (const e of errors) {
    assert.equal(typeof e.candidateId, 'string');
    assert.equal(typeof e.error, 'string');
  }
});

test('resolveReconcileDecisions: malformed decisions object tolerated as empty', () => {
  const drift = { safeHeals: [], uncertain: [], duplicates: [] };
  assert.equal(resolveReconcileDecisions(drift, 'garbage').errors.length, 0);
  assert.equal(resolveReconcileDecisions(drift, [1, 2]).errors.length, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/reconcile.test.mjs`
Expected: FAIL — `resolveReconcileDecisions` not exported

- [ ] **Step 3: Implement** (append to `scripts/lib/reconcile.mjs`):

```javascript
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/reconcile.test.mjs`
Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/reconcile.mjs tests/reconcile.test.mjs
git commit -m "feat(m4a): resolveReconcileDecisions — fail-closed decision merge over drift"
```

---

### Task 3: `withBodies` read — engine + DI contract + mock

**Files:**
- Modify: `scripts/board.mjs` (the `listItems` function)
- Modify: `scripts/board-manager.mjs` (DI-contract comment + `makeRealEngine`)
- Modify: `tests/helpers/mock-engine.mjs`
- Test: `tests/reconcile-verb.test.mjs` (new — wiring assertions only in this task)

- [ ] **Step 1: Write the failing tests.** Create `tests/reconcile-verb.test.mjs`:

```javascript
// tests/reconcile-verb.test.mjs — M4a reconcile verbs against the mock engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-reconcile-'));

test('mock engine records listItemsWithBodies like every other op', async () => {
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });
  const r = await engine.listItemsWithBodies();
  assert.deepEqual(r, { items: [], count: 0 });
  assert.deepEqual(engine.calls.map((c) => c.op), ['listItemsWithBodies']);
});

test('WIRING: board.mjs listItems supports withBodies (body+url in the Issue fragment, conditional)', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'board.mjs'), 'utf8');
  assert.ok(src.includes('withBodies'), 'listItems has no withBodies option');
  assert.match(src, /body url/, 'Issue fragment never gains body url');
});

test('WIRING: makeRealEngine exposes listItemsWithBodies and the DI contract documents it', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'board-manager.mjs'), 'utf8');
  assert.match(src, /listItemsWithBodies:\s*\(\)\s*=>\s*eng\.listItems\(cfg,\s*\{\s*withBodies:\s*true\s*\}\)/);
  assert.match(src, /engine\.listItemsWithBodies\(\)/, 'DI contract header missing the new op');
});
```

(The wiring tests are source-level assertions because `makeRealEngine` is private and `listItems` shells to `gh` — the real read is covered by Task 8's gated live smoke.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/reconcile-verb.test.mjs`
Expected: FAIL — mock has no `listItemsWithBodies`; wiring assertions fail

- [ ] **Step 3: Implement.**

(a) `tests/helpers/mock-engine.mjs` — add one line after the `listItems` recorder:

```javascript
    listItemsWithBodies: rec('listItemsWithBodies'),
```

(b) `scripts/board.mjs` — change `listItems`'s signature and Issue fragment. The function currently begins:

```javascript
function listItems(cfg, { pageSize = 50 } = {}) {
```

Change to:

```javascript
function listItems(cfg, { pageSize = 50, withBodies = false } = {}) {
```

In the GraphQL template, the Issue fragment currently reads:

```
                ... on Issue {
                  number title state
                  repository { nameWithOwner }
                  labels(first:20) { nodes { name } }
                }
```

Change the first line of the fragment to interpolate the optional fields:

```javascript
                ... on Issue {
                  number title state ${withBodies ? 'body url' : ''}
                  repository { nameWithOwner }
                  labels(first:20) { nodes { name } }
                }
```

And in the `items.push({ ... })` object, after the `labels:` line, add:

```javascript
        ...(withBodies ? { body: c.body ?? null, issueUrl: c.url ?? null } : {}),
```

(c) `scripts/board-manager.mjs`:
- In the DI-contract comment block at the top (after the `engine.listItems()` line), add:

```javascript
//   engine.listItemsWithBodies()                        -> { items:[{itemId,issueNumber,title,stageLabel,labels[],body,issueUrl}], count }
```

- In `makeRealEngine`'s returned object (after the `listItems:` line), add:

```javascript
    listItemsWithBodies: () => eng.listItems(cfg, { withBodies: true }),
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/reconcile-verb.test.mjs`
Expected: PASS (3 tests)
Also: `npm test` → full suite green (2 pre-existing skips; listItems default path unchanged).

- [ ] **Step 5: Commit**

```bash
git add scripts/board.mjs scripts/board-manager.mjs tests/helpers/mock-engine.mjs tests/reconcile-verb.test.mjs
git commit -m "feat(m4a): listItems withBodies option + listItemsWithBodies DI op"
```

---

### Task 4: `reconcileScan` verb

**Files:**
- Modify: `scripts/board-manager.mjs` (new verb after `syncRecord`, before `promotePlan`'s section is fine — place it after the sync verbs)
- Test: `tests/reconcile-verb.test.mjs` (append)

- [ ] **Step 1: Append the failing tests.** (Extend the top imports: add `reconcileScan` from `../scripts/board-manager.mjs`, `cidMarker` from `../scripts/lib/promote.mjs`, and `ensureLedger, writeLedger, readLedger` from `../scripts/lib/ledger.mjs`; add `writeFileSync, mkdirSync` to the `node:fs` import.)

```javascript
const CFG = { stageOptions: { Ideas: 'o1', Building: 'o2' }, routing: { agent: 'agent:go', human: 'needs-claude' } };
const CID = 'abcabcabcabc';

async function seedLedger(dir, candidates) {
  const l = await ensureLedger(dir);
  l.candidates = candidates;
  await writeLedger(dir, l);
}

const liveItem = (cid, over = {}) => ({
  itemId: 'it-1', issueNumber: 1, title: 'Wire auth', stageLabel: 'Building', labels: [],
  body: `note\n\n${cidMarker(cid)}`, issueUrl: 'https://github.com/o/r/issues/1', ...over,
});

test('reconcileScan: composes engine read + ledger + fs probe into a drift report (read-only)', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'mapped' }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID)], count: 1 }) });

  const { drift, say } = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(drift.safeHeals.length, 1);
  assert.equal(drift.safeHeals[0].kind, 'crash-orphan');
  assert.match(say, /1 safe heal/);
  // read-only: ledger untouched
  assert.equal((await readLedger(dir)).candidates[0].status, 'mapped');
});

test('reconcileScan: clean board says so', async () => {
  const dir = tmp();
  await seedLedger(dir, []);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });
  const { drift, say } = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(drift.clean, true);
  assert.match(say, /clean/i);
});

test('reconcileScan: dead-source probes the real fs relative to dir', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'alive.md'), 'x', 'utf8');
  await seedLedger(dir, [
    { id: 'aaaaaaaaaaa1', title: 'Alive', note: '', source: 'docs/alive.md#t1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
    { id: 'aaaaaaaaaaa2', title: 'Dead', note: '', source: 'docs/dead.md#t1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
  ]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });
  const { drift } = await reconcileScan({ engine, config: CFG, dir });
  assert.deepEqual(drift.uncertain.map((u) => [u.kind, u.title]), [['dead-source', 'Dead']]);
});

test('reconcileScan: a failing live read throws LOUDLY (no silent clean bill)', async () => {
  const dir = tmp();
  await seedLedger(dir, []);
  const engine = makeMockEngine({ listItemsWithBodies: () => { throw new Error('gh: not authed'); } });
  await assert.rejects(() => reconcileScan({ engine, config: CFG, dir }), /not authed/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/reconcile-verb.test.mjs`
Expected: FAIL — `reconcileScan` not exported

- [ ] **Step 3: Implement** (in `scripts/board-manager.mjs`, after `syncRecord`). Add `classifyDrift, resolveReconcileDecisions` to a new import from `./lib/reconcile.mjs` placed with the other lib imports:

```javascript
import { classifyDrift, resolveReconcileDecisions } from './lib/reconcile.mjs';
```

Then the verb:

```javascript
// ===========================================================================
// M4a RECONCILE — drift detection (scan) + ledger-only healing (apply).
// The board is NEVER written here; board mutations stay promote's job.
// ===========================================================================

/**
 * reconcileScan(ctx) — classify drift between the ledger, the live board, and
 * the source files. READ-ONLY (one live board read; zero writes). A failing
 * board read throws loudly — this is a user-invoked verb, and silent
 * degradation would fake a clean bill of health.
 * @param {object} ctx { engine, config, dir, sourceExists? }
 * @returns {Promise<{drift:object, say:string}>}
 */
export async function reconcileScan(ctx) {
  const dir = ctx.dir || process.cwd();
  const ledger = (await readLedger(dir)) || { candidates: [] };
  const { items } = await ctx.engine.listItemsWithBodies();
  const sourceExists = ctx.sourceExists || ((p) => existsSync(join(dir, p)));
  const drift = classifyDrift({ ledger, items, sourceExists });
  const say = drift.clean
    ? 'Reconcile scan: clean — ledger and board agree.'
    : `Reconcile scan: ${drift.safeHeals.length} safe heal(s), ${drift.uncertain.length} need a decision, ${drift.duplicates.length} duplicate marker group(s).`;
  return { drift, say };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/reconcile-verb.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/board-manager.mjs tests/reconcile-verb.test.mjs
git commit -m "feat(m4a): reconcileScan verb — read-only drift report"
```

---

### Task 5: `reconcileApply` verb

**Files:**
- Modify: `scripts/board-manager.mjs` (after `reconcileScan`)
- Test: `tests/reconcile-verb.test.mjs` (append; add `reconcileApply` to the board-manager import)

- [ ] **Step 1: Append the failing tests**

```javascript
test('reconcileApply: safe heals auto-apply — crash-orphan settled with adopted refs, ledger persisted', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'mapped' }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID, { issueNumber: 7, itemId: 'it-7', issueUrl: 'u7' })], count: 1 }) });

  const { report, say } = await reconcileApply(null, { engine, config: CFG, dir });
  assert.deepEqual(report.healed, [{ candidateId: CID, issueNumber: 7 }]);
  const after = (await readLedger(dir)).candidates[0];
  assert.equal(after.status, 'promoted');
  assert.deepEqual(after.promotion, { issueNumber: 7, issueUrl: 'u7', itemId: 'it-7' });
  assert.match(say, /1 healed/);
  // LEDGER-ONLY: the engine saw exactly one call — the read.
  assert.deepEqual(engine.calls.map((c) => c.op), ['listItemsWithBodies']);
});

test('reconcileApply: unknown marker adopted as a promoted candidate with the marker cid as id', async () => {
  const dir = tmp();
  await seedLedger(dir, []);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID, { title: 'Orphan card', issueNumber: 3, itemId: 'it-3' })], count: 1 }) });

  const { report } = await reconcileApply(null, { engine, config: CFG, dir });
  assert.equal(report.adopted.length, 1);
  const cand = (await readLedger(dir)).candidates.find((c) => c.id === CID);
  assert.equal(cand.status, 'promoted');
  assert.equal(cand.title, 'Orphan card');
  assert.equal(cand.source, 'reconcile:adopted');
  assert.equal(cand.promotion.issueNumber, 3);
});

test('reconcileApply: re-promote decision resets candidate to mapped and clears promotion', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'promoted', kind: 'card', confidence: 0.9, promotion: { issueNumber: 42, itemId: 'gone' } }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });

  const { report } = await reconcileApply({ [CID]: { action: 're-promote' } }, { engine, config: CFG, dir });
  assert.deepEqual(report.reset, [{ candidateId: CID }]);
  const after = (await readLedger(dir)).candidates[0];
  assert.equal(after.status, 'mapped');
  assert.equal(after.promotion, undefined);
});

test('reconcileApply: dismiss + keep decisions; undecided held', async () => {
  const dir = tmp();
  await seedLedger(dir, [
    { id: 'aaaaaaaaaaa1', title: 'Dead1', note: '', source: 'docs/x.md#1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
    { id: 'aaaaaaaaaaa2', title: 'Dead2', note: '', source: 'docs/y.md#1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
    { id: 'aaaaaaaaaaa3', title: 'Dead3', note: '', source: 'docs/z.md#1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
  ]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });

  const { report } = await reconcileApply(
    { aaaaaaaaaaa1: { action: 'dismiss' }, aaaaaaaaaaa2: { action: 'keep' } },
    { engine, config: CFG, dir },
  );
  assert.deepEqual(report.dismissed, [{ candidateId: 'aaaaaaaaaaa1' }]);
  assert.deepEqual(report.kept, [{ candidateId: 'aaaaaaaaaaa2' }]);
  assert.deepEqual(report.held, ['aaaaaaaaaaa3']);
  const after = await readLedger(dir);
  assert.equal(after.candidates.find((c) => c.id === 'aaaaaaaaaaa1').status, 'dismissed');
  assert.equal(after.candidates.find((c) => c.id === 'aaaaaaaaaaa2').status, 'candidate'); // keep = untouched
});

test('reconcileApply: fail-closed — one bad decision refuses the WHOLE run, ledger untouched', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'mapped' }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID)], count: 1 }) });

  await assert.rejects(
    () => reconcileApply({ ffffffffffff: { action: 'dismiss' } }, { engine, config: CFG, dir }),
    /refused/,
  );
  assert.equal((await readLedger(dir)).candidates[0].status, 'mapped'); // even the safe heal didn't run
});

test('reconcileApply: SELF-EXTINGUISHING — re-scan after apply is clean; re-apply is a no-op', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'mapped' }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID)], count: 1 }) });

  await reconcileApply(null, { engine, config: CFG, dir });
  const rescan = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(rescan.drift.clean, true);
  const again = await reconcileApply(null, { engine, config: CFG, dir });
  assert.equal(again.report.healed.length, 0);
  assert.equal(again.report.adopted.length, 0);
});

test('reconcileApply: duplicates pass through to the report untouched (report-only)', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'promoted', promotion: { issueNumber: 4, itemId: 'it-4' } }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID, { issueNumber: 4, itemId: 'it-4' }), liveItem(CID, { issueNumber: 9, itemId: 'it-9' })], count: 2 }) });

  const { report } = await reconcileApply(null, { engine, config: CFG, dir });
  assert.deepEqual(report.duplicates, [{ cid: CID, issueNumbers: [4, 9], kept: 4 }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/reconcile-verb.test.mjs`
Expected: FAIL — `reconcileApply` not exported

- [ ] **Step 3: Implement** (in `scripts/board-manager.mjs`, after `reconcileScan`):

```javascript
/**
 * reconcileApply(decisions, ctx) — heal drift, LEDGER-ONLY (the board is never
 * written; a re-promoted candidate re-enters promote's pipeline, which does the
 * board work later). Fail-closed: any bad decision refuses the whole run before
 * a single write. Persist after each item (resumable). Heals are
 * self-extinguishing — a re-scan after apply is clean (only 'keep' items
 * intentionally resurface on later scans).
 * @param {object|null} decisions { [candidateId]: { action } }
 * @param {object} ctx { engine, config, dir, sourceExists? }
 * @returns {Promise<{report:object, say:string}>}
 */
export async function reconcileApply(decisions, ctx) {
  const dir = ctx.dir || process.cwd();
  const { drift } = await reconcileScan(ctx);
  const { toApply, held, errors } = resolveReconcileDecisions(drift, decisions);
  if (errors.length) {
    throw new Error(`reconcile: refused — ${errors.length} bad decision(s): ` +
      errors.map((e) => `${e.candidateId}: ${e.error}`).join('; '));
  }

  const ledger = (await readLedger(dir)) || (await ensureLedger(dir));
  const byId = new Map((ledger.candidates || []).map((c) => [c.id, c]));
  const report = {
    healed: [], adopted: [], reset: [], dismissed: [], kept: [],
    held: held.map((h) => h.candidateId),
    duplicates: drift.duplicates,
    errors: [],
  };

  for (const a of toApply) {
    const cand = byId.get(a.candidateId);
    if (a.action === 'settle') {
      if (!cand) continue; // raced away between scan and apply — next scan re-flags
      cand.status = 'promoted';
      cand.promotion = { ...a.refs };
      await writeLedger(dir, ledger);
      report.healed.push({ candidateId: a.candidateId, issueNumber: a.refs.issueNumber });
    } else if (a.action === 'adopt') {
      if (cand) continue; // already adopted (re-run) — nothing to do
      const adopted = {
        id: a.candidateId, title: a.title || '(adopted from board)', note: '',
        source: 'reconcile:adopted', suggestedLane: null, suggestedOwner: null,
        addedAt: new Date().toISOString(), status: 'promoted', promotion: { ...a.refs },
      };
      ledger.candidates.push(adopted);
      byId.set(adopted.id, adopted);
      await writeLedger(dir, ledger);
      report.adopted.push({ candidateId: a.candidateId, issueNumber: a.refs.issueNumber });
    } else if (a.action === 're-promote') {
      if (!cand) continue;
      cand.status = 'mapped';
      delete cand.promotion;
      await writeLedger(dir, ledger);
      report.reset.push({ candidateId: a.candidateId });
    } else if (a.action === 'dismiss') {
      if (!cand) continue;
      cand.status = 'dismissed';
      await writeLedger(dir, ledger);
      report.dismissed.push({ candidateId: a.candidateId });
    } else if (a.action === 'keep') {
      report.kept.push({ candidateId: a.candidateId }); // untouched; resurfaces next scan
    }
  }

  const say = `Reconcile: ${report.healed.length} healed, ${report.adopted.length} adopted, ` +
    `${report.reset.length} reset for re-promotion, ${report.dismissed.length} dismissed, ` +
    `${report.kept.length} kept, ${report.held.length} held` +
    (report.duplicates.length ? `, ${report.duplicates.length} duplicate group(s) reported` : '') + '.';
  return { report, say };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/reconcile-verb.test.mjs`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/board-manager.mjs tests/reconcile-verb.test.mjs
git commit -m "feat(m4a): reconcileApply verb — fail-closed ledger-only healing, self-extinguishing"
```

---

### Task 6: CLI wiring

**Files:**
- Modify: `scripts/board-manager.mjs` (help text + dispatch)

- [ ] **Step 1: Help text.** In the `cli()` help block, after the `sync record` line, add:

```
  reconcile scan                        drift report: ledger vs board vs source files (read-only)
  reconcile apply [--decisions <file>]  heal drift — ledger-only writes (board untouched)
```

- [ ] **Step 2: Dispatch.** `reconcile` needs a configured board → it goes in the **main switch** (after the `promote` case), NOT the bypass section. Reuses the existing `--decisions` flag:

```javascript
    case 'reconcile': {
      const sub = rest[0];
      const { readFile } = await import('node:fs/promises');
      if (sub === 'scan' || !sub) {
        const r = await reconcileScan({ ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.drift, null, 2));
        return;
      }
      if (sub === 'apply') {
        let d = null;
        if (decisionsPath) d = JSON.parse(await readFile(decisionsPath, 'utf8'));
        const r = await reconcileApply(d, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.report, null, 2));
        return;
      }
      throw new Error('usage: reconcile <scan|apply> [--decisions <file>]');
    }
```

- [ ] **Step 3: Verify.** Run `node scripts/board-manager.mjs --help` from the repo root → both reconcile lines appear. Run `npm test` → full suite green (2 pre-existing skips).

- [ ] **Step 4: Commit**

```bash
git add scripts/board-manager.mjs
git commit -m "feat(m4a): CLI wiring for reconcile scan/apply"
```

---

### Task 7: Cross-module pipeline test (the M3a/M3b lesson)

**Files:**
- Test: `tests/reconcile-pipeline.test.mjs` (new)

Real chain, no boundary fixtures: candidates come from `syncRecord`, proposals through `applyProposals`, real marker bodies from `promoteApply` against the mock engine, drift from `classifyDrift`, healing from `reconcileApply`.

- [ ] **Step 1: Write the tests.** Create `tests/reconcile-pipeline.test.mjs`:

```javascript
// tests/reconcile-pipeline.test.mjs — REAL chain across M3b->M2->M3a->M4a.
// No hand-built fixtures at module boundaries: syncRecord creates candidates,
// applyProposals maps them, promoteApply (mock engine) creates the real marker
// bodies, classifyDrift/reconcileApply detect + heal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { syncRecord, promoteApply, reconcileScan, reconcileApply } from '../scripts/board-manager.mjs';
import { readLedger, writeLedger } from '../scripts/lib/ledger.mjs';
import { applyProposals } from '../scripts/lib/mapper.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  rules: { promoteConfidenceBelow: 0.8 },
};

/** Mock board: createIssue captures real bodies; listItemsWithBodies serves them back. */
function makeBoard() {
  const issues = [];
  let n = 0;
  const engine = makeMockEngine({
    createIssue: (title, body) => {
      n += 1;
      const issue = { number: n, url: `https://github.com/o/r/issues/${n}`, issueNodeId: `node${n}`, title, body };
      issues.push(issue);
      return issue;
    },
    addIssueToBoard: (url) => ({ itemId: `item-${url.split('/').pop()}` }),
    setStage: () => ({ ok: true }),
    setLabels: () => ({ ok: true }),
    listItemsWithBodies: () => ({
      items: issues.map((i) => ({
        itemId: `item-${i.number}`, issueNumber: i.number, title: i.title,
        stageLabel: 'Building', labels: [], body: i.body, issueUrl: i.url,
      })),
      count: issues.length,
    }),
  });
  return { engine, issues };
}

/** Full real pipeline: TODO.md -> syncRecord -> applyProposals -> promoteApply. */
async function pipelineToBoard(dir, engine) {
  writeFileSync(join(dir, 'TODO.md'), '- [ ] Wire retry on upload', 'utf8');
  await syncRecord({ dir, config: null, extracted: [{ title: 'Wire retry on upload', source: 'TODO.md' }] });
  let ledger = await readLedger(dir);
  const id = ledger.candidates[0].id;
  const { ledger: mapped } = applyProposals(ledger, [
    { candidateId: id, kind: 'card', title: 'Wire retry on upload', lane: 'Building', owner: 'agent', confidence: 0.95, rationale: 'clear' },
  ], CFG);
  await writeLedger(dir, mapped);
  await promoteApply(null, { engine, config: CFG, staged: false, dir });
  return id;
}

test('healthy pipeline -> reconcile scan is CLEAN (real marker bodies round-trip)', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-rpipe-'));
  const { engine } = makeBoard();
  await pipelineToBoard(dir, engine);
  const { drift } = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(drift.clean, true);
});

test('CRASH WINDOW healed: revert status+promotion after a real promote -> drift detected -> healed -> clean', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-rpipe-'));
  const { engine } = makeBoard();
  const id = await pipelineToBoard(dir, engine);

  // Simulate the M3a accepted window: issue exists, ledger never settled.
  const ledger = await readLedger(dir);
  const cand = ledger.candidates.find((c) => c.id === id);
  cand.status = 'mapped';
  delete cand.promotion;
  await writeLedger(dir, ledger);

  const scan = await reconcileScan({ engine, config: CFG, dir });
  assert.deepEqual(scan.drift.safeHeals.map((h) => h.kind), ['crash-orphan']);

  await reconcileApply(null, { engine, config: CFG, dir });
  const after = (await readLedger(dir)).candidates.find((c) => c.id === id);
  assert.equal(after.status, 'promoted');
  assert.equal(after.promotion.issueNumber, 1);

  const rescan = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(rescan.drift.clean, true);
});

test('VANISHED -> re-promote -> real promote re-creates with the SAME cid marker', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-rpipe-'));
  const board = makeBoard();
  const id = await pipelineToBoard(dir, board.engine);

  // Card deleted upstream: empty the mock board.
  board.issues.length = 0;

  const scan = await reconcileScan({ engine: board.engine, config: CFG, dir });
  assert.deepEqual(scan.drift.uncertain.map((u) => u.kind), ['vanished']);

  await reconcileApply({ [id]: { action: 're-promote' } }, { engine: board.engine, config: CFG, dir });
  assert.equal((await readLedger(dir)).candidates.find((c) => c.id === id).status, 'mapped');

  // The normal promote pipeline re-creates the card — with the same cid marker.
  await promoteApply(null, { engine: board.engine, config: CFG, staged: false, dir });
  assert.equal(board.issues.length, 1);
  assert.ok(board.issues[0].body.includes(id), 're-created issue must carry the SAME cid marker');

  const rescan = await reconcileScan({ engine: board.engine, config: CFG, dir });
  assert.equal(rescan.drift.clean, true);
});
```

- [ ] **Step 2: Run**

Run: `node --test tests/reconcile-pipeline.test.mjs`
Expected: PASS (3 tests). IF ANY FAIL: that is a real cross-module contract bug — investigate which module breaks the chain and report it (status DONE_WITH_CONCERNS); do NOT bend the test.

- [ ] **Step 3: Full suite, then commit**

Run: `npm test` → all pass, 2 pre-existing skips.

```bash
git add tests/reconcile-pipeline.test.mjs
git commit -m "test(m4a): real-chain pipeline sync->map->promote->drift->heal (no boundary fixtures)"
```

---

### Task 8: Gated live smoke — **WRITTEN, NEVER EXECUTED**

**Files:**
- Test: `tests/live-reconcile.test.mjs` (new)

> ⚠️ **This task writes a test file and commits it. It NEVER runs the test with GBS_LIVE set. The full suite run will show it as skipped — that is the expected, correct state.** Mirror the gating idiom in `tests/live-promote.test.mjs` exactly (read it first).

- [ ] **Step 1: Create `tests/live-reconcile.test.mjs`** (after reading `tests/live-promote.test.mjs` for the exact skip/gating idiom used there — match it):

```javascript
// tests/live-reconcile.test.mjs — operator-gated live smoke for the ONE new
// live surface in M4a: listItems({withBodies:true}) against a real board.
// Set GBS_LIVE=1 to run. NEVER run in automated/subagent sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LIVE = process.env.GBS_LIVE === '1';

test('live: listItems withBodies returns body + issueUrl per issue item', { skip: !LIVE ? 'set GBS_LIVE=1 to run' : false }, async () => {
  const eng = await import('../scripts/board.mjs');
  const cfg = eng.loadConfig(undefined); // default ../board.json resolution
  const { items } = eng.listItems(cfg, { withBodies: true });
  assert.ok(Array.isArray(items));
  for (const it of items) {
    if (it.contentType === 'Issue') {
      assert.notEqual(it.body, undefined, 'withBodies items must carry body');
      assert.notEqual(it.issueUrl, undefined, 'withBodies items must carry issueUrl');
    }
  }
});
```

(If `live-promote.test.mjs` uses a different gating or config-loading idiom, follow that file — it is the house pattern.)

- [ ] **Step 2: Verify it auto-skips.** Run `node --test tests/live-reconcile.test.mjs` (WITHOUT GBS_LIVE — never set it). Expected: 1 skipped, 0 fail.

- [ ] **Step 3: Full suite.** Run `npm test` → all pass, now **3 skipped** (2 pre-existing + this one).

- [ ] **Step 4: Commit**

```bash
git add tests/live-reconcile.test.mjs
git commit -m "test(m4a): operator-gated live smoke for withBodies read (skipped by default)"
```

---

## Self-Review (run after all tasks)

1. **Spec coverage:** §3 flow → Tasks 1–6; §4 classification details incl. boundary-cases → Task 1 tests; §4 resolveReconcileDecisions fail-closed → Task 2; the new engine read + DI contract → Task 3; §5 apply semantics incl. self-extinguishing → Task 5 tests; §6 loud scan failure → Task 4 test; §7.3 real chain → Task 7; §7.4 gated live smoke → Task 8 (never executed); §8 decisions schema → Tasks 2/5/6. Report shape extends spec §3's list with `kept[]` (spec text: "keep → untouched, reported").
2. **Placeholder scan:** none — complete code in every step.
3. **Type consistency:** `classifyDrift({ledger, items, sourceExists})` and drift shape `{safeHeals, uncertain, duplicates, clean}` identical in Tasks 1/2/4/5/7; heal item `{kind, candidateId, title, refs}` + actions `settle|adopt|re-promote|dismiss|keep` consistent across Tasks 2/5; `listItemsWithBodies()` item shape `{itemId, issueNumber, title, stageLabel, labels, body, issueUrl}` consistent in Tasks 1/3/4/5/7/8.
