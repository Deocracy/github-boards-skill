#!/usr/bin/env node
// hooks/SessionStart/load-board.mjs
//
// Claude Code SessionStart hook. On session start/resume the hook injects up to
// three signals as additionalContext so Claude opens the session already aware of
// project state:
//   (1) Board summary — if a board.json is present, runs a read-only `summary`
//       and injects its `say` line describing what changed on the GitHub board.
//   (2) Ledger candidate count — reads (or initialises) the local ledger and
//       reports how many candidates are not yet promoted to the board.
//   (3) Changed watched-source files count (M3b) — runs a read-only `syncScan`
//       (glob + hash + diff, no LLM, no writes) and reports how many watched
//       source files have changed since the last sync.
// Signals that have nothing to report are omitted; if all three are empty the
// hook exits 0 with no context injected.
//
// GRACEFUL DEGRADE (the load-bearing rule): if the board is unreachable (no
// board.json, gh not authed, network down, malformed config — anything), the
// BOARD SUMMARY signal degrades silently; the hook stays silent only when there
// is nothing meaningful to say (no board status, no candidates, no changed
// sources). Ledger and source-change signals fire regardless of board presence —
// a fresh install with no board configured but a populated ledger or changed
// sources still gets those signals. No error noise, always exit 0.
//
// FORMAT (verified against https://code.claude.com/docs/en/hooks):
//   - Input arrives as JSON on stdin: { session_id, cwd, source, hook_event_name, ... }
//   - To inject context, print to stdout:
//       { "hookSpecificOutput": { "hookEventName": "SessionStart",
//                                 "additionalContext": "<text>" } }
//   - To inject nothing, print nothing (and exit 0).
//
// TESTABILITY: the pure decision is `decide(input, deps)` -> { additionalContext }
// or null. `deps` injects { hasBoard(cwd), runSummary(cwd), ensureLedger(cwd),
// readLedger(cwd), scanSources(cwd) } so tests never touch the filesystem, gh,
// or the real engine. main() is the thin stdin/stdout shim.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureLedger as defaultEnsureLedger, readLedger as defaultReadLedger } from '../../scripts/lib/ledger.mjs';
import { readFile } from 'node:fs/promises';

/**
 * Default dependency: does <cwd>/board.json exist?
 * @param {string} cwd
 * @returns {boolean}
 */
export function defaultHasBoard(cwd) {
  if (!cwd || typeof cwd !== 'string') return false;
  try {
    return existsSync(join(cwd, 'board.json'));
  } catch {
    return false;
  }
}

/**
 * Default dependency: run a read-only board summary in <cwd> and return its `say`.
 * Imports the verb layer lazily and builds the real engine the same way the CLI
 * shim does. Any failure (no config, gh error, network) is swallowed by `decide`'s
 * try/catch — this function may throw freely.
 * @param {string} cwd
 * @returns {Promise<string|null>} the summary `say` line, or null
 */
export async function defaultRunSummary(cwd) {
  const { summary } = await import('../../scripts/board-manager.mjs');
  const { loadConfig } = await import('../../scripts/lib/config.mjs');
  const eng = await import('../../scripts/board.mjs');

  const boardJson = join(cwd, 'board.json');
  const engineCfg = eng.loadConfig(boardJson);
  const verbCfg = await loadConfig(engineCfg.__path || boardJson);

  // Build the same real-engine adapter the CLI uses, by re-using its private
  // factory is not possible (not exported); instead we wrap board.mjs's ops with
  // the minimal surface `summary` needs: only listItems(). summary() is read-only
  // toward the board and just persists local state afterward.
  const flags = { staged: false, json: false, config: null, labels: null, identity: 'pat', interval: null, once: false };
  const engine = {
    listItems: () => eng.listItems(engineCfg, flags),
  };

  const result = await summary({ engine, config: verbCfg, staged: false, dir: cwd });
  return result && typeof result.say === 'string' ? result.say : null;
}

/**
 * Default dependency: how many watched source files changed since the last
 * sync? Runs the read-only syncScan (glob + hash + diff — no LLM, no writes).
 * May throw freely; decide() swallows.
 * @param {string} cwd
 * @returns {Promise<number>}
 */
export async function defaultScanSources(cwd) {
  const { syncScan } = await import('../../scripts/board-manager.mjs');
  let rawCfg = null;
  try { rawCfg = JSON.parse(await readFile(join(cwd, 'board.json'), 'utf8')); } catch { rawCfg = null; }
  const r = await syncScan({ dir: cwd, config: rawCfg, maxFiles: 500 });
  return r.manifest.changedFiles.length;
}

/**
 * PURE-ish decision: given the hook input and injected deps, decide what context
 * (if any) to inject. NEVER throws — on any failure it returns null (degrade).
 *
 * @param {object} input  parsed SessionStart payload (uses input.cwd)
 * @param {object} deps   { hasBoard(cwd):boolean, runSummary(cwd):Promise<string|null> }
 * @returns {Promise<{additionalContext:string}|null>}
 */
export async function decide(input, deps = {}) {
  const hasBoard = deps.hasBoard || defaultHasBoard;
  const runSummary = deps.runSummary || defaultRunSummary;
  const ensureLedgerFn = deps.ensureLedger || defaultEnsureLedger;
  const readLedgerFn = deps.readLedger || defaultReadLedger;
  const scanSourcesFn = deps.scanSources || defaultScanSources;

  const cwd = (input && input.cwd) || process.cwd();

  // Tier 0: ALWAYS ensure the ledger exists. Best-effort, never throws.
  let ledger = null;
  try {
    ledger = await ensureLedgerFn(cwd);
  } catch {
    try { ledger = await readLedgerFn(cwd); } catch { ledger = null; }
  }
  const candidateCount = ledger && Array.isArray(ledger.candidates) ? ledger.candidates.length : 0;

  // Board summary (existing behavior), degrade silently on any failure.
  let say = null;
  let boardPresent = false;
  try { boardPresent = hasBoard(cwd); } catch { boardPresent = false; }
  if (boardPresent) {
    try { say = await runSummary(cwd); } catch { say = null; }
  }

  // M3b: changed watched-source files since last sync. Read-only; degrade to 0.
  let changedSources = 0;
  try { changedSources = await scanSourcesFn(cwd); } catch { changedSources = 0; }

  // Compose. Stay silent (return null) only when there's nothing meaningful.
  const parts = [];
  if (say && typeof say === 'string' && say.trim()) parts.push(`GitHub board status: ${say.trim()}`);
  if (candidateCount > 0) parts.push(`github-boards ledger: ${candidateCount} candidate(s) not yet on the board.`);
  if (changedSources > 0) parts.push(`github-boards sources: ${changedSources} source file(s) changed since last sync — run 'sync scan' then 'sync record' to ingest.`);
  if (parts.length === 0) return null;
  return { additionalContext: parts.join(' ') };
}

/**
 * Read all of stdin as a string.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/**
 * Thin stdin/stdout shim. Parses the payload, runs decide(), and emits the
 * verified SessionStart JSON on stdout when there is context to inject.
 */
export async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw && raw.trim()) input = JSON.parse(raw);
  } catch {
    input = {}; // unparseable payload -> fall through to graceful no-op
  }

  let decision = null;
  try {
    decision = await decide(input);
  } catch {
    decision = null; // belt-and-suspenders: decide() already swallows, but never throw
  }

  if (decision && decision.additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: decision.additionalContext,
      },
    }));
  }
  // No context -> print nothing. Always exit 0.
  process.exit(0);
}

// Run as a hook only when invoked directly (not when imported for testing).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
