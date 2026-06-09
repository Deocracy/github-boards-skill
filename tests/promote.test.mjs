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
