// tests/snapshot-verb.test.mjs — M4b verbs + summary piggyback (mock engine)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { summary, snapshotTake, snapshotList, snapshotDiff, snapshotLog, snapshotInvert } from '../scripts/board-manager.mjs';
import { writeSnapshot, listSnapshots } from '../scripts/lib/snapshots.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-snapverb-'));
const CFG = { stageOptions: { Ideas: 'o1', Building: 'o2' }, routing: { agent: 'agent:go', human: 'needs-claude' } };

const boardItem = (n, over = {}) => ({
  itemId: `it-${n}`, contentType: 'Issue', issueNumber: n, title: `Card ${n}`,
  state: 'OPEN', repo: 'o/r', stageLabel: 'Ideas', labels: ['needs-claude'], ...over,
});

const engineWith = (items) => makeMockEngine({ listItems: () => ({ items, count: items.length }) });

function snapFiles(dir) {
  const p = join(dir, '.github-boards', 'snapshots');
  return existsSync(p) ? readdirSync(p).filter((f) => f.startsWith('snapshot-')) : [];
}

test('summary piggyback: a changed board writes exactly one snapshot; an unchanged board writes none', async () => {
  const dir = tmp();
  const engine = engineWith([boardItem(1)]);
  await summary({ engine, config: CFG, staged: false, dir });
  assert.equal(snapFiles(dir).length, 1);
  await summary({ engine, config: CFG, staged: false, dir }); // same board
  assert.equal(snapFiles(dir).length, 1); // dedup'd
});

test('summary piggyback: a snapshot-store failure does NOT fail summary — say gains a suffix', async () => {
  const dir = tmp();
  // sabotage: a FILE where the snapshots DIR must go -> writeSnapshot's mkdir
  // fails, but .github-boards itself works (writeState is unaffected)
  mkdirSync(join(dir, '.github-boards'), { recursive: true });
  writeFileSync(join(dir, '.github-boards', 'snapshots'), 'not a dir', 'utf8');
  const engine = engineWith([boardItem(1)]);
  const r = await summary({ engine, config: CFG, staged: false, dir });
  assert.match(r.say, /snapshot skipped/i);
  assert.ok(existsSync(join(dir, '.github-boards', 'state.json')), 'writeState must still succeed');
});

test('snapshotTake: stores the label; dedup reports unchanged', async () => {
  const dir = tmp();
  const engine = engineWith([boardItem(1)]);
  const r1 = await snapshotTake('before cleanup', { engine, config: CFG, dir });
  assert.match(r1.say, /before cleanup/);
  const list = await listSnapshots(dir);
  assert.equal(list[0].label, 'before cleanup');
  const r2 = await snapshotTake(null, { engine, config: CFG, dir });
  assert.match(r2.say, /unchanged/);
});

test('snapshotList: newest-first with labels; empty case says so', async () => {
  const dir = tmp();
  const empty = await snapshotList({ dir });
  assert.match(empty.say, /no snapshots/i);
  await writeSnapshot(dir, [boardItem(1)], { label: 'one' });
  await writeSnapshot(dir, [boardItem(1), boardItem(2)], { label: 'two' });
  const r = await snapshotList({ dir });
  assert.equal(r.snapshots.length, 2);
  assert.equal(r.snapshots[0].label, 'two');
  assert.match(r.say, /2 snapshot/);
});

test('snapshotDiff: two refs', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {});
  await writeSnapshot(dir, [boardItem(1, { stageLabel: 'Building' }), boardItem(2)], {});
  const r = await snapshotDiff('~2', '~1', { engine: engineWith([]), config: CFG, dir });
  assert.equal(r.diff.moved.length, 1);
  assert.equal(r.diff.added.length, 1);
  assert.match(r.say, /1 moved/);
  assert.match(r.say, /1 added/);
});

test('snapshotDiff: ref vs LIVE board when ref2 omitted', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {});
  const engine = engineWith([boardItem(1, { labels: ['agent:go'] })]); // relabel live
  const r = await snapshotDiff('latest', null, { engine, config: CFG, dir });
  assert.equal(r.diff.relabeled.length, 1);
  assert.deepEqual(engine.calls.map((c) => c.op), ['listItems']);
});

test('snapshotDiff: identical refs -> empty buckets, "no changes"', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {});
  const r = await snapshotDiff('latest', 'latest', { engine: engineWith([]), config: CFG, dir });
  assert.match(r.say, /no changes/i);
});

test('snapshotLog: renders the last N events newest-first; empty case says so', async () => {
  const dir = tmp();
  const none = await snapshotLog(10, { dir });
  assert.match(none.say, /no events/i);
  await writeSnapshot(dir, [boardItem(1)], {});
  await writeSnapshot(dir, [boardItem(1, { stageLabel: 'Building' })], {});
  const r = await snapshotLog(10, { dir });
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].moved.length, 1); // newest first
  assert.match(r.say, /2 event/);
});

test('snapshotInvert: ref vs live — proposes the inverse move; READ-ONLY (no write ops on engine)', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {}); // Ideas
  const engine = engineWith([boardItem(1, { stageLabel: 'Building' })]); // live: moved
  const r = await snapshotInvert('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(r.ops, [{ op: 'move', itemId: 'it-1', issueNumber: 1, title: 'Card 1', to: 'Ideas' }]);
  assert.deepEqual(r.manual, []);
  assert.match(r.say, /1 op/);
  const writeOps = engine.calls.filter((c) => ['createIssue', 'setStage', 'setLabels', 'removeLabels', 'addIssueToBoard', 'comment'].includes(c.op));
  assert.deepEqual(writeOps, [], 'snapshot invert must never write');
});

test('snapshotInvert: owner flip -> route op; non-owner label change -> manual', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1), boardItem(2)], {});
  const engine = engineWith([
    boardItem(1, { labels: ['agent:go'] }),            // pure owner flip human->agent
    boardItem(2, { labels: ['needs-claude', 'bug'] }), // gained a non-owner label
  ]);
  const r = await snapshotInvert('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(r.ops, [{ op: 'route', itemId: 'it-1', issueNumber: 1, title: 'Card 1', to: 'human' }]);
  assert.equal(r.manual.length, 1);
  assert.match(r.manual[0].reason, /no generic relabel verb/);
});

test('snapshotInvert: identical refs -> nothing to undo', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {});
  const r = await snapshotInvert('latest', 'latest', { engine: engineWith([]), config: CFG, dir });
  assert.deepEqual(r.ops, []);
  assert.deepEqual(r.manual, []);
  assert.match(r.say, /nothing to undo/i);
});

test('snapshotInvert: added card lands in manual — never deletable; say points at the manual list', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {});
  await writeSnapshot(dir, [boardItem(1), boardItem(2)], {});
  const r = await snapshotInvert('~2', '~1', { engine: engineWith([]), config: CFG, dir });
  assert.equal(r.ops.length, 0);
  assert.equal(r.manual.length, 1);
  assert.match(r.manual[0].reason, /never auto-deleted/);
  assert.match(r.say, /manual/i);
});

test('snapshotInvert: direction — refA is the RESTORE TARGET (older ref first); ops point back to refA state', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {});                                  // ~2: Ideas
  await writeSnapshot(dir, [boardItem(1, { stageLabel: 'Building' })], {});      // ~1: Building
  const r = await snapshotInvert('~2', '~1', { engine: engineWith([]), config: CFG, dir });
  assert.deepEqual(r.ops.map((o) => [o.op, o.to]), [['move', 'Ideas']], 'undo must restore the refA (older) lane');
});
