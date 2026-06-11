# M4b Time-Travel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the board a memory — versioned snapshots (pruned, dedup'd, captured as a side effect of `summary` + a manual verb) plus an append-only never-pruned event log, with list/diff/log verbs. Read-only: zero board writes.

**Architecture:** New `lib/snapshots.mjs` owns `.github-boards/snapshots/` (snapshot files + `log.jsonl`): write-with-dedup-and-prune, list, ref-resolution, pure `diffSnapshots`, log append/read. `summary` gains a non-fatal piggyback write. Four `snapshot` verbs + CLI on the loadConfig path. `state.mjs` untouched.

**Tech Stack:** Node ≥18 (ESM), `node:test`, no third-party deps. No new live surface (`listItems` is long-shipped).

**Spec:** [docs/superpowers/specs/2026-06-10-m4b-timetravel-design.md](../specs/2026-06-10-m4b-timetravel-design.md)

---

## SAFETY (all roles)
- NEVER set or export `GBS_LIVE=1`; never run live tests (3 pre-existing gated skips stay skipped).
- NEVER run `node --test tests/` bare (MODULE_NOT_FOUND) — specific files or `npm test`.
- NEVER `git push`.

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `scripts/lib/snapshots.mjs` | **New** | Snapshot store + event log. Exports: `diffSnapshots` (pure), `writeSnapshot`, `listSnapshots`, `readSnapshot`, `resolveRef` (pure), `readLog`, `resolveKeep` (pure), `stampFor` (pure). Imports `contentHash` from `./sources.mjs` + node:fs/promises + node:path only. |
| `scripts/board-manager.mjs` | Mod | `summary` piggyback (non-fatal); verbs `snapshotTake`/`snapshotList`/`snapshotDiff`/`snapshotLog`; CLI `snapshot <take\|list\|diff\|log>` in the main switch. |
| `board.example.json` | Mod | Document `"snapshots": { "keep": 50 }`. |
| `tests/snapshots.test.mjs` | **New** | lib unit tests (pure diff, store, refs, log). |
| `tests/snapshot-verb.test.mjs` | **New** | Verb tests (mock engine, temp dirs) incl. summary piggyback + hook tolerance. |
| `tests/snapshot-pipeline.test.mjs` | **New** | Cross-module reality check (promote pipeline → snapshot diff). |

**Conventions:** node:test + assert/strict; temp dirs `mkdtempSync(join(os.tmpdir(), 'gbs-…'))`; imports at top of files, extended not duplicated. Item shape (as `listItems` returns): `{itemId, contentType, issueNumber, title, state, repo, stageLabel, labels[]}`.

**Design detail the spec leaves to the plan:** snapshot filenames derive from the takenAt stamp; two distinct writes in the same millisecond would collide — `writeSnapshot` bumps the stamp by 1ms until the filename is free, and `takenAt` always equals the (possibly bumped) stamp's ISO form, so file order, `takenAt` order, and chronology never disagree.

---

### Task 1: `diffSnapshots` + small pure helpers (`lib/snapshots.mjs`)

**Files:**
- Create: `scripts/lib/snapshots.mjs`
- Test: `tests/snapshots.test.mjs` (new)

- [ ] **Step 1: Write the failing tests.** Create `tests/snapshots.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/snapshots.test.mjs`
Expected: FAIL — `Cannot find module … snapshots.mjs`

- [ ] **Step 3: Implement.** Create `scripts/lib/snapshots.mjs`:

