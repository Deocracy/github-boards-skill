// tests/summary.test.mjs — unit tests for the summary verb
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { summary } from '../scripts/board-manager.mjs';
import { writeState } from '../scripts/lib/state.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config with routing */
const CONFIG = {
  routing: { agent: 'agent:go', human: 'needs-claude' },
};

/** Build a ctx with a mock engine and a temp dir */
function makeCtx(listItemsResult, overrides = {}) {
  return {
    engine: makeMockEngine({ listItems: () => listItemsResult }),
    config: CONFIG,
    staged: false,
    dir: overrides.dir || mkdtempSync(join(os.tmpdir(), 'gbs-summary-')),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// First run (no prior state)
// ---------------------------------------------------------------------------

test('summary first run: all current cards appear in added', async () => {
  const listItemsResult = {
    items: [
      { itemId: 'IT_1', issueNumber: 1, title: 'Alpha', stageLabel: 'Building', labels: ['agent:go'] },
      { itemId: 'IT_2', issueNumber: 2, title: 'Beta',  stageLabel: 'Review',   labels: ['needs-claude'] },
    ],
    count: 2,
  };
  const ctx = makeCtx(listItemsResult);

  const result = await summary(ctx);

  // All cards are "added" on a first run
  assert.equal(result.changes.added.length, 2);
  assert.ok(result.changes.added.includes(1));
  assert.ok(result.changes.added.includes(2));
  assert.deepEqual(result.changes.moved, []);
  assert.deepEqual(result.changes.removed, []);
});

test('summary first run: say matches /First look/', async () => {
  const listItemsResult = {
    items: [
      { itemId: 'IT_1', issueNumber: 1, title: 'Alpha', stageLabel: 'Building', labels: ['agent:go'] },
    ],
    count: 1,
  };
  const ctx = makeCtx(listItemsResult);
  const result = await summary(ctx);
  assert.match(result.say, /First look/);
});

test('summary first run: .github-boards/state.json is created', async () => {
  const listItemsResult = {
    items: [
      { itemId: 'IT_1', issueNumber: 1, title: 'Alpha', stageLabel: 'Ideas', labels: [] },
    ],
    count: 1,
  };
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-summary-'));
  const ctx = makeCtx(listItemsResult, { dir });
  await summary(ctx);
  const statePath = join(dir, '.github-boards', 'state.json');
  assert.ok(existsSync(statePath), `state.json should exist at ${statePath}`);
});

// ---------------------------------------------------------------------------
// Second run (prior state seeded)
// ---------------------------------------------------------------------------

test('summary second run: detects a move and reports it in changes.moved', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-summary-'));

  // Seed prior state: card #5 was in 'Building'
  await writeState(dir, {
    seenAt: '2026-01-01T00:00:00.000Z',
    items: {
      5: { lane: 'Building', labels: ['agent:go'], owner: 'agent' },
    },
  });

  // Mock listItems now returns #5 in 'Rejected (learnings kept)'
  const listItemsResult = {
    items: [
      {
        itemId: 'IT_5',
        issueNumber: 5,
        title: 'Card Five',
        stageLabel: 'Rejected (learnings kept)',
        labels: ['agent:go'],
      },
    ],
    count: 1,
  };
  const ctx = makeCtx(listItemsResult, { dir });
  const result = await summary(ctx);

  assert.equal(result.changes.moved.length, 1);
  assert.equal(result.changes.moved[0].number, 5);
  assert.equal(result.changes.moved[0].from, 'Building');
  assert.equal(result.changes.moved[0].to, 'Rejected (learnings kept)');
});

test('summary second run: rejected includes card that moved to a reject lane', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-summary-'));

  await writeState(dir, {
    seenAt: '2026-01-01T00:00:00.000Z',
    items: {
      5: { lane: 'Building', labels: ['agent:go'], owner: 'agent' },
    },
  });

  const listItemsResult = {
    items: [
      {
        itemId: 'IT_5',
        issueNumber: 5,
        title: 'Card Five',
        stageLabel: 'Rejected (learnings kept)',
        labels: ['agent:go'],
      },
    ],
    count: 1,
  };
  const ctx = makeCtx(listItemsResult, { dir });
  const result = await summary(ctx);

  assert.equal(result.changes.rejected.length, 1);
  assert.equal(result.changes.rejected[0].number, 5);
  assert.equal(result.changes.rejected[0].to, 'Rejected (learnings kept)');
});

