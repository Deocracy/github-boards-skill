// tests/snapshots.test.mjs — M4b snapshot store + event log + pure diff
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { diffSnapshots, stampFor, resolveKeep, writeSnapshot, listSnapshots, readLog, resolveRef, readSnapshot } from '../scripts/lib/snapshots.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-snap-'));

const item = (id, over = {}) => ({
  itemId: `it-${id}`, contentType: 'Issue', issueNumber: id, title: `Card ${id}`,
  state: 'OPEN', repo: 'o/r', stageLabel: 'Ideas', labels: ['needs-claude'], ...over,
});

test('diffSnapshots: moved — stageLabel change carries from/to', () => {
  const d = diffSnapshots([item(1)], [item(1, { stageLabel: 'Building' })]);
  assert.deepEqual(d.moved, [{ itemId: 'it-1', issueNumber: 1, title: 'Card 1', from: 'Ideas', to: 'Building' }]);
  assert.equal(d.added.length + d.removed.length + d.relabeled.length + d.retitled.length, 0);
});

test('diffSnapshots: relabeled — label SET change, order-insensitive', () => {
  const d = diffSnapshots(
    [item(1, { labels: ['a', 'b'] })],
    [item(1, { labels: ['b', 'c'] })],
  );
  assert.deepEqual(d.relabeled, [{ itemId: 'it-1', issueNumber: 1, title: 'Card 1', added: ['c'], removed: ['a'] }]);
  // same labels, different order -> NOT relabeled
  const d2 = diffSnapshots([item(1, { labels: ['x', 'y'] })], [item(1, { labels: ['y', 'x'] })]);
  assert.equal(d2.relabeled.length, 0);
});

test('diffSnapshots: retitled', () => {
  const d = diffSnapshots([item(1)], [item(1, { title: 'Card 1 renamed' })]);
  assert.deepEqual(d.retitled, [{ itemId: 'it-1', issueNumber: 1, from: 'Card 1', to: 'Card 1 renamed' }]);
});

test('diffSnapshots: added/removed keyed by itemId', () => {
  const d = diffSnapshots([item(1)], [item(2)]);
  assert.deepEqual(d.added, [{ itemId: 'it-2', issueNumber: 2, title: 'Card 2' }]);
  assert.deepEqual(d.removed, [{ itemId: 'it-1', issueNumber: 1, title: 'Card 1' }]);
});

test('diffSnapshots: a card can be in several buckets (moved AND relabeled AND retitled)', () => {
  const d = diffSnapshots(
    [item(1)],
    [item(1, { stageLabel: 'Building', labels: ['agent:go'], title: 'New title' })],
  );
  assert.equal(d.moved.length, 1);
  assert.equal(d.relabeled.length, 1);
  assert.equal(d.retitled.length, 1);
});

test('diffSnapshots: identical inputs -> all buckets empty; null/empty tolerated', () => {
  const d = diffSnapshots([item(1)], [item(1)]);
  assert.deepEqual(d, { moved: [], added: [], removed: [], relabeled: [], retitled: [] });
  assert.deepEqual(diffSnapshots(null, []), { moved: [], added: [], removed: [], relabeled: [], retitled: [] });
});

test('stampFor: Windows-safe (no colon/dot), chronologically sortable', () => {
  const s = stampFor(new Date('2026-06-10T14:30:05.123Z'));
  assert.equal(s, '2026-06-10T14-30-05-123Z');
  assert.ok(stampFor(new Date('2026-06-10T14:30:05.124Z')) > s);
});

test('resolveKeep: positive integer honored; everything else -> 50', () => {
  assert.equal(resolveKeep({ snapshots: { keep: 10 } }), 10);
  assert.equal(resolveKeep({ snapshots: { keep: 0 } }), 50);
  assert.equal(resolveKeep({ snapshots: { keep: 'lots' } }), 50);
  assert.equal(resolveKeep({}), 50);
  assert.equal(resolveKeep(null), 50);
});

test('writeSnapshot: round-trip — file written, listSnapshots reads it back newest-first', async () => {
  const dir = tmp();
  const r1 = await writeSnapshot(dir, [item(1)], {});
  assert.equal(r1.skipped, false);
  assert.equal(r1.logged, true);
  const r2 = await writeSnapshot(dir, [item(1), item(2)], { label: 'two cards' });
  assert.equal(r2.skipped, false);
  const list = await listSnapshots(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0].label, 'two cards'); // newest first
  assert.equal(list[0].count, 2);
  assert.equal(list[1].label, null);
});

