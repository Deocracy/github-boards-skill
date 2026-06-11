// tests/reconcile.test.mjs — M4a pure drift classification + decision resolution
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDrift, resolveReconcileDecisions } from '../scripts/lib/reconcile.mjs';
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
