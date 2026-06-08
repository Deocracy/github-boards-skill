// tests/smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMockEngine } from './helpers/mock-engine.mjs';

test('mock engine records calls', () => {
  const e = makeMockEngine({ listItems: () => ({ items: [], count: 0 }) });
  const r = e.listItems('p1');
  assert.equal(r.count, 0);
  assert.equal(e.calls[0].op, 'listItems');
});
