// tests/hooks.test.mjs
// Unit tests for the PURE decision logic of the three Claude Code hooks. The
// hooks' INTEGRATION with Claude Code can't be unit-tested here, but each hook
// factors its decision into a `decide(...)` function with deps injected, which is
// exactly what we test. The thin stdin/stdout `main()` shims are guarded by an
// import.meta.url check so importing the module does NOT run the hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { decide as preToolUseDecide } from '../hooks/PreToolUse/allow-board-script.mjs';
import { decide as sessionStartDecide } from '../hooks/SessionStart/load-board.mjs';
import { decide as stopDecide } from '../hooks/Stop/report.mjs';
import { writeState } from '../scripts/lib/state.mjs';

// ===========================================================================
// PreToolUse — allow-board-script
// ===========================================================================

test('PreToolUse: Bash invoking board-manager.mjs -> allow decision', () => {
  const d = preToolUseDecide({
    tool_name: 'Bash',
    tool_input: { command: 'node "/abs/scripts/board-manager.mjs" summary' },
  });
  assert.ok(d, 'expected a decision');
  assert.equal(d.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(d.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(typeof d.hookSpecificOutput.permissionDecisionReason, 'string');
  assert.ok(d.hookSpecificOutput.permissionDecisionReason.length > 0);
});

test('PreToolUse: Bash invoking board.mjs (the engine) -> allow decision', () => {
  const d = preToolUseDecide({
    tool_name: 'Bash',
    tool_input: { command: 'node scripts/board.mjs doctor' },
  });
  assert.ok(d);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'allow');
});

test('PreToolUse: Bash with ${CLAUDE_PLUGIN_ROOT} path -> allow decision', () => {
  const d = preToolUseDecide({
    tool_name: 'Bash',
    tool_input: { command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/board-manager.mjs" queue human' },
  });
  assert.ok(d);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'allow');
});

test('PreToolUse: Bash to something else -> NO decision (no-op)', () => {
  assert.equal(
    preToolUseDecide({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    null
  );
  assert.equal(
    preToolUseDecide({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
    null
  );
  // A command that merely mentions a similarly-named token must not match.
  assert.equal(
    preToolUseDecide({ tool_name: 'Bash', tool_input: { command: 'echo myboard.mjsx' } }),
    null
  );
});

test('PreToolUse: non-Bash tool -> NO decision (no-op)', () => {
  assert.equal(
    preToolUseDecide({ tool_name: 'Write', tool_input: { file_path: 'board-manager.mjs' } }),
    null
  );
  assert.equal(
    preToolUseDecide({ tool_name: 'Read', tool_input: { file_path: 'scripts/board.mjs' } }),
    null
  );
});

test('PreToolUse: missing/empty input -> NO decision (no-op)', () => {
  assert.equal(preToolUseDecide(null), null);
  assert.equal(preToolUseDecide({}), null);
  assert.equal(preToolUseDecide({ tool_name: 'Bash' }), null);
  assert.equal(preToolUseDecide({ tool_name: 'Bash', tool_input: {} }), null);
});

// ===========================================================================
// SessionStart — load-board
// ===========================================================================

test('SessionStart: no board.json -> NO context (graceful degrade)', async () => {
  let ranSummary = false;
  const d = await sessionStartDecide(
    { cwd: '/some/project' },
    {
      hasBoard: () => false,
      runSummary: async () => { ranSummary = true; return 'should not run'; },
      ensureLedger: async () => ({ candidates: [] }),
      readLedger: async () => ({ candidates: [] }),
    }
  );
  assert.equal(d, null);
  assert.equal(ranSummary, false, 'runSummary must not be called when no board.json');
});

test('SessionStart: board.json present -> context containing the say', async () => {
  const fakeSay = 'Since last time: 1 moved, 0 new, 0 rejected. On your plate: 2 card(s).';
  const d = await sessionStartDecide(
    { cwd: '/some/project' },
    {
      hasBoard: () => true,
      runSummary: async () => fakeSay,
      ensureLedger: async () => ({ candidates: [] }),
      readLedger: async () => ({ candidates: [] }),
    }
  );
  assert.ok(d, 'expected context to be injected');
  assert.ok(d.additionalContext.includes(fakeSay), 'context must contain the summary say');
});

test('SessionStart: board present but summary throws -> NO context (degrade, no noise)', async () => {
  const d = await sessionStartDecide(
    { cwd: '/some/project' },
    {
      hasBoard: () => true,
      runSummary: async () => { throw new Error('gh not authenticated'); },
      ensureLedger: async () => ({ candidates: [] }),
      readLedger: async () => ({ candidates: [] }),
    }
  );
  assert.equal(d, null);
});

test('SessionStart: board present but summary returns empty -> NO context', async () => {
  const dNull = await sessionStartDecide(
    { cwd: '/p' }, { hasBoard: () => true, runSummary: async () => null, ensureLedger: async () => ({ candidates: [] }), readLedger: async () => ({ candidates: [] }) }
  );
  const dBlank = await sessionStartDecide(
    { cwd: '/p' }, { hasBoard: () => true, runSummary: async () => '   ', ensureLedger: async () => ({ candidates: [] }), readLedger: async () => ({ candidates: [] }) }
  );
  assert.equal(dNull, null);
  assert.equal(dBlank, null);
});

test('SessionStart: hasBoard throwing -> NO context (degrade)', async () => {
  const d = await sessionStartDecide(
    { cwd: '/p' },
    { hasBoard: () => { throw new Error('fs blew up'); }, runSummary: async () => 'x', ensureLedger: async () => ({ candidates: [] }), readLedger: async () => ({ candidates: [] }) }
  );
  assert.equal(d, null);
});

// ===========================================================================
// Stop — report
// ===========================================================================

test('Stop: no state file -> NO feedback (quiet)', async () => {
  const d = await stopDecide({ cwd: '/p' }, { readState: async () => null });
  assert.equal(d, null);
});

test('Stop: recent state write -> brief next-actions feedback', async () => {
  const now = Date.parse('2026-06-07T12:00:00.000Z');
  const state = { seenAt: '2026-06-07T11:59:00.000Z', items: { 1: {}, 2: {} } }; // 1 min ago
  const d = await stopDecide(
    { cwd: '/p' },
    { readState: async () => state, now: () => now }
  );
  assert.ok(d, 'expected feedback for a recent board touch');
  assert.ok(/2 card\(s\)/.test(d.additionalContext));
  assert.ok(/\/board summary/.test(d.additionalContext));
});

test('Stop: stale state write -> NO feedback (quiet)', async () => {
  const now = Date.parse('2026-06-07T12:00:00.000Z');
  const state = { seenAt: '2026-06-07T11:00:00.000Z', items: { 1: {} } }; // 1 hour ago
  const d = await stopDecide(
    { cwd: '/p' },
    { readState: async () => state, now: () => now }
  );
  assert.equal(d, null);
});

test('Stop: stop_hook_active -> NO feedback (avoid loops)', async () => {
  const now = Date.parse('2026-06-07T12:00:00.000Z');
  const state = { seenAt: '2026-06-07T11:59:30.000Z', items: { 1: {} } };
  const d = await stopDecide(
    { cwd: '/p', stop_hook_active: true },
    { readState: async () => state, now: () => now }
  );
  assert.equal(d, null);
});

test('Stop: malformed seenAt -> NO feedback (degrade)', async () => {
  const d = await stopDecide(
    { cwd: '/p' },
    { readState: async () => ({ seenAt: 'not-a-date', items: {} }), now: () => Date.now() }
  );
  assert.equal(d, null);
});

test('Stop: default readState reads real .github-boards/state.json (recent)', async () => {
  // Integration-ish: write a real state file, then let the DEFAULT readState dep
  // pick it up via decide()'s injected now().
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-stop-'));
  const seenAt = '2026-06-07T12:00:00.000Z';
  await writeState(dir, { seenAt, items: { 7: { lane: 'Building' } } });
  const now = Date.parse('2026-06-07T12:01:00.000Z'); // 1 min later
  const d = await stopDecide({ cwd: dir }, { now: () => now });
  assert.ok(d, 'expected feedback from the real state file');
  assert.ok(/1 card\(s\)/.test(d.additionalContext));
});