```javascript
// scripts/lib/snapshots.mjs — M4b versioned snapshots + the append-only event log.
//
// Two complementary layers (spec §1):
//   snapshots/   full board states, content-hash-dedup'd, pruned to newest N —
//                restore points ("what did the board look like?")
//   log.jsonl    one compact JSON line per OBSERVED change between consecutive
//                snapshots — append-only, NEVER pruned ("what happened, when?")
//
// Owns <dir>/.github-boards/snapshots/. Mirrors state.mjs/ledger.mjs (fs-only,
// no network). diffSnapshots/resolveRef/resolveKeep/stampFor are pure.

import { readFile, writeFile, mkdir, readdir, unlink, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contentHash } from './sources.mjs';

const SNAP_DIR = ['.github-boards', 'snapshots'];
const LOG_FILE = 'log.jsonl';
const SNAP_RE = /^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;
const DEFAULT_KEEP = 50;

function snapDir(dir) {
  return join(dir, ...SNAP_DIR);
}

/**
 * ISO timestamp made Windows-filename-safe (':' and '.' -> '-').
 * Lexicographic order === chronological order by construction.
 * @param {Date} [date]
 * @returns {string}
 */
export function stampFor(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * config.snapshots.keep when it's a positive integer; DEFAULT_KEEP otherwise
 * (raw-tolerant, like the sources block).
 * @param {object|null} config
 * @returns {number}
 */
export function resolveKeep(config) {
  const k = config && config.snapshots && config.snapshots.keep;
  return Number.isInteger(k) && k > 0 ? k : DEFAULT_KEEP;
}

/** Stable normalization for the dedup hash: itemId-sorted, label-sorted, fixed key set. */
function normalizeForHash(items) {
  return JSON.stringify(
    (items || [])
      .map((i) => ({
        itemId: i.itemId ?? null,
        issueNumber: i.issueNumber ?? null,
        title: i.title ?? null,
        stageLabel: i.stageLabel ?? null,
        labels: [...(i.labels || [])].sort(),
      }))
      .sort((a, b) => String(a.itemId).localeCompare(String(b.itemId))),
  );
}

/**
 * PURE diff of two snapshot item arrays, keyed by itemId. Buckets are
 * independent — one card may appear in moved AND relabeled AND retitled.
 * @param {object[]|null} prevItems
 * @param {object[]|null} currItems
 * @returns {{moved:object[], added:object[], removed:object[], relabeled:object[], retitled:object[]}}
 */
export function diffSnapshots(prevItems, currItems) {
  const prev = new Map((prevItems || []).map((i) => [i.itemId, i]));
  const curr = new Map((currItems || []).map((i) => [i.itemId, i]));
  const moved = [];
  const added = [];
  const removed = [];
  const relabeled = [];
  const retitled = [];

  for (const [id, c] of curr) {
    const p = prev.get(id);
    if (!p) {
      added.push({ itemId: id, issueNumber: c.issueNumber ?? null, title: c.title ?? null });
      continue;
    }
    if ((p.stageLabel ?? null) !== (c.stageLabel ?? null)) {
      moved.push({ itemId: id, issueNumber: c.issueNumber ?? null, title: c.title ?? null, from: p.stageLabel ?? null, to: c.stageLabel ?? null });
    }
    const pl = new Set(p.labels || []);
    const cl = new Set(c.labels || []);
    const addedL = [...cl].filter((l) => !pl.has(l)).sort();
    const removedL = [...pl].filter((l) => !cl.has(l)).sort();
    if (addedL.length || removedL.length) {
      relabeled.push({ itemId: id, issueNumber: c.issueNumber ?? null, title: c.title ?? null, added: addedL, removed: removedL });
    }
    if ((p.title ?? null) !== (c.title ?? null)) {
      retitled.push({ itemId: id, issueNumber: c.issueNumber ?? null, from: p.title ?? null, to: c.title ?? null });
    }
  }
  for (const [id, p] of prev) {
    if (!curr.has(id)) {
      removed.push({ itemId: id, issueNumber: p.issueNumber ?? null, title: p.title ?? null });
    }
  }
  return { moved, added, removed, relabeled, retitled };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/snapshots.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/snapshots.mjs tests/snapshots.test.mjs
git commit -m "feat(m4b): pure snapshot diff + stamp/keep helpers"
```

---

### Task 2: The store — `writeSnapshot` (dedup + log + prune), `listSnapshots`, `readLog`

**Files:**
- Modify: `scripts/lib/snapshots.mjs`
- Test: `tests/snapshots.test.mjs` (append; extend the top import line with `writeSnapshot, listSnapshots, readLog`)

- [ ] **Step 1: Append the failing tests**

```javascript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/snapshots.test.mjs`
Expected: FAIL — `writeSnapshot` not exported

- [ ] **Step 3: Implement** (append to `scripts/lib/snapshots.mjs`):

