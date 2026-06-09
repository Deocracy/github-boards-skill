// tests/map-verb.test.mjs — map prepare/record verb behavior
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { mapPrepare, mapRecord } from '../scripts/board-manager.mjs';
import { ensureLedger, appendCandidate, readLedger } from '../scripts/lib/ledger.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-map-'));
const cfg = { stageOptions: { Ideas: 'o1', Building: 'o2' }, rules: { maxLanes: 4 } };

test('mapPrepare returns a packet of unmapped candidates for the configured lanes', async () => {
  const dir = tmp();
  await ensureLedger(dir);
  await appendCandidate(dir, { title: 'Wire auth' });
  const pkt = await mapPrepare({ dir, config: cfg, session: 'building login' });
  assert.equal(pkt.candidates.length, 1);
  assert.deepEqual(pkt.allowedLanes, ['Ideas', 'Building']);
  assert.equal(pkt.session, 'building login');
});

test('mapRecord validates + enriches the ledger and persists, returning a report', async () => {
  const dir = tmp();
  await ensureLedger(dir);
  await appendCandidate(dir, { title: 'Wire auth' });
  const { candidates } = await readLedger(dir);
  const id = candidates[0].id;
  const r = await mapRecord({ dir, config: cfg, proposals: [
    { candidateId: id, kind: 'card', title: 'Wire auth', lane: 'Building', owner: 'agent', confidence: 0.9, rationale: 'core' },
  ] });
  assert.equal(r.report.mapped.length, 1);
  const after = await readLedger(dir);
  assert.equal(after.candidates[0].status, 'mapped');
  assert.equal(after.candidates[0].suggestedLane, 'Building');
});

test('mapRecord surfaces needs-decision questions without mapping them', async () => {
  const dir = tmp();
  await ensureLedger(dir);
  await appendCandidate(dir, { title: 'Ambiguous thing' });
  const id = (await readLedger(dir)).candidates[0].id;
  const r = await mapRecord({ dir, config: cfg, proposals: [
    { candidateId: id, kind: 'card', title: 'Ambiguous thing', lane: 'Ideas', owner: 'human', confidence: 0.3, needsDecision: { question: 'Lane?', options: ['Ideas', 'Building'] } },
  ] });
  assert.equal(r.questions.length, 1);
  assert.equal((await readLedger(dir)).candidates[0].status, 'needs-decision');
});
