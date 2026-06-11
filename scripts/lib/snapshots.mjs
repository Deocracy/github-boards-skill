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
