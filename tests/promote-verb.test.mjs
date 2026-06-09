// tests/promote-verb.test.mjs — promote verb behavior against the mock engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { promotePlan } from '../scripts/board-manager.mjs';
import { ensureLedger, writeLedger, readLedger } from '../scripts/lib/ledger.mjs';
// makeMockEngine is used in later tasks (Task 6+); imported here for completeness once promoteApply is exported.
// import { makeMockEngine } from './helpers/mock-engine.mjs';

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
