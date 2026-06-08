// scripts/lib/state.mjs — last-seen board state helpers.
//
// Three exports:
//   readState(dir)            — read <dir>/.github-boards/state.json; null if missing
//   writeState(dir, snapshot) — write <dir>/.github-boards/state.json; return path
//   diff(prevItems, currItems) — PURE; returns { moved, added, removed }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const STATE_DIR = '.github-boards';
const STATE_FILE = 'state.json';

function statePath(dir) {
  return join(dir, STATE_DIR, STATE_FILE);
}

/**
 * Read <dir>/.github-boards/state.json.
 * Returns the parsed object, or null if the file doesn't exist.
 * Throws a clear error on malformed JSON.
 * @param {string} dir  workspace root (absolute path)
 * @returns {object|null}
 */
export async function readState(dir) {
  const p = statePath(dir);
  let raw;
  try {
    raw = await readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`state.mjs: malformed JSON in ${p}: ${e.message}`);
  }
}

/**
 * Write <dir>/.github-boards/state.json, creating the directory if needed.
 * @param {string} dir       workspace root
 * @param {object} snapshot  plain object to persist
 * @returns {string}  absolute path written
 */
export async function writeState(dir, snapshot) {
  const stateDir = join(dir, STATE_DIR);
  await mkdir(stateDir, { recursive: true });
  const p = join(stateDir, STATE_FILE);
  await writeFile(p, JSON.stringify(snapshot, null, 2), 'utf8');
  return p;
}

/**
 * PURE diff of two item maps.
 * @param {Object.<string|number, {lane:string}>|null} prevItems
 * @param {Object.<string|number, {lane:string}>}      currItems
 * @returns {{ moved: Array<{number,from,to}>, added: number[], removed: number[] }}
 */
export function diff(prevItems, currItems) {
  const prev = prevItems || {};
  const curr = currItems || {};

  const prevKeys = new Set(Object.keys(prev).map(Number));
  const currKeys = new Set(Object.keys(curr).map(Number));

  const moved = [];
  const added = [];
  const removed = [];

  for (const num of currKeys) {
    if (!prevKeys.has(num)) {
      added.push(num);
    } else if (prev[num].lane !== curr[num].lane) {
      moved.push({ number: num, from: prev[num].lane, to: curr[num].lane });
    }
  }

  for (const num of prevKeys) {
    if (!currKeys.has(num)) {
      removed.push(num);
    }
  }

  return { moved, added, removed };
}