```javascript
/**
 * List snapshots newest-first (readdir + filename filter + per-file header read).
 * An unreadable snapshot file is listed with label '(unreadable)' rather than
 * hidden — corrupted history must be visible. Missing dir -> [].
 * @param {string} dir
 * @returns {Promise<{file:string, takenAt:string|null, label:string|null, count:number|null}[]>}
 */
export async function listSnapshots(dir) {
  let names;
  try {
    names = await readdir(snapDir(dir));
  } catch {
    return [];
  }
  const files = names.filter((f) => SNAP_RE.test(f)).sort().reverse(); // chrono desc by construction
  const out = [];
  for (const file of files) {
    try {
      const s = JSON.parse(await readFile(join(snapDir(dir), file), 'utf8'));
      out.push({ file, takenAt: s.takenAt ?? null, label: s.label ?? null, count: s.count ?? null });
    } catch {
      out.push({ file, takenAt: null, label: '(unreadable)', count: null });
    }
  }
  return out;
}

/**
 * Write a snapshot — unless the board is unchanged (content-hash dedup vs the
 * newest snapshot). On every NON-skipped write, append one event line to
 * log.jsonl (first ever -> {initial}, else the diff vs the previous newest),
 * then prune snapshot files beyond `keep`. The log is NEVER pruned.
 * Same-millisecond collisions bump the stamp by 1ms until free; takenAt always
 * equals the bumped stamp's ISO form so file order === takenAt order.
 * @param {string} dir
 * @param {object[]} items  listItems-shaped board items
 * @param {{label?:string|null, keep?:number}} [opts]
 * @returns {Promise<{path:string, skipped:false, logged:boolean}|{skipped:true, reason:string}>}
 */
export async function writeSnapshot(dir, items, { label = null, keep = DEFAULT_KEEP } = {}) {
  const d = snapDir(dir);
  await mkdir(d, { recursive: true });

  const itemsHash = contentHash(normalizeForHash(items));
  const existing = (await readdir(d)).filter((f) => SNAP_RE.test(f)).sort().reverse();

  let prevItems;
  if (existing.length) {
    try {
      const newest = JSON.parse(await readFile(join(d, existing[0]), 'utf8'));
      if (newest.itemsHash === itemsHash) {
        return { skipped: true, reason: `unchanged since ${newest.takenAt}` };
      }
      prevItems = newest.items;
    } catch {
      /* unreadable newest -> treat as no-previous (write proceeds, log line is 'initial') */
    }
  }

  // Stamp + collision bump (tight loops can write twice in one millisecond).
  let stampDate = new Date();
  let file = `snapshot-${stampFor(stampDate)}.json`;
  const taken = new Set(existing);
  while (taken.has(file)) {
    stampDate = new Date(stampDate.getTime() + 1);
    file = `snapshot-${stampFor(stampDate)}.json`;
  }
  const takenAt = stampDate.toISOString();

  const snap = { takenAt, label, count: (items || []).length, itemsHash, items: items || [] };
  await writeFile(join(d, file), JSON.stringify(snap, null, 2), 'utf8');

  // Event log: append-only, never pruned. One compact line per observed change.
  const entry = prevItems !== undefined
    ? { at: takenAt, ...diffSnapshots(prevItems, items || []) }
    : { at: takenAt, initial: true, count: (items || []).length };
  await appendFile(join(d, LOG_FILE), `${JSON.stringify(entry)}\n`, 'utf8');

  // Prune snapshot FILES beyond keep (the filename filter can never match log.jsonl
  // or foreign files, so they are structurally safe).
  const k = Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP;
  const after = (await readdir(d)).filter((f) => SNAP_RE.test(f)).sort().reverse();
  for (const old of after.slice(k)) {
    try {
      await unlink(join(d, old));
    } catch {
      /* a vanished file is already pruned */
    }
  }

  return { path: join(d, file), skipped: false, logged: true };
}

/**
 * Read the event log, newest-first, capped at n. Malformed lines (torn writes)
 * are skipped and counted — one bad line must not orphan the journal.
 * Missing log -> empty.
 * @param {string} dir
 * @param {number} [n]
 * @returns {Promise<{entries:object[], skippedLines:number}>}
 */
export async function readLog(dir, n = 20) {
  let raw;
  try {
    raw = await readFile(join(snapDir(dir), LOG_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [], skippedLines: 0 };
    throw e;
  }
  const entries = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      skippedLines += 1;
    }
  }
  entries.reverse();
  return { entries: entries.slice(0, Math.max(0, n)), skippedLines };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/snapshots.test.mjs`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/snapshots.mjs tests/snapshots.test.mjs