test('writeSnapshot: DEDUP — identical board skips (no file, no log line)', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [item(1)], {});
  const filesBefore = readdirSync(join(dir, '.github-boards', 'snapshots'));
  const r = await writeSnapshot(dir, [item(1)], {});
  assert.equal(r.skipped, true);
  assert.match(r.reason, /unchanged/);
  const filesAfter = readdirSync(join(dir, '.github-boards', 'snapshots'));
  assert.deepEqual(filesAfter, filesBefore);
});

test('writeSnapshot: dedup is label-order-insensitive (same board, shuffled labels -> skip)', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [item(1, { labels: ['a', 'b'] })], {});
  const r = await writeSnapshot(dir, [item(1, { labels: ['b', 'a'] })], {});
  assert.equal(r.skipped, true);
});

test('writeSnapshot: same-millisecond writes get distinct filenames (1ms bump), takenAt matches the stamp', async () => {
  const dir = tmp();
  // distinct boards in a tight loop — filename collisions WILL happen without the bump
  for (let i = 1; i <= 5; i++) {
    const r = await writeSnapshot(dir, [item(i)], {});
    assert.equal(r.skipped, false);
  }
  const list = await listSnapshots(dir);
  assert.equal(list.length, 5);
  const files = list.map((s) => s.file);
  assert.equal(new Set(files).size, 5, 'filenames must be unique');
  // takenAt mirrors the (possibly bumped) stamp: file order === takenAt order
  const taken = list.map((s) => s.takenAt);
  assert.deepEqual([...taken].sort().reverse(), taken);
});

test('writeSnapshot: PRUNE to keep — oldest snapshot files deleted; log.jsonl and foreign files survive', async () => {
  const dir = tmp();
  for (let i = 1; i <= 6; i++) await writeSnapshot(dir, [item(i)], { keep: 3 });
  const snapdir = join(dir, '.github-boards', 'snapshots');
  writeFileSync(join(snapdir, 'foreign.txt'), 'mine', 'utf8');
  await writeSnapshot(dir, [item(99)], { keep: 3 });
  const list = await listSnapshots(dir);
  assert.equal(list.length, 3);
  assert.ok(existsSync(join(snapdir, 'foreign.txt')), 'foreign files never touched');
  assert.ok(existsSync(join(snapdir, 'log.jsonl')), 'log is never pruned');
  // log has all 7 events even though only 3 snapshots remain
  const { entries } = await readLog(dir, 100);
  assert.equal(entries.length, 7);
});

test('event log: first write -> initial line; subsequent -> diff lines, newest-first via readLog', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [item(1)], {});
  await writeSnapshot(dir, [item(1, { stageLabel: 'Building' })], {});
  const { entries, skippedLines } = await readLog(dir, 10);
  assert.equal(skippedLines, 0);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].initial, true);            // oldest = initial baseline
  assert.equal(entries[0].moved.length, 1);          // newest = the move event
  assert.equal(entries[0].moved[0].to, 'Building');
  assert.ok(entries[0].at);
});

test('readLog: malformed lines are skipped and counted, never fatal; n caps the result', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [item(1)], {});
  await writeSnapshot(dir, [item(2)], {});
  await writeSnapshot(dir, [item(3)], {});
  const logPath = join(dir, '.github-boards', 'snapshots', 'log.jsonl');
  writeFileSync(logPath, readFileSync(logPath, 'utf8') + '{torn line\n', 'utf8');
  const { entries, skippedLines } = await readLog(dir, 2);
  assert.equal(skippedLines, 1);
  assert.equal(entries.length, 2); // capped
});

test('readLog: no log yet -> empty, not an error', async () => {
  const dir = tmp();
  assert.deepEqual(await readLog(dir, 10), { entries: [], skippedLines: 0 });
});

test('writeSnapshot: unreadable newest snapshot -> write proceeds, log line is initial (dedup impossible)', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [item(1)], {});
  const snapdir = join(dir, '.github-boards', 'snapshots');
  const newest = readdirSync(snapdir).filter((f) => f.startsWith('snapshot-')).sort().reverse()[0];
  writeFileSync(join(snapdir, newest), '{not json', 'utf8');
  const r = await writeSnapshot(dir, [item(1)], {}); // same board — but dedup can't see through corruption
  assert.equal(r.skipped, false);
  const { entries } = await readLog(dir, 10);
  assert.equal(entries[0].initial, true); // newest log line restarts the baseline
});

