// tests/snapshots.test.mjs — M4b snapshot store + event log + pure diff
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { diffSnapshots, stampFor, resolveKeep } from '../scripts/lib/snapshots.mjs';

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
