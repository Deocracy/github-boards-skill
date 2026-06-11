// tests/reconcile-verb.test.mjs — M4a reconcile verbs against the mock engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { makeMockEngine } from './helpers/mock-engine.mjs';
import { reconcileScan } from '../scripts/board-manager.mjs';
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
