// tests/promote.test.mjs — pure unit tests for lib/promote.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cidMarker, parseCid } from '../scripts/lib/promote.mjs';

test('cidMarker/parseCid round-trip', () => {
  const cid = 'a1b2c3d4e5f6';
  const marker = cidMarker(cid);
  assert.equal(marker, `<!-- gboards:cid=${cid} -->`);
  assert.equal(parseCid(`Some body text\n\n${marker}`), cid);
});

test('parseCid returns null when no marker present', () => {
  assert.equal(parseCid('plain body, no marker'), null);
  assert.equal(parseCid(''), null);
  assert.equal(parseCid('<!-- unrelated comment -->'), null);
});

import { classify } from '../scripts/lib/promote.mjs';

const CFG = { stageOptions: { Ideas: 'o1', Building: 'o2', Shipped: 'o3' }, rules: { promoteConfidenceBelow: 0.8 } };

function led(candidates) { return { candidates }; }

test('classify: confident card (conf >= threshold) -> confident', () => {
  const p = classify(led([
    { id: 'aaaaaaaaaaaa', title: 'Wire auth', kind: 'card', suggestedLane: 'Building', suggestedOwner: 'agent', confidence: 0.95, status: 'mapped' },
  ]), CFG);
  assert.equal(p.confident.length, 1);
  assert.deepEqual(p.confident[0], { candidateId: 'aaaaaaaaaaaa', kind: 'card', title: 'Wire auth', lane: 'Building', owner: 'agent', confidence: 0.95 });
  assert.equal(p.uncertain.length, 0);
});

test('classify: low-confidence card -> uncertain with reason+question', () => {
  const p = classify(led([
    { id: 'bbbbbbbbbbbb', title: 'Maybe refactor', kind: 'card', suggestedLane: 'Ideas', suggestedOwner: 'human', confidence: 0.4, status: 'mapped' },
  ]), CFG);
  assert.equal(p.uncertain.length, 1);
  assert.equal(p.uncertain[0].reason, 'low-confidence');
  assert.deepEqual(p.uncertain[0].options, ['Ideas', 'Building', 'Shipped']);
});

test('classify: needs-decision -> uncertain carrying its own question/options', () => {
  const p = classify(led([
    { id: 'cccccccccccc', title: 'Ambiguous', status: 'needs-decision', needsDecision: { question: 'Which lane?', options: ['Ideas', 'Building'] }, suggestedLane: null, suggestedOwner: null },
  ]), CFG);
  assert.equal(p.uncertain.length, 1);
  assert.equal(p.uncertain[0].reason, 'needs-decision');
  assert.equal(p.uncertain[0].question, 'Which lane?');
  assert.deepEqual(p.uncertain[0].options, ['Ideas', 'Building']);
  assert.equal(p.uncertain[0].lane, null);
});

test('classify: confident comment -> comments with text from note', () => {
  const p = classify(led([
    { id: 'dddddddddddd', title: 'ctx', note: 'see the spec', kind: 'comment', commentTarget: 12, confidence: 0.9, status: 'mapped' },
  ]), CFG);
  assert.equal(p.comments.length, 1);
  assert.deepEqual(p.comments[0], { candidateId: 'dddddddddddd', kind: 'comment', title: 'ctx', commentTarget: 12, text: 'see the spec', confidence: 0.9 });
});

test('classify: settled + unmapped -> skipped (with reasons)', () => {
  const p = classify(led([
    { id: '111111111111', title: 'done', kind: 'card', status: 'promoted' },
    { id: '222222222222', title: 'dup', status: 'merged' },
    { id: '333333333333', title: 'parent', status: 'split' },
    { id: '444444444444', title: 'noise', status: 'dismissed' },
    { id: '555555555555', title: 'raw', status: 'candidate' },
  ]), CFG);
  assert.equal(p.confident.length, 0);
  assert.equal(p.uncertain.length, 0);
  assert.equal(p.skipped.length, 5);
  assert.ok(p.skipped.find((s) => s.candidateId === '555555555555' && s.reason === 'not-mapped'));
});

test('classify: empty ledger -> empty buckets, allowedLanes populated', () => {
  const p = classify(led([]), CFG);
  assert.deepEqual(p.confident, []);
  assert.deepEqual(p.uncertain, []);
  assert.deepEqual(p.allowedLanes, ['Ideas', 'Building', 'Shipped']);
  assert.deepEqual(p.owners, ['agent', 'human']);
});

import { resolveDecisions } from '../scripts/lib/promote.mjs';

function planFixture() {
  return {
    confident: [{ candidateId: 'aaaaaaaaaaaa', kind: 'card', title: 'A', lane: 'Building', owner: 'agent', confidence: 0.95 }],
    comments: [{ candidateId: 'dddddddddddd', kind: 'comment', title: 'c', commentTarget: 12, text: 't', confidence: 0.9 }],
    uncertain: [
      { candidateId: 'bbbbbbbbbbbb', kind: 'card', title: 'B', lane: 'Ideas', owner: 'human', confidence: 0.4, reason: 'low-confidence', question: 'q', options: ['Ideas', 'Building'] },
      { candidateId: 'cccccccccccc', kind: 'card', title: 'C', lane: null, owner: null, confidence: 0.3, reason: 'needs-decision', question: 'which?', options: [] },
    ],
    skipped: [], allowedLanes: ['Ideas', 'Building', 'Shipped'], owners: ['agent', 'human'],
  };
}

test('resolveDecisions: confident + comments auto-commit; promote-decision joins; hold/missing held', () => {
  const r = resolveDecisions(planFixture(), {
    bbbbbbbbbbbb: { action: 'promote', lane: 'Building' },   // override lane
    cccccccccccc: { action: 'hold' },
  });
  assert.equal(r.errors.length, 0);
  const ids = r.toCommit.map((x) => x.candidateId).sort();
  assert.deepEqual(ids, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'dddddddddddd']);
  // override applied + classify-only fields stripped
  const b = r.toCommit.find((x) => x.candidateId === 'bbbbbbbbbbbb');
  assert.equal(b.lane, 'Building');
  assert.equal(b.reason, undefined);
  assert.equal(b.question, undefined);
  // cccccccccccc held; aaaa already auto so not in held
  assert.deepEqual(r.held.map((h) => h.candidateId), ['cccccccccccc']);
});

test('resolveDecisions: unknown candidateId -> error', () => {
  const r = resolveDecisions(planFixture(), { zzzzzzzzzzzz: { action: 'promote' } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /no uncertain item/);
});

test('resolveDecisions: bad action -> error', () => {
  const r = resolveDecisions(planFixture(), { bbbbbbbbbbbb: { action: 'maybe' } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /must be promote\|hold/);
});

test('resolveDecisions: invalid lane override -> error', () => {
  const r = resolveDecisions(planFixture(), { bbbbbbbbbbbb: { action: 'promote', lane: 'Nonexistent' } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /not in allowed lanes/);
});

test('resolveDecisions: promote a needs-decision card with no lane supplied -> error', () => {
  const r = resolveDecisions(planFixture(), { cccccccccccc: { action: 'promote' } });
  assert.ok(r.errors.find((e) => /requires a lane/.test(e.error)));
});

test('resolveDecisions: needs-decision card with a supplied lane -> committed', () => {
  const r = resolveDecisions(planFixture(), { cccccccccccc: { action: 'promote', lane: 'Ideas', owner: 'agent' } });
  assert.equal(r.errors.length, 0);
  const c = r.toCommit.find((x) => x.candidateId === 'cccccccccccc');
  assert.equal(c.lane, 'Ideas');
  assert.equal(c.owner, 'agent');
});
