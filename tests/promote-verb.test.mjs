// tests/promote-verb.test.mjs — promote verb behavior against the mock engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { promotePlan, promoteApply } from '../scripts/board-manager.mjs';
import { ensureLedger, writeLedger, readLedger } from '../scripts/lib/ledger.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-promote-'));
const CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2', Shipped: 'o3' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  rules: { promoteConfidenceBelow: 0.8 },
};

// Seed a ledger with exactly the given candidate objects.
async function seed(dir, candidates) {
  const l = await ensureLedger(dir);
  l.candidates = candidates;
  await writeLedger(dir, l);
}

const mappedCard = (over = {}) => ({ id: 'aaaaaaaaaaaa', title: 'Wire auth', note: 'auth context', source: 'manual', kind: 'card', suggestedLane: 'Building', suggestedOwner: 'agent', confidence: 0.95, status: 'mapped', addedAt: 't', ...over });

const mappedComment = (over = {}) => ({ id: 'dddddddddddd', title: 'note', note: 'see spec', kind: 'comment', commentTarget: 12, confidence: 0.9, status: 'mapped', addedAt: 't', ...over });

test('promotePlan classifies the ledger read-only and reports counts', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard(), mappedCard({ id: 'bbbbbbbbbbbb', title: 'Lowconf', confidence: 0.4 })]);
  const r = await promotePlan({ dir, config: CFG });
  assert.equal(r.plan.confident.length, 1);
  assert.equal(r.plan.uncertain.length, 1);
  assert.match(r.say, /1 confident/);
  // read-only: ledger untouched
  const after = await readLedger(dir);
  assert.equal(after.candidates[0].status, 'mapped');
});

test('promote apply --staged previews only: createIssue(staged) + comment(staged), NO board writes, ledger unchanged', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard(), mappedComment()]);
  const engine = makeMockEngine({
    createIssue: () => ({ staged: true, wouldRun: { op: 'gh issue create' } }),
    comment: () => ({ staged: true, wouldRun: { op: 'gh issue comment' } }),
  });
  const r = await promoteApply(null, { engine, config: CFG, staged: true, dir });

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue', 'comment']); // confident card, then confident comment
  assert.ok(!ops.includes('addIssueToBoard'), 'no addIssueToBoard on a nonexistent staged issue');
  assert.ok(!ops.includes('setStage'));
  assert.ok(!ops.includes('setLabels'));
  // createIssue passed { staged:true }
  assert.equal(engine.calls[0].args.at(-1)?.staged, true);
  // report + say
  assert.equal(r.report.wouldCreate.length, 1);
  assert.equal(r.report.wouldComment.length, 1);
  assert.match(r.say, /staged — nothing written/);
  // ledger untouched
  const after = await readLedger(dir);
  assert.equal(after.candidates[0].status, 'mapped');
  assert.equal(after.candidates[1].status, 'mapped');
});
