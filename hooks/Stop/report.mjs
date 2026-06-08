#!/usr/bin/env node
// hooks/Stop/report.mjs
//
// Claude Code Stop hook. Minimal v1: read the payload, exit 0, NEVER block the
// stop. Optionally — and quietly — if the local last-seen board state
// (<cwd>/.github-boards/state.json) was just written (recent change), surface a
// one-line next-actions nudge as non-error feedback. By default (no recent
// change, or no state file) it emits NOTHING. Silence is the default so the hook
// never adds noise to a normal turn.
//
// FORMAT (verified against https://code.claude.com/docs/en/hooks):
//   - Input on stdin: { stop_hook_active, last_assistant_message, cwd, ... }.
//     When stop_hook_active is true, Claude Code is already continuing from a
//     stop hook — we MUST NOT add feedback that could loop.
//   - Stop accepts top-level `decision: "block"` (we never use it) and, for
//     NON-error continue feedback, `hookSpecificOutput.additionalContext` with
//     hookEventName "Stop". We use only the latter, and only when there's signal.
//   - To stay quiet: print nothing, exit 0.
//
// TESTABILITY: `decide(input, deps)` is pure given deps { readState(cwd), now() }.
// It returns { additionalContext } or null. main() is the thin shim.

import { pathToFileURL } from 'node:url';
import { readState as defaultReadStateImpl } from '../../scripts/lib/state.mjs';

// A state write is "recent" if it happened within this window before stop.
const RECENT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Default dependency: read <cwd>/.github-boards/state.json (or null if absent).
 * @param {string} cwd
 * @returns {Promise<object|null>}
 */
export async function defaultReadState(cwd) {
  try {
    return await defaultReadStateImpl(cwd);
  } catch {
    return null; // malformed/unreadable -> treat as no state (degrade)
  }
}

/**
 * PURE-ish decision. Returns a brief next-actions line only when the local board
 * state was written recently (a board op ran this turn); otherwise null. NEVER
 * throws — any failure degrades to null (no feedback).
 *
 * @param {object} input  Stop payload (uses input.cwd, input.stop_hook_active)
 * @param {object} deps   { readState(cwd):Promise<object|null>, now():number }
 * @returns {Promise<{additionalContext:string}|null>}
 */
export async function decide(input, deps = {}) {
  // If we're already inside a stop-hook continuation, stay silent to avoid loops.
  if (input && input.stop_hook_active === true) return null;

  const readState = deps.readState || defaultReadState;
  const now = deps.now || Date.now;
  const cwd = (input && input.cwd) || process.cwd();

  let state;
  try {
    state = await readState(cwd);
  } catch {
    return null;
  }
  if (!state || !state.seenAt) return null;

  const seen = Date.parse(state.seenAt);
  if (!Number.isFinite(seen)) return null;
  if (now() - seen > RECENT_MS) return null; // not recent -> stay quiet

  const itemCount = state.items && typeof state.items === 'object'
    ? Object.keys(state.items).length
    : 0;

  return {
    additionalContext:
      `Board touched this session (${itemCount} card(s) tracked). ` +
      'Next: run `/board summary` to confirm what changed, or `/board queue human` ' +
      'to see what is on your plate.',
  };
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

/** Thin stdin/stdout shim. Never blocks stop. */
export async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw && raw.trim()) input = JSON.parse(raw);
  } catch {
    input = {};
  }

  let decision = null;
  try {
    decision = await decide(input);
  } catch {
    decision = null;
  }

  if (decision && decision.additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: decision.additionalContext,
      },
    }));
  }
  // Quiet by default. Never emit decision:"block". Always exit 0.
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
