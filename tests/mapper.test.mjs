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
