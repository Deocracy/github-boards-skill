// tests/mapper.test.mjs — unit tests for scripts/lib/mapper.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../scripts/lib/mapper.mjs';

test('resolveRules returns defaults when config has no rules', () => {
  const r = resolveRules({});
  assert.equal(r.maxLanes, 8);
  assert.equal(r.useTags, false);
  assert.equal(r.defaultOwner, 'human');
  assert.equal(r.granularity, 'fine');
  assert.equal(r.escalateConfidenceBelow, 0.6);
  assert.equal(r.escalateBatchOver, 12);
});

test('resolveRules merges config.rules over defaults', () => {
  const r = resolveRules({ rules: { maxLanes: 5, defaultOwner: 'agent' } });
  assert.equal(r.maxLanes, 5);          // overridden
  assert.equal(r.defaultOwner, 'agent');// overridden
  assert.equal(r.granularity, 'fine');  // default preserved
});

test('resolveRules ignores a non-object rules value', () => {
  assert.equal(resolveRules({ rules: 'nope' }).maxLanes, 8);
  assert.equal(resolveRules({ rules: ['a'] }).maxLanes, 8);
  assert.equal(resolveRules(null).maxLanes, 8);
});

import { prepareInput } from '../scripts/lib/mapper.mjs';

const cfg = { stageOptions: { Ideas: 'o1', Building: 'o2', Shipped: 'o3' }, rules: { maxLanes: 6 } };
const ledgerWith = (cands) => ({ ledgerVersion: 1, intent: {}, candidates: cands });

test('prepareInput packs only status:candidate items, mapping to {candidateId,title,note,source}', () => {
  const ledger = ledgerWith([
    { id: 'a', title: 'Do X', note: 'n', source: 's', status: 'candidate' },
    { id: 'b', title: 'Done already', note: '', source: 's', status: 'mapped' },
  ]);
  const pkt = prepareInput(ledger, cfg, null);
  assert.equal(pkt.candidates.length, 1);
  assert.deepEqual(pkt.candidates[0], { candidateId: 'a', title: 'Do X', note: 'n', source: 's' });
});

test('prepareInput exposes allowedLanes, allowedOwners, defaultLane, rules, session', () => {
  const pkt = prepareInput(ledgerWith([]), cfg, 'working on auth');
  assert.deepEqual(pkt.allowedLanes, ['Ideas', 'Building', 'Shipped']);
  assert.deepEqual(pkt.allowedOwners, ['agent', 'human']);
  assert.equal(pkt.defaultLane, 'Ideas');
  assert.equal(pkt.rules.maxLanes, 6);
  assert.equal(pkt.session, 'working on auth');
});

test('prepareInput tolerates a missing/empty ledger', () => {
  const pkt = prepareInput(null, cfg, null);
  assert.deepEqual(pkt.candidates, []);
});
