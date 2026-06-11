// tests/reconcile-verb.test.mjs — M4a reconcile verbs against the mock engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { makeMockEngine } from './helpers/mock-engine.mjs';
import { reconcileScan, reconcileApply } from '../scripts/board-manager.mjs';
import { cidMarker } from '../scripts/lib/promote.mjs';
import { ensureLedger, writeLedger, readLedger } from '../scripts/lib/ledger.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-reconcile-'));

test('mock engine records listItemsWithBodies like every other op', async () => {
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });
  const r = await engine.listItemsWithBodies();
  assert.deepEqual(r, { items: [], count: 0 });
  assert.deepEqual(engine.calls.map((c) => c.op), ['listItemsWithBodies']);
});

test('WIRING: board.mjs listItems supports withBodies (body+url in the Issue fragment, conditional)', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'board.mjs'), 'utf8');
  assert.ok(src.includes('withBodies'), 'listItems has no withBodies option');
  assert.match(src, /body url/, 'Issue fragment never gains body url');
});

test('WIRING: makeRealEngine exposes listItemsWithBodies and the DI contract documents it', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'board-manager.mjs'), 'utf8');
  assert.match(src, /listItemsWithBodies:\s*\(\)\s*=>\s*eng\.listItems\(cfg,\s*\{\s*withBodies:\s*true\s*\}\)/);
  assert.match(src, /engine\.listItemsWithBodies\(\)/, 'DI contract header missing the new op');
});

const CFG = { stageOptions: { Ideas: 'o1', Building: 'o2' }, routing: { agent: 'agent:go', human: 'needs-claude' } };
const CID = 'abcabcabcabc';

async function seedLedger(dir, candidates) {
  const l = await ensureLedger(dir);
  l.candidates = candidates;
  await writeLedger(dir, l);
}

const liveItem = (cid, over = {}) => ({
  itemId: 'it-1', issueNumber: 1, title: 'Wire auth', stageLabel: 'Building', labels: [],
  body: `note\n\n${cidMarker(cid)}`, issueUrl: 'https://github.com/o/r/issues/1', ...over,
});

test('reconcileScan: composes engine read + ledger + fs probe into a drift report (read-only)', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'mapped' }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID)], count: 1 }) });

  const { drift, say } = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(drift.safeHeals.length, 1);
  assert.equal(drift.safeHeals[0].kind, 'crash-orphan');
  assert.match(say, /1 safe heal/);
  // read-only: ledger untouched
  assert.equal((await readLedger(dir)).candidates[0].status, 'mapped');
});

test('reconcileScan: clean board says so', async () => {
  const dir = tmp();
  await seedLedger(dir, []);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });
  const { drift, say } = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(drift.clean, true);
  assert.match(say, /clean/i);
});

test('reconcileScan: dead-source probes the real fs relative to dir', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'alive.md'), 'x', 'utf8');
  await seedLedger(dir, [
    { id: 'aaaaaaaaaaa1', title: 'Alive', note: '', source: 'docs/alive.md#t1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
    { id: 'aaaaaaaaaaa2', title: 'Dead', note: '', source: 'docs/dead.md#t1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
  ]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });
  const { drift } = await reconcileScan({ engine, config: CFG, dir });
  assert.deepEqual(drift.uncertain.map((u) => [u.kind, u.title]), [['dead-source', 'Dead']]);
});

test('reconcileScan: a failing live read throws LOUDLY (no silent clean bill)', async () => {
  const dir = tmp();
  await seedLedger(dir, []);
  const engine = makeMockEngine({ listItemsWithBodies: () => { throw new Error('gh: not authed'); } });
  await assert.rejects(() => reconcileScan({ engine, config: CFG, dir }), /not authed/);
});

test('reconcileApply: safe heals auto-apply — crash-orphan settled with adopted refs, ledger persisted', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'mapped' }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID, { issueNumber: 7, itemId: 'it-7', issueUrl: 'u7' })], count: 1 }) });

  const { report, say } = await reconcileApply(null, { engine, config: CFG, dir });
  assert.deepEqual(report.healed, [{ candidateId: CID, issueNumber: 7 }]);
  const after = (await readLedger(dir)).candidates[0];
  assert.equal(after.status, 'promoted');
  assert.deepEqual(after.promotion, { issueNumber: 7, issueUrl: 'u7', itemId: 'it-7' });
  assert.match(say, /1 healed/);
  // LEDGER-ONLY: the engine saw exactly one call — the read.
  assert.deepEqual(engine.calls.map((c) => c.op), ['listItemsWithBodies']);
});

test('reconcileApply: unknown marker adopted as a promoted candidate with the marker cid as id', async () => {
  const dir = tmp();
  await seedLedger(dir, []);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID, { title: 'Orphan card', issueNumber: 3, itemId: 'it-3' })], count: 1 }) });

  const { report } = await reconcileApply(null, { engine, config: CFG, dir });
  assert.equal(report.adopted.length, 1);
  const cand = (await readLedger(dir)).candidates.find((c) => c.id === CID);
  assert.equal(cand.status, 'promoted');
  assert.equal(cand.title, 'Orphan card');
  assert.equal(cand.source, 'reconcile:adopted');
  assert.equal(cand.promotion.issueNumber, 3);
});

