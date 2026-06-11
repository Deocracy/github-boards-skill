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
 * Single-writer assumed (one CLI/hook invocation at a time) — concurrent calls may race the filename check.
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
