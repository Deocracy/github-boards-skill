// tests/undo-pipeline.test.mjs — REAL chain: put files the card, real move/route
// mutate the board, snapshotInvert computes the plan, and the SAME real verbs
// execute it back to baseline. No hand-built diffs (MEMORY: real upstream only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { put, move, route, snapshotTake, snapshotInvert, snapshotDiff } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  preset: { lanes: [{ name: 'Ideas' }, { name: 'Building' }] },
};

/** Stateful mock board: listItems reflects setStage/setLabels/removeLabels.
 *  Label semantics mirror the real engine: setLabels ADDS, removeLabels removes
 *  (route's "add the new owner's label, remove the other's" depends on this). */
function makeBoard() {
  const issues = [];
  let n = 0;
  const stages = new Map();
  const labels = new Map();
  return makeMockEngine({
    createIssue: (title, body) => {
      n += 1;
      issues.push({ number: n, url: `https://github.com/o/r/issues/${n}`, issueNodeId: `node${n}`, title, body });
      return issues[issues.length - 1];
    },
    addIssueToBoard: (url) => ({ itemId: `item-${url.split('/').pop()}` }),
    setStage: (itemId, lane) => { stages.set(itemId, lane); return { ok: true }; },
    setLabels: (issueNumber, ls) => {
      labels.set(issueNumber, [...new Set([...(labels.get(issueNumber) || []), ...ls])]);
      return { ok: true };
    },
    removeLabels: (issueNumber, ls) => {
      labels.set(issueNumber, (labels.get(issueNumber) || []).filter((l) => !ls.includes(l)));
      return { ok: true };
    },
    comment: () => ({ ok: true }),
    listItems: () => ({
      items: issues.map((i) => ({
        itemId: `item-${i.number}`, contentType: 'Issue', issueNumber: i.number, title: i.title,
        state: 'OPEN', repo: 'o/r',
        stageLabel: stages.get(`item-${i.number}`) ?? null,
        labels: labels.get(i.number) ?? [],
      })),
      count: issues.length,
    }),
  });
}

test('REAL chain: put -> baseline -> real move+route mutations -> invert -> real move/route restore -> diff is empty', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-undo-'));
  const engine = makeBoard();

  // Real put: create -> add -> stage -> label.
  await put([{ title: 'Wire retry', lane: 'Ideas', owner: 'agent' }], { engine, config: CFG, staged: false });
  await snapshotTake('baseline', { engine, config: CFG, dir });

  // "What happened": a relane and an owner flip — through the REAL verbs.
  await move(1, 'Building', { engine, config: CFG, staged: false });
  await route(1, 'human', { engine, config: CFG, staged: false });

  // The mechanical undo plan.
  const plan = await snapshotInvert('latest', null, { engine, config: CFG, dir });
  assert.equal(plan.ops.length, 2, `expected 2 ops, got ${JSON.stringify(plan.ops)}`);
  assert.deepEqual(plan.ops.map((o) => o.op), ['move', 'route']);
  assert.deepEqual(plan.manual, []);

  // Execute the plan through the same approval-gated verbs the contract names.
  for (const op of plan.ops) {
    if (op.op === 'move') await move(op.issueNumber, op.to, { engine, config: CFG, staged: false });
    if (op.op === 'route') await route(op.issueNumber, op.to, { engine, config: CFG, staged: false });
  }

  // The board is back at baseline.
  const after = await snapshotDiff('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(after.diff, { moved: [], added: [], removed: [], relabeled: [], retitled: [] });
});
