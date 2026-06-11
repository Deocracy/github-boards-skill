// tests/reconcile-pipeline.test.mjs — REAL chain across M3b->M2->M3a->M4a.
// No hand-built fixtures at module boundaries: syncRecord creates candidates,
// applyProposals maps them, promoteApply (mock engine) creates the real marker
// bodies, classifyDrift/reconcileApply detect + heal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { syncRecord, promoteApply, reconcileScan, reconcileApply } from '../scripts/board-manager.mjs';
import { readLedger, writeLedger } from '../scripts/lib/ledger.mjs';
import { applyProposals } from '../scripts/lib/mapper.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  rules: { promoteConfidenceBelow: 0.8 },
};

/** Mock board: createIssue captures real bodies; listItemsWithBodies serves them back. */
function makeBoard() {
  const issues = [];
  let n = 0;
  const engine = makeMockEngine({
    createIssue: (title, body) => {
      n += 1;
      const issue = { number: n, url: `https://github.com/o/r/issues/${n}`, issueNodeId: `node${n}`, title, body };
      issues.push(issue);
      return issue;
    },
    addIssueToBoard: (url) => ({ itemId: `item-${url.split('/').pop()}` }),
    setStage: () => ({ ok: true }),
    setLabels: () => ({ ok: true }),
    listItemsWithBodies: () => ({
      items: issues.map((i) => ({
        itemId: `item-${i.number}`, issueNumber: i.number, title: i.title,
        stageLabel: 'Building', labels: [], body: i.body, issueUrl: i.url,
      })),
      count: issues.length,
    }),
  });
  return { engine, issues };
}

/** Full real pipeline: TODO.md -> syncRecord -> applyProposals -> promoteApply. */
async function pipelineToBoard(dir, engine) {
  writeFileSync(join(dir, 'TODO.md'), '- [ ] Wire retry on upload', 'utf8');
  await syncRecord({ dir, config: null, extracted: [{ title: 'Wire retry on upload', source: 'TODO.md' }] });
  let ledger = await readLedger(dir);
  const id = ledger.candidates[0].id;
  const { ledger: mapped } = applyProposals(ledger, [
    { candidateId: id, kind: 'card', title: 'Wire retry on upload', lane: 'Building', owner: 'agent', confidence: 0.95, rationale: 'clear' },
  ], CFG);
  await writeLedger(dir, mapped);
  await promoteApply(null, { engine, config: CFG, staged: false, dir });
  return id;
}

test('healthy pipeline -> reconcile scan is CLEAN (real marker bodies round-trip)', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-rpipe-'));
  const { engine } = makeBoard();
  await pipelineToBoard(dir, engine);
  const { drift } = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(drift.clean, true);
});

test('CRASH WINDOW healed: revert status+promotion after a real promote -> drift detected -> healed -> clean', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-rpipe-'));
  const { engine } = makeBoard();
  const id = await pipelineToBoard(dir, engine);

  // Simulate the M3a accepted window: issue exists, ledger never settled.
  const ledger = await readLedger(dir);
  const cand = ledger.candidates.find((c) => c.id === id);
  cand.status = 'mapped';
  delete cand.promotion;
  await writeLedger(dir, ledger);

  const scan = await reconcileScan({ engine, config: CFG, dir });
  assert.deepEqual(scan.drift.safeHeals.map((h) => h.kind), ['crash-orphan']);

  await reconcileApply(null, { engine, config: CFG, dir });
  const after = (await readLedger(dir)).candidates.find((c) => c.id === id);
  assert.equal(after.status, 'promoted');
  assert.equal(after.promotion.issueNumber, 1);

  const rescan = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(rescan.drift.clean, true);
});

test('VANISHED -> re-promote -> real promote re-creates with the SAME cid marker', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-rpipe-'));
  const board = makeBoard();
  const id = await pipelineToBoard(dir, board.engine);

  // Card deleted upstream: empty the mock board.
  board.issues.length = 0;

  const scan = await reconcileScan({ engine: board.engine, config: CFG, dir });
  assert.deepEqual(scan.drift.uncertain.map((u) => u.kind), ['vanished']);

  await reconcileApply({ [id]: { action: 're-promote' } }, { engine: board.engine, config: CFG, dir });
  assert.equal((await readLedger(dir)).candidates.find((c) => c.id === id).status, 'mapped');

  // The normal promote pipeline re-creates the card — with the same cid marker.
  await promoteApply(null, { engine: board.engine, config: CFG, staged: false, dir });
  assert.equal(board.issues.length, 1);
  assert.ok(board.issues[0].body.includes(id), 're-created issue must carry the SAME cid marker');

  const rescan = await reconcileScan({ engine: board.engine, config: CFG, dir });
  assert.equal(rescan.drift.clean, true);
});
