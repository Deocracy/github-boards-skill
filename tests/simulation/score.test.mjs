// tests/simulation/score.test.mjs — unit tests for the pure scoring functions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRuleAdherence, scoreConsistency, checkIdempotency } from './score.mjs';

const cfg = { stageOptions: { Ideas: 'o1', Building: 'o2' }, rules: { maxLanes: 4 } };

test('checkRuleAdherence flags an invented lane', () => {
  const r = checkRuleAdherence([{ candidateId: 'a', kind: 'card', lane: 'Ghost', owner: 'agent', confidence: 0.9 }], cfg);
  assert.equal(r.ok, false);
  assert.ok(r.violations.length >= 1);
});

test('checkRuleAdherence passes a clean batch', () => {
  const r = checkRuleAdherence([{ candidateId: 'a', kind: 'card', lane: 'Building', owner: 'agent', confidence: 0.9 }], cfg);
  assert.equal(r.ok, true);
});

test('scoreConsistency returns 1.0 when every run agrees on lane per candidate', () => {
  const runs = [
    [{ candidateId: 'a', kind: 'card', lane: 'Building' }],
    [{ candidateId: 'a', kind: 'card', lane: 'Building' }],
  ];
  assert.equal(scoreConsistency(runs), 1);
});

test('scoreConsistency drops below 1.0 when runs disagree', () => {
  const runs = [
    [{ candidateId: 'a', kind: 'card', lane: 'Building' }],
    [{ candidateId: 'a', kind: 'card', lane: 'Ideas' }],
  ];
  assert.ok(scoreConsistency(runs) < 1);
});

test('checkIdempotency is true when re-applying proposals yields the same ledger statuses', () => {
  const proposals = [{ candidateId: 'a', kind: 'card', lane: 'Building', owner: 'agent', confidence: 0.9, title: 'A' }];
  const ledger = { candidates: [{ id: 'a', title: 'A', note: '', source: 's', status: 'candidate' }] };
  assert.equal(checkIdempotency(ledger, proposals, cfg), true);
});