git commit -m "feat(m4b): snapshot store — dedup'd writes, 1ms collision bump, prune-safe log.jsonl"
```

---

### Task 3: `resolveRef` + `readSnapshot`

**Files:**
- Modify: `scripts/lib/snapshots.mjs`
- Test: `tests/snapshots.test.mjs` (append; extend imports with `resolveRef, readSnapshot`)

- [ ] **Step 1: Append the failing tests**

```javascript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/snapshots.test.mjs`
Expected: FAIL — `resolveRef` not exported

- [ ] **Step 3: Implement** (append to `scripts/lib/snapshots.mjs`):

```javascript
/**
 * PURE ref resolution over a newest-first listSnapshots() array.
 * Refs: 'latest' (or null) · '~N' 1-based age index · ISO-stamp prefix
 * ('2026-06-10' -> that day's newest; ':'/'.' forms accepted — normalized to
 * the filename's '-' form). Unresolvable -> legible error with nearest stamps.
 * @param {{file:string}[]} snaps  newest-first
 * @param {string|null} ref
 * @returns {{file:string}} the matching entry
 */
export function resolveRef(snaps, ref) {
  if (!snaps || snaps.length === 0) {
    throw new Error('snapshot: no snapshots exist yet — run summary or `snapshot take` first.');
  }
  if (ref == null || ref === 'latest') return snaps[0];

  const ageMatch = /^~(\d+)$/.exec(ref);
  if (ageMatch) {
    const n = Number(ageMatch[1]);
    if (n < 1 || n > snaps.length) {
      throw new Error(`snapshot: ~${n} out of range (1..${snaps.length}).`);
    }
    return snaps[n - 1];
  }

  const norm = String(ref).replace(/[:.]/g, '-');
  const hits = snaps.filter((s) => s.file.startsWith(`snapshot-${norm}`));
  if (hits.length) return hits[0]; // newest matching the prefix

  const nearest = snaps.slice(0, 3).map((s) => s.file).join(', ');
  throw new Error(`snapshot: no snapshot matches '${ref}'. Nearest: ${nearest}`);
}

/**
 * Resolve a ref and read the full snapshot. Malformed JSON errors loudly,
 * NAMING the file — corrupted history must be visible, not skipped.
 * @param {string} dir
 * @param {string|null} ref
 * @returns {Promise<object>} the snapshot {takenAt, label, count, itemsHash, items}
 */
