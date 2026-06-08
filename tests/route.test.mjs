// tests/route.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const routeCfg = (extra = {}) => ({
  routing: { agent: 'agent:go', human: 'needs-claude' },
  ...extra,
});

test('route to human: relabel (add human / remove agent) + escalation comment, NO stage move', async () => {
  const engine = makeMockEngine({
    setLabels: () => ({ ok: true }),
    removeLabels: () => ({ ok: true }),
    comment: () => ({ commentUrl: 'c' }),
  });
  const ctx = { engine, config: routeCfg(), staged: false };
  const r = await route(9, 'human', ctx);

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['setLabels', 'removeLabels', 'comment']);
  // invariant: a human-routed card is NOT moved
  assert.ok(!ops.includes('setStage'), 'route must not move the stage');

  const setCall = engine.calls.find((c) => c.op === 'setLabels');
  assert.deepEqual(setCall.args[1], ['needs-claude']);
  const rmCall = engine.calls.find((c) => c.op === 'removeLabels');
  assert.deepEqual(rmCall.args[1], ['agent:go']);

  const commentCall = engine.calls.find((c) => c.op === 'comment');
  assert.match(commentCall.args[1], /needs a human/);

  assert.match(r.say, /Routed #9 → human/);
  assert.equal(r.committed, true);
  assert.deepEqual(r.routed, { card: 9, owner: 'human' });
});

test('route to agent: relabel only (add agent / remove human), NO comment', async () => {
  const engine = makeMockEngine({
    setLabels: () => ({ ok: true }),
    removeLabels: () => ({ ok: true }),
  });
  const ctx = { engine, config: routeCfg(), staged: false };
  const r = await route(9, 'agent', ctx);

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['setLabels', 'removeLabels']);
  assert.ok(!ops.includes('comment'), 'agent-routing does not comment');

  const setCall = engine.calls.find((c) => c.op === 'setLabels');
  assert.deepEqual(setCall.args[1], ['agent:go']);
  const rmCall = engine.calls.find((c) => c.op === 'removeLabels');
  assert.deepEqual(rmCall.args[1], ['needs-claude']);

  assert.match(r.say, /Routed #9 → agent/);
});

test('route to human appends @escalateTo when configured', async () => {
  const engine = makeMockEngine({
    setLabels: () => ({ ok: true }),
    removeLabels: () => ({ ok: true }),
    comment: () => ({ commentUrl: 'c' }),
  });
  const ctx = { engine, config: routeCfg({ escalateTo: 'chris' }), staged: false };
  await route(9, 'human', ctx);
  const commentCall = engine.calls.find((c) => c.op === 'comment');
  assert.match(commentCall.args[1], /@chris/);
});

test('route in staged mode previews without committing', async () => {
  const engine = makeMockEngine({
    setLabels: () => ({ staged: true, wouldRun: {} }),
    removeLabels: () => ({ staged: true, wouldRun: {} }),
    comment: () => ({ staged: true, wouldRun: {} }),
  });
  const ctx = { engine, config: routeCfg(), staged: true };
  const r = await route(9, 'human', ctx);

  for (const call of engine.calls) {
    assert.equal(call.args.at(-1)?.staged, true, `${call.op} passed { staged:true }`);
  }
  assert.equal(r.committed, false);
  assert.match(r.say, /Would route #9 → human and flag it for you/);
});
