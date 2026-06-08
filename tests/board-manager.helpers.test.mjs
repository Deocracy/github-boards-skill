// tests/board-manager.helpers.test.mjs
// Unit tests for the small testable helpers exported by board-manager.mjs:
//   defaultLane(config), sayQueues(human, agent), resolveItemId(engine, issueNumber)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLane, sayQueues, resolveItemId } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

test('defaultLane returns the first NON-terminal lane name from the preset', () => {
  const config = {
    preset: {
      lanes: [
        { name: 'Ideas', terminal: false },
        { name: 'Building', terminal: false },
        { name: 'Shipped', terminal: true },
      ],
    },
  };
  assert.equal(defaultLane(config), 'Ideas');
});

test('defaultLane skips leading terminal lanes', () => {
  const config = {
    preset: {
      lanes: [
        { name: 'Done', terminal: true },
        { name: 'Intake', terminal: false },
      ],
    },
  };
  assert.equal(defaultLane(config), 'Intake');
});

test('sayQueues formats the human/agent split', () => {
  assert.equal(
    sayQueues(2, 1),
    "On your plate: 2 card(s). Claude's queue: 1 card(s)."
  );
});

test('resolveItemId finds the itemId whose issueNumber matches', async () => {
  const engine = makeMockEngine({
    listItems: () => ({
      items: [
        { itemId: 'IT_a', issueNumber: 10 },
        { itemId: 'IT_b', issueNumber: 41 },
      ],
      count: 2,
    }),
  });
  const id = await resolveItemId(engine, 41);
  assert.equal(id, 'IT_b');
});

test('resolveItemId throws a clear error when no item matches', async () => {
  const engine = makeMockEngine({
    listItems: () => ({ items: [{ itemId: 'IT_a', issueNumber: 10 }], count: 1 }),
  });
  await assert.rejects(() => resolveItemId(engine, 999), /999/);
});
