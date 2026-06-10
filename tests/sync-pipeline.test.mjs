// tests/sync-pipeline.test.mjs — REAL upstream->downstream chain across M3b->M2->M3a.
// No hand-built fixtures at module boundaries (see M3a retrospective): candidates
// are created by syncRecord, mapped by applyProposals, classified by classify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { syncRecord } from '../scripts/board-manager.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';
import { prepareInput, applyProposals } from '../scripts/lib/mapper.mjs';
import { classify } from '../scripts/lib/promote.mjs';

const cfg = { stageOptions: { Ideas: 'o1', Building: 'o2' }, rules: {} };

function seed() {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-pipe-'));
  writeFileSync(join(dir, 'TODO.md'), '- [ ] Wire retry on upload\n- [ ] Decide hosting', 'utf8');
  return dir;
}

test('sync-recorded candidates flow through prepareInput as status:candidate', async () => {
  const dir = seed();
  await syncRecord({ dir, config: null, extracted: [
    { title: 'Wire retry on upload', source: 'TODO.md' },
    { title: 'Decide hosting', source: 'TODO.md' },
  ] });
  const ledger = await readLedger(dir);
  const pkt = prepareInput(ledger, cfg, null);
  assert.equal(pkt.candidates.length, 2); // both unmapped, both visible to the mapper
  assert.ok(pkt.candidates.every((c) => c.candidateId && c.title));
});

test('full chain: syncRecord -> applyProposals -> classify buckets correctly', async () => {
  const dir = seed();
  await syncRecord({ dir, config: null, extracted: [
    { title: 'Wire retry on upload', source: 'TODO.md', note: 'from TODO' },
    { title: 'Decide hosting', source: 'TODO.md' },
  ] });
  let ledger = await readLedger(dir);
  const ids = Object.fromEntries(ledger.candidates.map((c) => [c.title, c.id]));

  // M2: the (real) proposal-application path — one confident card, one low-confidence
  const { ledger: mapped } = applyProposals(ledger, [
    { candidateId: ids['Wire retry on upload'], kind: 'card', title: 'Wire retry on upload', lane: 'Building', owner: 'agent', confidence: 0.95, rationale: 'clear' },
    { candidateId: ids['Decide hosting'], kind: 'card', title: 'Decide hosting', lane: 'Ideas', owner: 'human', confidence: 0.5, rationale: 'fuzzy' },
  ], cfg);

  // M3a: classification of REAL upstream output (threshold default 0.8)
  const plan = classify(mapped, cfg);
  assert.deepEqual(plan.confident.map((c) => c.candidateId), [ids['Wire retry on upload']]);
  assert.deepEqual(plan.uncertain.map((u) => u.candidateId), [ids['Decide hosting']]);
  assert.equal(plan.uncertain[0].reason, 'low-confidence');
});

test('provenance survives the chain: source field intact after mapping', async () => {
  const dir = seed();
  await syncRecord({ dir, config: null, extracted: [{ title: 'Wire retry on upload', source: 'TODO.md#item-1' }] });
  let ledger = await readLedger(dir);
  const id = ledger.candidates[0].id;
  const { ledger: mapped } = applyProposals(ledger, [
    { candidateId: id, kind: 'card', title: 'Wire retry on upload', lane: 'Building', owner: 'agent', confidence: 0.9, rationale: 'x' },
  ], cfg);
  assert.equal(mapped.candidates[0].source, 'TODO.md#item-1'); // M4's reconcile key intact
});