test('listSnapshots: corrupt snapshot file listed as (unreadable), never hidden', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [item(1)], { label: 'good' });
  await writeSnapshot(dir, [item(2)], { label: 'bad-to-be' });
  const snapdir = join(dir, '.github-boards', 'snapshots');
  const newest = readdirSync(snapdir).filter((f) => f.startsWith('snapshot-')).sort().reverse()[0];
  writeFileSync(join(snapdir, newest), 'truncated', 'utf8');
  const list = await listSnapshots(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0].label, '(unreadable)');
  assert.equal(list[0].takenAt, null);
  assert.equal(list[1].label, 'good');
});

test('resolveRef: latest / ~N / date-prefix; legible errors otherwise', () => {
  const snaps = [
    { file: 'snapshot-2026-06-10T14-00-00-000Z.json', takenAt: '2026-06-10T14:00:00.000Z', label: null, count: 1 },
    { file: 'snapshot-2026-06-10T09-00-00-000Z.json', takenAt: '2026-06-10T09:00:00.000Z', label: 'morning', count: 1 },
    { file: 'snapshot-2026-06-09T18-00-00-000Z.json', takenAt: '2026-06-09T18:00:00.000Z', label: null, count: 1 },
  ];
  assert.equal(resolveRef(snaps, 'latest').file, snaps[0].file);
  assert.equal(resolveRef(snaps, null).file, snaps[0].file);
  assert.equal(resolveRef(snaps, '~1').file, snaps[0].file);
  assert.equal(resolveRef(snaps, '~3').file, snaps[2].file);
  assert.equal(resolveRef(snaps, '2026-06-09').file, snaps[2].file);     // that day's newest
  assert.equal(resolveRef(snaps, '2026-06-10').file, snaps[0].file);     // newest of two
  assert.equal(resolveRef(snaps, '2026-06-10T09').file, snaps[1].file);  // longer prefix narrows
  assert.equal(resolveRef(snaps, '2026-06-10T09:00').file, snaps[1].file); // ':' form accepted
  assert.equal(resolveRef(snaps, '2026-06-10T09-00-00.000').file, snaps[1].file); // '.' form accepted
  assert.throws(() => resolveRef(snaps, '~4'), /out of range \(1\.\.3\)/);
  assert.throws(() => resolveRef(snaps, '~0'), /out of range/);
  assert.throws(() => resolveRef(snaps, '2030-01-01'), /no snapshot matches/);
  assert.throws(() => resolveRef([], 'latest'), /no snapshots exist yet/);
});

test('readSnapshot: resolves a ref and returns the full snapshot; malformed file errors NAMING the file', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [item(1)], { label: 'good' });
  const snap = await readSnapshot(dir, 'latest');
  assert.equal(snap.label, 'good');
  assert.equal(snap.items.length, 1);

  // corrupt it
  const list = await listSnapshots(dir);
  const p = join(dir, '.github-boards', 'snapshots', list[0].file);
  writeFileSync(p, '{not json', 'utf8');
  await assert.rejects(() => readSnapshot(dir, 'latest'), new RegExp(list[0].file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('writeSnapshot: duplicate itemIds collapse (last-wins) — no ghost snapshot, count honest', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [item(1)], {});
  const r = await writeSnapshot(dir, [item(1), item(1)], {}); // same card twice
  assert.equal(r.skipped, true, 'dup-inflated board is the same board');
});

test('writeSnapshot: failed log append rolls back the snapshot file — retry still records the event', async () => {
  const dir = tmp();
  const snapdir = join(dir, '.github-boards', 'snapshots');
  mkdirSync(join(snapdir, 'log.jsonl'), { recursive: true }); // a DIR where the log FILE goes -> appendFile throws
  await assert.rejects(() => writeSnapshot(dir, [item(1)], {}));
  assert.equal(readdirSync(snapdir).filter((f) => f.startsWith('snapshot-')).length, 0, 'orphan snapshot must not survive');
  rmdirSync(join(snapdir, 'log.jsonl'));
  const r = await writeSnapshot(dir, [item(1)], {});
  assert.equal(r.skipped, false);
  const { entries } = await readLog(dir, 10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].initial, true);
});
