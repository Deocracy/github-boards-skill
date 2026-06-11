// tests/snapshot-verb.test.mjs — M4b verbs + summary piggyback (mock engine)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { summary, snapshotTake, snapshotList, snapshotDiff, snapshotLog } from '../scripts/board-manager.mjs';
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
  // sabotage: a FILE where the snapshots DIR must go -> mkdir fails
  writeFileSync(join(dir, '.github-boards'), 'not a dir', 'utf8');
  const engine = engineWith([boardItem(1)]);
  const r = await summary({ engine, config: CFG, staged: false, dir });
  assert.match(r.say, /snapshot skipped/i);
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