test('summary second run: say matches /Since last time/ and /1 rejected/', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-summary-'));

  await writeState(dir, {
    seenAt: '2026-01-01T00:00:00.000Z',
    items: {
      5: { lane: 'Building', labels: ['agent:go'], owner: 'agent' },
    },
  });

  const listItemsResult = {
    items: [
      {
        itemId: 'IT_5',
        issueNumber: 5,
        title: 'Card Five',
        stageLabel: 'Rejected (learnings kept)',
        labels: ['agent:go'],
      },
    ],
    count: 1,
  };
  const ctx = makeCtx(listItemsResult, { dir });
  const result = await summary(ctx);

  assert.match(result.say, /Since last time/);
  assert.match(result.say, /1 rejected/);
});

// ---------------------------------------------------------------------------
// ownerOf / queue counts
// ---------------------------------------------------------------------------

test('summary ownerOf: one agent card + one human card → queues {human:1, agent:1}', async () => {
  const listItemsResult = {
    items: [
      { itemId: 'IT_1', issueNumber: 1, title: 'Agent job', stageLabel: 'Building', labels: ['agent:go'] },
      { itemId: 'IT_2', issueNumber: 2, title: 'Human job', stageLabel: 'Review',   labels: ['needs-claude'] },
    ],
    count: 2,
  };
  const ctx = makeCtx(listItemsResult);
  const result = await summary(ctx);
  assert.deepEqual(result.queues, { human: 1, agent: 1 });
});

test('summary ownerOf: card with neither label → owner null, not counted in either queue', async () => {
  const listItemsResult = {
    items: [
      { itemId: 'IT_1', issueNumber: 1, title: 'Unowned', stageLabel: 'Ideas', labels: ['bug'] },
    ],
    count: 1,
  };
  const ctx = makeCtx(listItemsResult);
  const result = await summary(ctx);
  assert.deepEqual(result.queues, { human: 0, agent: 0 });
});

// ---------------------------------------------------------------------------
// teamSync opt-in
// ---------------------------------------------------------------------------

test('summary with teamSync=true writes last-sync.json alongside state.json', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-summary-'));
  const listItemsResult = {
    items: [
      { itemId: 'IT_1', issueNumber: 1, title: 'A', stageLabel: 'Ideas', labels: [] },
    ],
    count: 1,
  };
  const ctx = makeCtx(listItemsResult, {
    dir,
    config: { ...CONFIG, teamSync: true },
  });
  await summary(ctx);
  assert.ok(existsSync(join(dir, 'last-sync.json')), 'last-sync.json should exist when teamSync=true');
  assert.ok(
    existsSync(join(dir, '.github-boards', 'state.json')),
    '.github-boards/state.json should always exist'
  );
});

test('summary without teamSync does NOT write last-sync.json', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-summary-'));
  const listItemsResult = {
    items: [],
    count: 0,
  };
  const ctx = makeCtx(listItemsResult, { dir });
  await summary(ctx);
  assert.ok(!existsSync(join(dir, 'last-sync.json')), 'last-sync.json should NOT exist when teamSync is not set');
});

// ---------------------------------------------------------------------------
// Board access: only listItems is called
// ---------------------------------------------------------------------------

test('summary is read-only toward the board (only listItems called)', async () => {
  const listItemsResult = { items: [], count: 0 };
  const ctx = makeCtx(listItemsResult);
  await summary(ctx);
  const ops = ctx.engine.calls.map((x) => x.op);
  assert.deepEqual(ops, ['listItems']);
});
