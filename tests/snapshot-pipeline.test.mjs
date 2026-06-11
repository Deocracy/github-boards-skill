// tests/snapshot-pipeline.test.mjs — REAL chain: promote pipeline output feeds
// snapshots; the diff must reflect what promote actually did. No hand-built
// snapshot fixtures at the boundary (see MEMORY: reachable states only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { syncRecord, promoteApply, snapshotTake, snapshotDiff } from '../scripts/board-manager.mjs';
import { readLedger, writeLedger } from '../scripts/lib/ledger.mjs';
import { applyProposals } from '../scripts/lib/mapper.mjs';
import { readLog } from '../scripts/lib/snapshots.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  rules: { promoteConfidenceBelow: 0.8 },
};

/** Stateful mock board whose listItems reflects promote's real effects. */
function makeBoard() {
  const issues = [];
  let n = 0;
  const stages = new Map();
  const labels = new Map();
  const engine = makeMockEngine({
    createIssue: (title, body) => {
      n += 1;
      issues.push({ number: n, url: `https://github.com/o/r/issues/${n}`, issueNodeId: `node${n}`, title, body });
      return issues[issues.length - 1];
    },
    addIssueToBoard: (url) => ({ itemId: `item-${url.split('/').pop()}` }),
    setStage: (itemId, lane) => { stages.set(itemId, lane); return { ok: true }; },
    setLabels: (issueNumber, ls) => { labels.set(issueNumber, ls); return { ok: true }; },
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
  return engine;
}

test('REAL chain: empty-board snapshot -> promote creates a card -> diff vs live shows it added; the log remembers', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-snappipe-'));
  const engine = makeBoard();

  // Baseline snapshot of the (empty) real board.
  await snapshotTake('baseline', { engine, config: CFG, dir });

  // Real pipeline: TODO.md -> syncRecord -> applyProposals -> promoteApply.
  writeFileSync(join(dir, 'TODO.md'), '- [ ] Wire retry on upload', 'utf8');
  await syncRecord({ dir, config: null, extracted: [{ title: 'Wire retry on upload', source: 'TODO.md' }] });
  const ledger = await readLedger(dir);
  const id = ledger.candidates[0].id;
  const { ledger: mapped } = applyProposals(ledger, [
    { candidateId: id, kind: 'card', title: 'Wire retry on upload', lane: 'Building', owner: 'agent', confidence: 0.95, rationale: 'clear' },
  ], CFG);
  await writeLedger(dir, mapped);
  await promoteApply(null, { engine, config: CFG, staged: false, dir });

  // Diff baseline vs LIVE board: the promoted card appears as added, with its real title.
  const r = await snapshotDiff('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(r.diff.added.map((a) => a.title), ['Wire retry on upload']);
  assert.equal(r.diff.added[0].issueNumber, 1);

  // Take the post-promote snapshot -> the event log records the addition permanently.
  await snapshotTake('after promote', { engine, config: CFG, dir });
  const { entries } = await readLog(dir, 10);
  assert.equal(entries.length, 2); // initial + the change event
  assert.deepEqual(entries[0].added.map((a) => a.title), ['Wire retry on upload']);
});

test('REAL chain: promote-created card carries the lane promote actually set (mock board state flows through)', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-snappipe-'));
  const engine = makeBoard();
  writeFileSync(join(dir, 'TODO.md'), '- [ ] Decide hosting', 'utf8');
  await syncRecord({ dir, config: null, extracted: [{ title: 'Decide hosting', source: 'TODO.md' }] });
  const ledger = await readLedger(dir);
  const id = ledger.candidates[0].id;
  const { ledger: mapped } = applyProposals(ledger, [
    { candidateId: id, kind: 'card', title: 'Decide hosting', lane: 'Ideas', owner: 'human', confidence: 0.9, rationale: 'x' },
  ], CFG);
  await writeLedger(dir, mapped);
  await promoteApply(null, { engine, config: CFG, staged: false, dir });

  await snapshotTake(null, { engine, config: CFG, dir });
  // Live relane (simulating a human move): diff latest vs live must show it as moved.
  const { items } = await engine.listItems();
  engine.calls.length = 0;
  // mutate the mock's stage map via setStage as the real engine would
  await engine.setStage(items[0].itemId, 'Building', {});
  const r = await snapshotDiff('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(r.diff.moved.map((m) => [m.from, m.to]), [['Ideas', 'Building']]);
});