test('reconcileApply: re-promote decision resets candidate to mapped and clears promotion', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'promoted', kind: 'card', confidence: 0.9, promotion: { issueNumber: 42, itemId: 'gone' } }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });

  const { report } = await reconcileApply({ [CID]: { action: 're-promote' } }, { engine, config: CFG, dir });
  assert.deepEqual(report.reset, [{ candidateId: CID }]);
  const after = (await readLedger(dir)).candidates[0];
  assert.equal(after.status, 'mapped');
  assert.equal(after.promotion, undefined);
});

test('reconcileApply: dismiss + keep decisions; undecided held', async () => {
  const dir = tmp();
  await seedLedger(dir, [
    { id: 'aaaaaaaaaaa1', title: 'Dead1', note: '', source: 'docs/x.md#1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
    { id: 'aaaaaaaaaaa2', title: 'Dead2', note: '', source: 'docs/y.md#1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
    { id: 'aaaaaaaaaaa3', title: 'Dead3', note: '', source: 'docs/z.md#1', suggestedLane: null, suggestedOwner: null, addedAt: 't', status: 'candidate' },
  ]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });

  const { report } = await reconcileApply(
    { aaaaaaaaaaa1: { action: 'dismiss' }, aaaaaaaaaaa2: { action: 'keep' } },
    { engine, config: CFG, dir },
  );
  assert.deepEqual(report.dismissed, [{ candidateId: 'aaaaaaaaaaa1' }]);
  assert.deepEqual(report.kept, [{ candidateId: 'aaaaaaaaaaa2' }]);
  assert.deepEqual(report.held, ['aaaaaaaaaaa3']);
  const after = await readLedger(dir);
  assert.equal(after.candidates.find((c) => c.id === 'aaaaaaaaaaa1').status, 'dismissed');
  assert.equal(after.candidates.find((c) => c.id === 'aaaaaaaaaaa2').status, 'candidate'); // keep = untouched
});

test('reconcileApply: fail-closed — one bad decision refuses the WHOLE run, ledger untouched', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'mapped' }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID)], count: 1 }) });

  await assert.rejects(
    () => reconcileApply({ ffffffffffff: { action: 'dismiss' } }, { engine, config: CFG, dir }),
    /refused/,
  );
  assert.equal((await readLedger(dir)).candidates[0].status, 'mapped'); // even the safe heal didn't run
});

test('reconcileApply: SELF-EXTINGUISHING — re-scan after apply is clean; re-apply is a no-op', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'mapped' }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID)], count: 1 }) });

  await reconcileApply(null, { engine, config: CFG, dir });
  const rescan = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(rescan.drift.clean, true);
  const again = await reconcileApply(null, { engine, config: CFG, dir });
  assert.equal(again.report.healed.length, 0);
  assert.equal(again.report.adopted.length, 0);
});

test('reconcileApply: duplicates pass through to the report untouched (report-only)', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'promoted', promotion: { issueNumber: 4, itemId: 'it-4' } }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID, { issueNumber: 4, itemId: 'it-4' }), liveItem(CID, { issueNumber: 9, itemId: 'it-9' })], count: 2 }) });

  const { report } = await reconcileApply(null, { engine, config: CFG, dir });
  assert.deepEqual(report.duplicates, [{ cid: CID, issueNumbers: [4, 9], kept: 4 }]);
});

test('reconcileApply: ADOPT is also self-extinguishing — re-scan clean, re-apply adopts nothing', async () => {
  const dir = tmp();
  await seedLedger(dir, []);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID, { title: 'Orphan card', issueNumber: 3, itemId: 'it-3' })], count: 1 }) });

  await reconcileApply(null, { engine, config: CFG, dir });
  const rescan = await reconcileScan({ engine, config: CFG, dir });
  assert.equal(rescan.drift.clean, true);
  const again = await reconcileApply(null, { engine, config: CFG, dir });
  assert.equal(again.report.adopted.length, 0);
  assert.equal((await readLedger(dir)).candidates.length, 1); // still exactly one adopted candidate
});

test('reconcileApply: refuses --staged (scan IS the preview)', async () => {
  const dir = tmp();
  await seedLedger(dir, []);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });
  await assert.rejects(
    () => reconcileApply(null, { engine, config: CFG, staged: true, dir }),
    /scan' IS the preview/,
  );
});

test('reconcileScan/Apply: resume-pending passes through reports; the candidate is untouched', async () => {
  const dir = tmp();
  await seedLedger(dir, [{ id: CID, title: 'Wire auth', note: '', source: 'manual', suggestedLane: 'Building', suggestedOwner: 'agent', addedAt: 't', status: 'mapped', promotion: { issueNumber: 1, issueUrl: 'u1', issueNodeId: 'n1' } }]);
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [liveItem(CID)], count: 1 }) });

  const scan = await reconcileScan({ engine, config: CFG, dir });
  assert.deepEqual(scan.drift.resumePending.map((r) => r.candidateId), [CID]);
  assert.match(scan.say, /resume-pending/);

  const { report, say } = await reconcileApply(null, { engine, config: CFG, dir });
  assert.deepEqual(report.resumePending.map((r) => r.candidateId), [CID]);
  assert.match(say, /resume-pending/);
  const after = (await readLedger(dir)).candidates[0];
  assert.equal(after.status, 'mapped'); // untouched — promote's job
  assert.equal(after.promotion.issueNumber, 1);
});
