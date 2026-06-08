// tests/queue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queue } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const THREE_ITEMS = {
  items: [
    { itemId: 'IT_1', issueNumber: 1, title: 'Human A', labels: ['needs-claude'] },
    { itemId: 'IT_2', issueNumber: 2, title: 'Human B', labels: ['needs-claude', 'bug'] },
    { itemId: 'IT_3', issueNumber: 3, title: 'Agent A', labels: ['agent:go'] },
  ],
  count: 3,
};

const ctx = () => ({
  engine: makeMockEngine({ listItems: () => THREE_ITEMS }),
  config: { routing: { agent: 'agent:go', human: 'needs-claude' } },
  staged: false,
});

test('queue(human) returns the items labelled needs-claude and reports the count', async () => {
  const r = await queue('human', ctx());
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => i.issueNumber), [1, 2]);
  assert.match(r.say, /On your plate: 2/);
});

test('queue(agent) returns the items labelled agent:go', async () => {
  const r = await queue('agent', ctx());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].issueNumber, 3);
  assert.match(r.say, /Claude's queue: 1/);
});

test('queue is read-only: only listItems is called, no write ops', async () => {
  const c = ctx();
  await queue('human', c);
  const ops = c.engine.calls.map((x) => x.op);
  assert.deepEqual(ops, ['listItems']);
});
