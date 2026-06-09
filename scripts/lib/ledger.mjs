// scripts/lib/ledger.mjs — Tier-0 intent ledger helpers.
//
// Mirrors state.mjs. The ledger is gitignored working state at
// <dir>/.github-boards/ledger.json. It records (a) board INTENT (does this
// project want a board? which one, if bound? push/pull policy) and (b)
// CANDIDATE items collected before they are committed to a board.
//
//   ensureLedger(dir)            — create-if-absent → return the ledger
//   readLedger(dir)              — read; null if missing; throws on bad JSON
//   appendCandidate(dir, item)   — add a candidate (deduped by content hash)
//   setIntent(dir, partial)      — shallow-merge into ledger.intent
//   candidateId(title)           — stable 12-char content hash (dedup key)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const LEDGER_DIR = '.github-boards';
const LEDGER_FILE = 'ledger.json';

function ledgerPath(dir) {
  return join(dir, LEDGER_DIR, LEDGER_FILE);
}

function defaultLedger() {
  return {
    ledgerVersion: 1,
    createdAt: new Date().toISOString(),
    intent: {
      wantsBoard: null,
      boundBoard: null,
      pushPolicy: 'on-approval',
      pullCadence: 'session-start',
    },
    candidates: [],
  };
}

/**
 * Stable dedup key for a candidate: lowercased/trimmed title -> 12 hex chars.
 * @param {string} title
 * @returns {string}
 */
export function candidateId(title) {
  return createHash('sha256').update(String(title).trim().toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * Read <dir>/.github-boards/ledger.json. null if absent; throws on bad JSON.
 * @param {string} dir
 * @returns {Promise<object|null>}
 */
export async function readLedger(dir) {
  const p = ledgerPath(dir);
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
    throw new Error(`ledger.mjs: malformed JSON in ${p}: ${e.message}`);
  }
}

async function writeLedger(dir, ledger) {
  const d = join(dir, LEDGER_DIR);
  await mkdir(d, { recursive: true });
  const p = join(d, LEDGER_FILE);
  await writeFile(p, JSON.stringify(ledger, null, 2), 'utf8');
  return p;
}

/**
 * Create the ledger if absent; otherwise return the existing one (idempotent).
 * @param {string} dir
 * @returns {Promise<object>}
 */
export async function ensureLedger(dir) {
  const existing = await readLedger(dir);
  if (existing) return existing;
  const fresh = defaultLedger();
  await writeLedger(dir, fresh);
  return fresh;
}

/**
 * Append a candidate, deduped by content hash. Returns the updated ledger.
 * @param {string} dir
 * @param {{title:string, note?:string, source?:string, suggestedLane?:string|null, suggestedOwner?:string|null, id?:string}} candidate
 * @returns {Promise<object>}
 */
export async function appendCandidate(dir, candidate) {
  if (!candidate || !candidate.title) {
    throw new Error('appendCandidate: candidate.title is required');
  }
  const ledger = (await readLedger(dir)) || defaultLedger();
  const id = candidate.id || candidateId(candidate.title);
  if (ledger.candidates.some((c) => c.id === id)) {
    return ledger; // dedup: identical content already present
  }
  ledger.candidates.push({
    id,
    title: candidate.title,
    note: candidate.note || '',
    source: candidate.source || 'unknown',
    suggestedLane: candidate.suggestedLane ?? null,
    suggestedOwner: candidate.suggestedOwner ?? null,
    addedAt: new Date().toISOString(),
    status: 'candidate',
  });
  await writeLedger(dir, ledger);
  return ledger;
}

/**
 * Shallow-merge `partial` into ledger.intent and persist.
 * @param {string} dir
 * @param {object} partial
 * @returns {Promise<object>}
 */
export async function setIntent(dir, partial) {
  const ledger = (await readLedger(dir)) || defaultLedger();
  ledger.intent = { ...ledger.intent, ...partial };
  await writeLedger(dir, ledger);
  return ledger;
}
