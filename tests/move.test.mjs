// tests/move.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { move } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const baseItems = [{ itemId: 'IT_9', issueNumber: 9, title: 'x', stageLabel: 'Building', labels: [] }];

test('move resolves the itemId (listItems) then setStage; report-back', async () => {
  const engine = makeMockEngine({
    listItems: () => ({ items: baseItems, count: 1 }),
    setStage: () => ({ ok: true }),
  });
  const ctx = { engine, config: {}, staged: false };
  const r = await move(9, 'Review', ctx);

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['listItems', 'setStage']);

  const stageCall = engine.calls.find((c) => c.op === 'setStage');
  assert.equal(stageCall.args[0], 'IT_9');
  assert.equal(stageCall.args[1], 'Review');

  assert.match(r.say, /Moved #9 → Review/);
  assert.equal(r.committed, true);
  assert.deepEqual(r.moved, { card: 9, lane: 'Review', itemId: 'IT_9' });
});

test('move in staged mode previews without committing', async () => {
  const engine = makeMockEngine({
    listItems: () => ({ items: baseItems, count: 1 }),
    setStage: () => ({ staged: true, wouldRun: { op: 'updateProjectV2ItemFieldValue' } }),
  });
  const ctx = { engine, config: {}, staged: true };
  const r = await move(9, 'Review', ctx);

  const stageCall = engine.calls.find((c) => c.op === 'setStage');
  assert.equal(stageCall.args.at(-1)?.staged, true, 'setStage passed { staged:true }');

  assert.equal(r.committed, false);
  assert.match(r.say, /Would move #9 → Review/);
});