export async function readSnapshot(dir, ref) {
  const snaps = await listSnapshots(dir);
  const hit = resolveRef(snaps, ref);
  const p = join(snapDir(dir), hit.file);
  const raw = await readFile(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`snapshot: ${hit.file} is corrupted (${e.message}).`);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/snapshots.test.mjs`
Expected: PASS (18 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/snapshots.mjs tests/snapshots.test.mjs
git commit -m "feat(m4b): ref resolution (latest/~N/date-prefix) + loud-on-corruption readSnapshot"
```

---

### Task 4: Verbs + `summary` piggyback

**Files:**
- Modify: `scripts/board-manager.mjs`
- Test: `tests/snapshot-verb.test.mjs` (new)

- [ ] **Step 1: Write the failing tests.** Create `tests/snapshot-verb.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/snapshot-verb.test.mjs`
Expected: FAIL — `snapshotTake` not exported

- [ ] **Step 3: Implement in `scripts/board-manager.mjs`.**

(a) Add the lib import with the other lib imports:

```javascript
import { writeSnapshot, listSnapshots, readSnapshot, readLog, diffSnapshots, resolveKeep } from './lib/snapshots.mjs';
```

(b) In `summary`, AFTER the existing step-7 `await writeState(dir, snapshot);` (and before the teamSync block), insert nothing — instead, AFTER the teamSync block and BEFORE the `return`, add:

```javascript
  // 9. M4b: versioned snapshot + event log (non-fatal — history must never
  // break summary, and the session-start hook calls summary).
  let snapNote = '';
  try {
    await writeSnapshot(dir, items || [], { keep: resolveKeep(config) });
  } catch (e) {
    snapNote = ` (snapshot skipped: ${e.message})`;
  }
  say += snapNote;
```

NOTE: `summary` currently builds `say` with `let say;` — confirm; if the return is `return { say, ... }`, this slots right before it. Read the function and place accordingly (the raw `items` from step 1 is in scope).

(c) Add the four verbs after `reconcileApply` (before `ownerOf`):

```javascript
// ===========================================================================
// M4b SNAPSHOTS — versioned board memory: take/list/diff + the event log.
// Read-only toward the board; owns nothing but .github-boards/snapshots/.
// ===========================================================================

/**
 * snapshotTake(label, ctx) — manual save-point. Same dedup/prune/log as the
 * summary piggyback. Loud on failure (user-invoked).
 * @param {string|null} label
 * @param {object} ctx { engine, config, dir }
 * @returns {Promise<{result:object, say:string}>}
 */
export async function snapshotTake(label, ctx) {
  const dir = ctx.dir || process.cwd();
  const { items } = await ctx.engine.listItems();
  const r = await writeSnapshot(dir, items || [], { label: label || null, keep: resolveKeep(ctx.config) });
  const say = r.skipped
    ? `Snapshot skipped — ${r.reason}.`
    : `Snapshot saved: ${(items || []).length} card(s)${label ? ` ("${label}")` : ''}.`;
  return { result: r, say };
}

/**
 * snapshotList(ctx) — newest-first index of stored snapshots. fs-only.
 * @param {object} ctx { dir }
 * @returns {Promise<{snapshots:object[], say:string}>}
 */
export async function snapshotList(ctx) {
  const dir = ctx.dir || process.cwd();
  const snapshots = await listSnapshots(dir);
  const say = snapshots.length
    ? `${snapshots.length} snapshot(s); newest ${snapshots[0].takenAt}${snapshots[0].label ? ` ("${snapshots[0].label}")` : ''}.`
    : 'No snapshots yet — run summary or `snapshot take` first.';
  return { snapshots, say };
}

/**
 * snapshotDiff(refA, refB, ctx) — pure diff between two snapshots, or between
 * a snapshot and the LIVE board when refB is null (one listItems read).
 * @param {string} refA
 * @param {string|null} refB
 * @param {object} ctx { engine, config, dir }
 * @returns {Promise<{diff:object, say:string}>}
 */
export async function snapshotDiff(refA, refB, ctx) {
  const dir = ctx.dir || process.cwd();
  const a = await readSnapshot(dir, refA);
  let bItems;
  let bName;
  if (refB) {
    const b = await readSnapshot(dir, refB);
    bItems = b.items;
    bName = b.takenAt;
  } else {
    const { items } = await ctx.engine.listItems();
    bItems = items || [];
    bName = 'live board';
  }
  const d = diffSnapshots(a.items, bItems);
  const total = d.moved.length + d.added.length + d.removed.length + d.relabeled.length + d.retitled.length;
  const say = total === 0
    ? `No changes between ${a.takenAt} and ${bName}.`
    : `Since ${a.takenAt} (vs ${bName}): ${d.moved.length} moved, ${d.added.length} added, ` +
      `${d.removed.length} removed, ${d.relabeled.length} relabeled, ${d.retitled.length} retitled.`;
  return { diff: d, say };
}

/**
 * snapshotLog(n, ctx) — the last n events from the permanent journal. fs-only.
 * @param {number} n
 * @param {object} ctx { dir }
 * @returns {Promise<{entries:object[], skippedLines:number, say:string}>}
 */
export async function snapshotLog(n, ctx) {
  const dir = ctx.dir || process.cwd();
  const { entries, skippedLines } = await readLog(dir, n);
  const say = entries.length
    ? `${entries.length} event(s)${skippedLines ? ` (${skippedLines} corrupted line(s) skipped)` : ''}.`
    : 'No events recorded yet.';
  return { entries, skippedLines, say };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/snapshot-verb.test.mjs`
Expected: PASS (8 tests)
Also: `node --test tests/summary.test.mjs tests/hooks.test.mjs tests/hooks.ledger.test.mjs` → PASS (piggyback must not regress summary's existing contract or the hook).

- [ ] **Step 5: Commit**

```bash
git add scripts/board-manager.mjs tests/snapshot-verb.test.mjs
git commit -m "feat(m4b): snapshot verbs + non-fatal summary piggyback"
```

---

### Task 5: CLI wiring + example config

**Files:**
- Modify: `scripts/board-manager.mjs` (help + dispatch)
- Modify: `board.example.json`

- [ ] **Step 1: Help text.** After the `reconcile apply` line:

```
  snapshot take ["label"]               manual board save-point (dedup'd)
  snapshot list                         stored snapshots, newest first
  snapshot diff <ref> [<ref2>]          what changed between two points (ref2 omitted = live board)
  snapshot log [N]                      the permanent event journal (default last 20)
```

- [ ] **Step 2: Dispatch** in the main switch, after `case 'reconcile'`:

```javascript
    case 'snapshot': {
      const sub = rest[0];
      if (sub === 'take') {
        const r = await snapshotTake(rest[1] || null, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        return;
      }
      if (sub === 'list' || !sub) {
        const r = await snapshotList({ dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.snapshots, null, 2));
        return;
      }
      if (sub === 'diff') {
        const r = await snapshotDiff(rest[1] || 'latest', rest[2] || null, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.diff, null, 2));
        return;
      }
      if (sub === 'log') {
        const r = await snapshotLog(rest[1] ? Number(rest[1]) : 20, { dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.entries, null, 2));
        return;
      }
      throw new Error('usage: snapshot <take ["label"] | list | diff <ref> [<ref2>] | log [N]>');
    }
```

- [ ] **Step 3: `board.example.json`** — add (sibling of `sources`):

```json
  "snapshots": {
    "keep": 50
  },
```

Validate: `node -e "JSON.parse(require('fs').readFileSync('board.example.json','utf8'));console.log('valid')"`.

- [ ] **Step 4: Verify.** `node scripts/board-manager.mjs --help` → all four snapshot lines. `npm test` → full suite green (3 pre-existing skips).

- [ ] **Step 5: Commit**

```bash
git add scripts/board-manager.mjs board.example.json
git commit -m "feat(m4b): CLI wiring for snapshot take/list/diff/log + example config"
```

---

### Task 6: Cross-module reality check (the standing lesson)

**Files:**
- Test: `tests/snapshot-pipeline.test.mjs` (new)

Snapshots must be fed by REAL pipeline output, not hand-built fixtures: run the existing sync→map→promote chain against the stateful mock board (the `reconcile-pipeline` pattern), snapshot before and after, and assert the diff reflects reality.

- [ ] **Step 1: Write the tests.** Create `tests/snapshot-pipeline.test.mjs`:

```javascript
// tests/snapshot-pipeline.test.mjs — REAL chain: promote pipeline output feeds
// snapshots; the diff must reflect what promote actually did. No hand-built
// snapshot fixtures at the boundary (see MEMORY: reachable states only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { syncRecord, promoteApply, snapshotTake, snapshotDiff } from '../scripts/board-manager.mjs';
import { readLedger, writeLedger } from '../scripts/lib/ledger.mjs';
import { applyProposals } from '../scripts/lib/mapper.mjs';
import { readLog } from '../scripts/lib/snapshots.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  rules: { promoteConfidenceBelow: 0.8 },
};

/** Stateful mock board whose listItems reflects promote's real effects. */
function makeBoard() {
  const issues = [];
  let n = 0;
  const stages = new Map();
  const labels = new Map();
  const engine = makeMockEngine({
    createIssue: (title, body) => {
      n += 1;
      issues.push({ number: n, url: `https://github.com/o/r/issues/${n}`, issueNodeId: `node${n}`, title, body });
      return issues[issues.length - 1];
    },
    addIssueToBoard: (url) => ({ itemId: `item-${url.split('/').pop()}` }),
    setStage: (itemId, lane) => { stages.set(itemId, lane); return { ok: true }; },
    setLabels: (issueNumber, ls) => { labels.set(issueNumber, ls); return { ok: true }; },
    listItems: () => ({
      items: issues.map((i) => ({
        itemId: `item-${i.number}`, contentType: 'Issue', issueNumber: i.number, title: i.title,
        state: 'OPEN', repo: 'o/r',
        stageLabel: stages.get(`item-${i.number}`) ?? null,
        labels: labels.get(i.number) ?? [],
      })),
      count: issues.length,
    }),
  });
  return engine;
}

