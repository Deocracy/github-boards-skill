#!/usr/bin/env node
// hooks/SessionStart/load-board.mjs
//
// Claude Code SessionStart hook. On session start/resume, if the project has a
// board configured (a board.json in the session cwd), run a read-only board
// `summary` and inject its `say` line as additionalContext so Claude opens the
// session already knowing what changed on the board.
//
// GRACEFUL DEGRADE (the load-bearing rule): if there is NO board.json, or the
// board is unreachable (gh not authed, network down, malformed config — anything),
// the hook exits 0 with NO context injected and NO error noise. A fresh install
// with no board configured must never spam every single session start.
//
// FORMAT (verified against https://code.claude.com/docs/en/hooks):
//   - Input arrives as JSON on stdin: { session_id, cwd, source, hook_event_name, ... }
//   - To inject context, print to stdout:
//       { "hookSpecificOutput": { "hookEventName": "SessionStart",
//                                 "additionalContext": "<text>" } }
//   - To inject nothing, print nothing (and exit 0).
//
// TESTABILITY: the pure decision is `decide(input, deps)` -> { additionalContext }
// or null. `deps` injects { hasBoard(cwd), runSummary(cwd) } so tests never touch
// the filesystem, gh, or the real engine. main() is the thin stdin/stdout shim.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

  const cwd = (input && input.cwd) || process.cwd();

  // No board configured -> silent no-op. This is the fresh-install path.
  let boardPresent;
  try {
    boardPresent = hasBoard(cwd);
  } catch {
    return null;
  }
  if (!boardPresent) return null;

  // Board configured -> try a summary, but degrade silently on ANY failure
  // (unreachable board, gh not authed, malformed config, etc.).
  let say;
  try {
    say = await runSummary(cwd);
  } catch {
    return null;
  }
  if (!say || typeof say !== 'string' || say.trim() === '') return null;

  return { additionalContext: `GitHub board status: ${say.trim()}` };
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
