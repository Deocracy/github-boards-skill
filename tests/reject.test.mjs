// tests/reject.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reject } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const baseItems = [{ itemId: 'IT_9', issueNumber: 9, title: 'x', stageLabel: 'Building', labels: [] }];
const rejectCfg = () => ({
  preset: {
    lanes: [
      { name: 'Ideas', terminal: false },
      { name: 'Building', terminal: false },
      { name: 'Shipped', terminal: true },
      { name: 'Rejected (learnings kept)', terminal: true },
    ],
  },
});

test('reject moves card to the terminal reject lane and records learnings', async () => {
  const engine = makeMockEngine({
    listItems: () => ({ items: baseItems, count: 1 }),
    setStage: () => ({ ok: true }),
    comment: () => ({ commentUrl: 'c' }),
  });
  const ctx = { engine, config: rejectCfg(), staged: false };
  const r = await reject(9, 'too costly', ctx);

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['listItems', 'setStage', 'comment']);

  const stageCall = engine.calls.find((c) => c.op === 'setStage');
  assert.equal(stageCall.args[0], 'IT_9');
  assert.equal(stageCall.args[1], 'Rejected (learnings kept)');

  const commentCall = engine.calls.find((c) => c.op === 'comment');
  assert.equal(commentCall.args[0], 9);
  assert.match(commentCall.args[1], /too costly/);

  assert.match(r.say, /Rejected #9 → Rejected \(learnings kept\); learnings recorded/);
  assert.equal(r.committed, true);
  assert.deepEqual(r.rejected, { card: 9, lane: 'Rejected (learnings kept)' });
});

test('reject in staged mode previews without committing', async () => {
  const engine = makeMockEngine({
    listItems: () => ({ items: baseItems, count: 1 }),
    setStage: () => ({ staged: true, wouldRun: {} }),
    comment: () => ({ staged: true, wouldRun: {} }),
  });
  const ctx = { engine, config: rejectCfg(), staged: true };
  const r = await reject(9, 'too costly', ctx);

  for (const call of engine.calls.filter((c) => c.op !== 'listItems')) {
    assert.equal(call.args.at(-1)?.staged, true, `${call.op} passed { staged:true }`);
  }
  assert.equal(r.committed, false);
  assert.match(r.say, /Would reject #9 \(→ Rejected \(learnings kept\)\) with learnings/);
});

test('reject throws a clear error when no terminal reject lane exists', async () => {
  const engine = makeMockEngine({ listItems: () => ({ items: baseItems, count: 1 }) });
  const ctx = {
    engine,
    config: { preset: { lanes: [{ name: 'Ideas', terminal: false }, { name: 'Shipped', terminal: true }] } },
    staged: false,
  };
  await assert.rejects(() => reject(9, 'x', ctx), /reject/i);
});

test('reject uses a default learnings note when none is provided', async () => {
  const engine = makeMockEngine({
    listItems: () => ({ items: baseItems, count: 1 }),
    setStage: () => ({ ok: true }),
    comment: () => ({ commentUrl: 'c' }),
  });
  const ctx = { engine, config: rejectCfg(), staged: false };
  await reject(9, undefined, ctx);
  const commentCall = engine.calls.find((c) => c.op === 'comment');
  assert.match(commentCall.args[1], /Rejected with learnings/);
});