test('REAL chain: empty-board snapshot -> promote creates a card -> diff vs live shows it added; the log remembers', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-snappipe-'));
  const engine = makeBoard();

  // Baseline snapshot of the (empty) real board.
  await snapshotTake('baseline', { engine, config: CFG, dir });

  // Real pipeline: TODO.md -> syncRecord -> applyProposals -> promoteApply.
  writeFileSync(join(dir, 'TODO.md'), '- [ ] Wire retry on upload', 'utf8');
  await syncRecord({ dir, config: null, extracted: [{ title: 'Wire retry on upload', source: 'TODO.md' }] });
  const ledger = await readLedger(dir);
  const id = ledger.candidates[0].id;
  const { ledger: mapped } = applyProposals(ledger, [
    { candidateId: id, kind: 'card', title: 'Wire retry on upload', lane: 'Building', owner: 'agent', confidence: 0.95, rationale: 'clear' },
  ], CFG);
  await writeLedger(dir, mapped);
  await promoteApply(null, { engine, config: CFG, staged: false, dir });

  // Diff baseline vs LIVE board: the promoted card appears as added, with its real title.
  const r = await snapshotDiff('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(r.diff.added.map((a) => a.title), ['Wire retry on upload']);
  assert.equal(r.diff.added[0].issueNumber, 1);

  // Take the post-promote snapshot -> the event log records the addition permanently.
  await snapshotTake('after promote', { engine, config: CFG, dir });
  const { entries } = await readLog(dir, 10);
  assert.equal(entries.length, 2); // initial + the change event
  assert.deepEqual(entries[0].added.map((a) => a.title), ['Wire retry on upload']);
});

