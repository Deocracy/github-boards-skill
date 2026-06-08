#!/usr/bin/env node
// hooks/PreToolUse/allow-board-script.mjs
//
// Claude Code PreToolUse hook. ONLY job: fast-path (auto-approve) Bash calls that
// invoke this plugin's board scripts, so a `/board` run or an unattended session
// never hangs on an interactive permission prompt for its own helper script.
//
// CRITICAL SCOPE: this hook fast-paths the board script and NOTHING else.
//   - tool_name === 'Bash' AND the command runs board-manager.mjs / board.mjs
//       -> ALLOW (permissionDecision: "allow")
//   - any other Bash command  -> NO decision (no-op; let normal permissions decide)
//   - any non-Bash tool       -> NO decision (no-op)
// It NEVER denies and NEVER allows anything but the board script. A no-op means
// "I have no opinion" — Claude Code's normal permission flow proceeds unchanged.
//
// FORMAT (verified against https://code.claude.com/docs/en/hooks):
//   - Input on stdin: { tool_name, tool_input, hook_event_name, ... }.
//     For Bash, tool_input.command holds the shell string.
//   - To allow: print
//       { "hookSpecificOutput": { "hookEventName": "PreToolUse",
//                                 "permissionDecision": "allow",
//                                 "permissionDecisionReason": "<why>" } }
//   - To no-op: print nothing and exit 0.

import { pathToFileURL } from 'node:url';

// Matches an invocation of the board scripts anywhere in the command string,
// e.g. `node "/abs/scripts/board-manager.mjs" summary` or `node scripts/board.mjs doctor`.
// Word-boundary-ish: the filename must be preceded by a path separator, quote, or
// whitespace so we don't match an unrelated token that merely ends in the name.
const BOARD_SCRIPT_RE = /(^|[\s"'\/\\])(board-manager|board)\.mjs(["'\s]|$)/;

/**
 * PURE decision. Given a PreToolUse payload, return the allow decision object
 * when (and only when) it's a Bash call invoking a board script; otherwise null.
 *
 * @param {object} input  { tool_name, tool_input: { command }, ... }
 * @returns {{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',permissionDecisionReason:string}}|null}
 */
export function decide(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.tool_name !== 'Bash') return null;

  const command = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : '';
  if (!command || !BOARD_SCRIPT_RE.test(command)) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason:
        'github-boards: auto-approving the plugin board script so /board and ' +
        'unattended runs do not hang on a permission prompt.',
    },
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

/** Thin stdin/stdout shim. */
export async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw && raw.trim()) input = JSON.parse(raw);
  } catch {
    input = {}; // unparseable -> no-op
  }

  let decision = null;
  try {
    decision = decide(input);
  } catch {
    decision = null;
  }

  if (decision) {
    process.stdout.write(JSON.stringify(decision));
  }
  // No decision -> print nothing (no-op). Always exit 0; never block.
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
