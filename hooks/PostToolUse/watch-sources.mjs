#!/usr/bin/env node
// hooks/PostToolUse/watch-sources.mjs
//
// Claude Code PostToolUse hook (matcher: Write|Edit|MultiEdit|NotebookEdit).
// M3c: the mid-session change signal. When a tool writes a file that the M3b
// source profiles WATCH, inject a one-line note so Claude learns about the
// new work on the next turn — once per file per session (anti-spam memory in
// .github-boards/announced.json, keyed by session_id).
//
// STATELESS SIGNAL, NOT A QUEUE: ledger.sources hash-diff (M3b) is the durable
// change record; an ignored note is re-flagged at the next session-start scan.
// This hook asserts nothing about sync state, so it can never disagree with it.
//
// GRACEFUL DEGRADE (load-bearing, as in SessionStart/load-board.mjs): never
// throws, always exits 0, observation-only — it never blocks or modifies the
// tool call. Any fs failure degrades to a missed (or duplicate) note, never
// noise or a broken tool call.
//
// FORMAT (verified against https://code.claude.com/docs/en/hooks):
//   - stdin: { session_id, cwd, hook_event_name, tool_name, tool_input, ... }
//     Write/Edit use tool_input.file_path; NotebookEdit uses notebook_path.
//   - to inject: { "hookSpecificOutput": { "hookEventName": "PostToolUse",
//                                          "additionalContext": "<text>" } }
//   - to inject nothing: print nothing (and exit 0).
//   - The note is phrased as a factual statement (not an imperative system
//     command) per the docs' prompt-injection guidance.

import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchesWatch } from '../../scripts/lib/sources.mjs';

const ANNOUNCED_DIR = '.github-boards';
const ANNOUNCED_FILE = 'announced.json';

/**
 * Default dependency: active profiles for this cwd (presence detection + raw
 * board.json sources block) — identical activation to M3b's scan paths.
 * Lazy-imports the verb layer so the no-match fast path stays cheap.
 * May throw freely; decide() swallows.
 * @param {string} cwd
 * @returns {Promise<object[]>}
 */
export async function defaultGetProfiles(cwd) {
  const { presentDetectDirs } = await import('../../scripts/board-manager.mjs');
  const { detectProfiles } = await import('../../scripts/lib/sources.mjs');
  const { readFile } = await import('node:fs/promises');
  let rawCfg = null;
  try { rawCfg = JSON.parse(await readFile(join(cwd, 'board.json'), 'utf8')); } catch { rawCfg = null; }
  return detectProfiles(presentDetectDirs(cwd), rawCfg);
}

/**
 * Default dependency: read the anti-spam memory. May throw (ENOENT, bad JSON);
 * decide() treats any failure as a fresh session.
 * @param {string} cwd
 * @returns {Promise<{sessionId:string, files:string[]}>}
 */
export async function defaultReadAnnounced(cwd) {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(join(cwd, ANNOUNCED_DIR, ANNOUNCED_FILE), 'utf8'));
}

/**
 * Default dependency: persist the anti-spam memory (best-effort; a failed
 * write means a duplicate note on the next save of the same file — accepted).
 * @param {string} cwd
 * @param {{sessionId:string, files:string[]}} data
 */
export async function defaultWriteAnnounced(cwd, data) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const dir = join(cwd, ANNOUNCED_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ANNOUNCED_FILE), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * PURE-ish decision: given the PostToolUse payload and injected deps, decide
 * whether to inject a changed-source note. NEVER throws — any failure returns
 * null (degrade). Once per file per session.
 *
 * @param {object} input  parsed PostToolUse payload
 * @param {object} deps   { getProfiles(cwd), readAnnounced(cwd), writeAnnounced(cwd, data) }
 * @returns {Promise<{additionalContext:string}|null>}
 */
export async function decide(input, deps = {}) {
  try {
    const getProfiles = deps.getProfiles || defaultGetProfiles;
    const readAnnounced = deps.readAnnounced || defaultReadAnnounced;
    const writeAnnounced = deps.writeAnnounced || defaultWriteAnnounced;

    const cwd = (input && input.cwd) || process.cwd();
    const sessionId = (input && input.session_id) || null;
    const ti = (input && input.tool_input) || null;
    const abs = ti && typeof ti.file_path === 'string' ? ti.file_path
      : ti && typeof ti.notebook_path === 'string' ? ti.notebook_path
      : null;
    if (!abs) return null;

    const rel = relative(cwd, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null; // outside the repo

    const profiles = await getProfiles(cwd);
    const patterns = (profiles || []).flatMap((p) => (p && Array.isArray(p.watch) ? p.watch : []));
    if (!matchesWatch(rel, patterns)) return null;

    // Once per file per session: any read failure or session mismatch -> fresh.
    let files = [];
    try {
      const prior = await readAnnounced(cwd);
      if (prior && prior.sessionId === sessionId && Array.isArray(prior.files)) files = prior.files;
    } catch { /* fresh session */ }
    if (files.includes(rel)) return null;

    try { await writeAnnounced(cwd, { sessionId, files: [...files, rel] }); } catch { /* duplicate later beats noise now */ }

    return {
      additionalContext: `github-boards: watched source file changed: ${rel} — run 'sync scan' then 'sync record' to ingest when ready.`,
    };
  } catch {
    return null;
  }
}

/** Read all of stdin as a string. */
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

/** Thin stdin/stdout shim. Emits the PostToolUse JSON only when there's a note. */
export async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw && raw.trim()) input = JSON.parse(raw);
  } catch {
    input = {}; // unparseable payload -> graceful no-op
  }

  let decision = null;
  try {
    decision = await decide(input);
  } catch {
    decision = null; // belt-and-suspenders: decide() already swallows
  }

  if (decision && decision.additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: decision.additionalContext,
      },
    }));
  }
  process.exit(0);
}

// Run as a hook only when invoked directly (not when imported for testing).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