test('REAL chain: promote-created card carries the lane promote actually set (mock board state flows through)', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-snappipe-'));
  const engine = makeBoard();
  writeFileSync(join(dir, 'TODO.md'), '- [ ] Decide hosting', 'utf8');
  await syncRecord({ dir, config: null, extracted: [{ title: 'Decide hosting', source: 'TODO.md' }] });
  const ledger = await readLedger(dir);
  const id = ledger.candidates[0].id;
  const { ledger: mapped } = applyProposals(ledger, [
    { candidateId: id, kind: 'card', title: 'Decide hosting', lane: 'Ideas', owner: 'human', confidence: 0.9, rationale: 'x' },
  ], CFG);
  await writeLedger(dir, mapped);
  await promoteApply(null, { engine, config: CFG, staged: false, dir });

  await snapshotTake(null, { engine, config: CFG, dir });
  // Live relane (simulating a human move): diff latest vs live must show it as moved.
  const { items } = await engine.listItems();
  engine.calls.length = 0;
  // mutate the mock's stage map via setStage as the real engine would
  await engine.setStage(items[0].itemId, 'Building', {});
  const r = await snapshotDiff('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(r.diff.moved.map((m) => [m.from, m.to]), [['Ideas', 'Building']]);
});
```

- [ ] **Step 2: Run**

Run: `node --test tests/snapshot-pipeline.test.mjs`
Expected: PASS (2 tests). A failure = real cross-module contract bug — investigate and report (DONE_WITH_CONCERNS); never bend the test.

- [ ] **Step 3: Full suite + commit**

Run: `npm test` → all pass, 3 pre-existing skips.

```bash
git add tests/snapshot-pipeline.test.mjs
git commit -m "test(m4b): real-chain snapshots — promote output feeds diff + permanent log"
```

---

## Self-Review (run after all tasks)

1. **Spec coverage:** §1/§3 two-layer memory → Tasks 1–2; dedup/prune/1ms-bump/log mechanics (§4) → Task 2; refs + loud corruption (§4/§5) → Task 3; verbs + piggyback tolerance (§4/§5) → Task 4; CLI + `snapshots.keep` (§2/§4) → Task 5; §6.3 reality check → Task 6; §6.4 hook tolerance → Task 4's sabotage test (the hook calls summary). No new live surface (§2) — no live task, by design.
2. **Placeholder scan:** none — complete code in every step.
3. **Type consistency:** `writeSnapshot(dir, items, {label, keep})` / `listSnapshots(dir)` / `readSnapshot(dir, ref)` / `resolveRef(snaps, ref)` / `readLog(dir, n)` / `diffSnapshots(prevItems, currItems)` / `resolveKeep(config)` / `stampFor(date)` used identically across Tasks 1–6; diff buckets `{moved, added, removed, relabeled, retitled}` and log entry `{at, initial?|…diff}` consistent throughout.
