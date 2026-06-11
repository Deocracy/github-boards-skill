# M3c Real-Time Triggering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PostToolUse hook that tells Claude — once per file per session, on the very next turn — when a watched source file is written mid-session, so new work is noticed without a session restart.

**Architecture:** Stateless signal, not a queue (M3b's `ledger.sources` hash-diff is already the durable change record). One new pure matcher `matchesWatch` in `lib/sources.mjs` (sharing `WATCH_GLOB_RE` with `expandWatch` so the two cannot drift); one new hook `hooks/PostToolUse/watch-sources.mjs` mirroring `load-board.mjs`'s `decide(input, deps)` + `main()` shape; session-scoped anti-spam memory in `.github-boards/announced.json`; registration in `hooks/hooks.json` with matcher `Write|Edit|MultiEdit|NotebookEdit`.

**Tech Stack:** Node ≥18 (ESM), `node:test`, no third-party deps. **M3c touches nothing external — no live gate.**

**Spec:** [docs/superpowers/specs/2026-06-10-m3c-realtime-design.md](../specs/2026-06-10-m3c-realtime-design.md)

**Docs verified (spec §8 resolved):** PostToolUse supports `hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "<string>" }` — silence = print nothing, exit 0. Input stdin JSON: `{ session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_response }`; Write/Edit use `tool_input.file_path`, NotebookEdit uses `tool_input.notebook_path`. Note text must read as a **factual statement**, not an imperative system command (imperative phrasing can trip prompt-injection defenses). Output strings cap at 10,000 chars (ours is ~120).

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `scripts/lib/sources.mjs` | Mod | Export `WATCH_GLOB_RE` (moved from board-manager) + new pure `matchesWatch(relPath, patterns)`. |
| `scripts/board-manager.mjs` | Mod | Delete its local `WATCH_GLOB_RE`; import it from `./lib/sources.mjs` instead. No behavior change. |
| `hooks/PostToolUse/watch-sources.mjs` | **New** | The hook: `decide(input, deps)` + default deps + `main()` stdin/stdout shim. Never throws, always exit 0, observation-only. |
| `hooks/hooks.json` | Mod | Add the PostToolUse registration. |
| `tests/sources.test.mjs` | Mod | `matchesWatch` unit tests. |
| `tests/sync-verb.test.mjs` | Mod | `expandWatch`↔`matchesWatch` parity test (fs fixtures live here). |
| `tests/hooks.watch-sources.test.mjs` | **New** | `decide()` behavior (injected deps) + hooks.json registration + CLI-verb drift guard. |

**Conventions:** tests use `node:test` + `assert/strict`; temp dirs via `mkdtempSync(join(os.tmpdir(), 'gbs-…'))`. Run single files (`node --test tests/<file>.test.mjs`) or the suite via `npm test`. **Never `node --test tests/` with a bare directory — MODULE_NOT_FOUND.** Repo-relative paths are POSIX (forward slashes).

---

### Task 1: `matchesWatch` + shared `WATCH_GLOB_RE` (`lib/sources.mjs`)

**Files:**
- Modify: `scripts/lib/sources.mjs` (add `WATCH_GLOB_RE` export + `matchesWatch`)
- Modify: `scripts/board-manager.mjs` (delete local regex, import the shared one)
- Test: `tests/sources.test.mjs` (append), `tests/sync-verb.test.mjs` (append parity test)

- [ ] **Step 1: Append the failing tests to `tests/sources.test.mjs`** (merge `matchesWatch` into the existing top-of-file sources.mjs import line — no mid-file imports):

```javascript
test('matchesWatch: literal pattern — exact hit, near-miss misses', () => {
  assert.equal(matchesWatch('TODO.md', ['TODO.md']), true);
  assert.equal(matchesWatch('TODO.markdown', ['TODO.md']), false);
  assert.equal(matchesWatch('sub/TODO.md', ['TODO.md']), false); // literal is exact, not basename
});

test('matchesWatch: glob pattern — base-prefix + ext, nested subpaths hit', () => {
  const pats = ['docs/superpowers/plans/**/*.md'];
  assert.equal(matchesWatch('docs/superpowers/plans/p1.md', pats), true);
  assert.equal(matchesWatch('docs/superpowers/plans/sub/deep.md', pats), true);
  assert.equal(matchesWatch('docs/superpowers/plans/notes.txt', pats), false); // wrong ext
  assert.equal(matchesWatch('docs/superpowers/specs/x.md', pats), false);      // wrong base
});

test('matchesWatch: prefix-collision dirs do NOT match (plans-old vs plans)', () => {
  assert.equal(matchesWatch('docs/superpowers/plans-old/x.md', ['docs/superpowers/plans/**/*.md']), false);
});

test('matchesWatch: unsupported glob forms and non-strings never match', () => {
  assert.equal(matchesWatch('docs/x.md', ['docs/*.md']), false);   // single-star unsupported
  assert.equal(matchesWatch('docs/x.md', [42, null]), false);      // non-strings skipped
  assert.equal(matchesWatch('docs/x.md', []), false);
  assert.equal(matchesWatch('docs/x.md', null), false);
  assert.equal(matchesWatch('', ['TODO.md']), false);
  assert.equal(matchesWatch(null, ['TODO.md']), false);
});

test('WATCH_GLOB_RE is exported (single shared definition with expandWatch)', () => {
  assert.ok(WATCH_GLOB_RE instanceof RegExp);
  assert.ok(WATCH_GLOB_RE.test('docs/superpowers/plans/**/*.md'));
  assert.equal(WATCH_GLOB_RE.test('docs/*.md'), false);
});
```

(Also merge `WATCH_GLOB_RE` into the same import line.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/sources.test.mjs`
Expected: FAIL — `matchesWatch` / `WATCH_GLOB_RE` not exported

- [ ] **Step 3: Implement in `scripts/lib/sources.mjs`** (append after `validateExtraction`):

```javascript
// Supported watch-pattern forms (shared with board-manager's expandWatch —
// single definition so the fs walker and the pure matcher cannot drift):
//   literal file path           e.g. "TODO.md"
//   <base>/**/*.<ext>           e.g. "docs/superpowers/plans/**/*.md"
export const WATCH_GLOB_RE = /^(.+)\/\*\*\/\*(\.[A-Za-z0-9]+)$/;

/**
 * Pure string match of ONE repo-relative POSIX path against watch patterns.
 * Same two supported forms as expandWatch: literal equality, and
 * "<base>/**\/*.<ext>" (path under <base>/ with that extension). Non-string
 * and unsupported patterns never match (parity with expandWatch). No fs.
 * @param {string} relPath  repo-relative POSIX path (forward slashes)
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchesWatch(relPath, patterns) {
  if (typeof relPath !== 'string' || relPath === '') return false;
  for (const pattern of patterns || []) {
    if (typeof pattern !== 'string') continue;
    const m = WATCH_GLOB_RE.exec(pattern);
    if (m) {
      if (relPath.startsWith(`${m[1]}/`) && relPath.endsWith(m[2])) return true;
    } else if (!pattern.includes('*')) {
      if (relPath === pattern) return true;
    }
    // other glob forms: unsupported -> never match
  }
  return false;
}
```

(Note: the `**\/` in the JSDoc is escaped to avoid closing the comment — keep it exactly as shown.)

- [ ] **Step 4: Swap board-manager to the shared regex.** In `scripts/board-manager.mjs`:
  - Add `WATCH_GLOB_RE` to the existing sources.mjs import line:
    ```javascript
    import { contentHash, detectProfiles, diffSources, buildManifest, validateExtraction, WATCH_GLOB_RE } from './lib/sources.mjs';
    ```
  - DELETE the local definition lines (the comment block + const):
    ```javascript
    // Supported watch-pattern forms (all three shipped profiles + user globs):
    //   literal file path           e.g. "TODO.md"
    //   <base>/**/*.<ext>           e.g. "docs/superpowers/plans/**/*.md"
    const WATCH_GLOB_RE = /^(.+)\/\*\*\/\*(\.[A-Za-z0-9]+)$/;
    ```
  No other change — `expandWatch` and `syncScan` keep using the (now-imported) name.

- [ ] **Step 5: Append the parity test to `tests/sync-verb.test.mjs`** (extend the existing sources.mjs import with `matchesWatch`):

```javascript
test('PARITY: every file expandWatch finds satisfies matchesWatch for the same patterns (and known misses fail both)', async () => {
  const dir = tmp();
  seedRepo(dir);
  const patterns = ['docs/superpowers/plans/**/*.md', 'TODO.md', 'MISSING.md', 'docs/*.md'];
  const found = await expandWatch(dir, patterns);
  assert.ok(found.length > 0); // sanity: fixtures actually match
  for (const f of found) {
    assert.equal(matchesWatch(f, patterns), true, `expandWatch found ${f} but matchesWatch missed it`);
  }
  // known misses agree too
  assert.ok(!found.includes('docs/superpowers/plans/notes.txt'));
  assert.equal(matchesWatch('docs/superpowers/plans/notes.txt', patterns), false);
});
```

- [ ] **Step 6: Run to verify pass**

Run: `node --test tests/sources.test.mjs tests/sync-verb.test.mjs`
Expected: PASS (all — 27 in sources, 21 in sync-verb)
Then full suite: `npm test` → all pass, 2 pre-existing skips.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/sources.mjs scripts/board-manager.mjs tests/sources.test.mjs tests/sync-verb.test.mjs
git commit -m "feat(m3c): pure matchesWatch + shared WATCH_GLOB_RE (no fs-walker/matcher drift)"
```

---

### Task 2: The PostToolUse hook (`hooks/PostToolUse/watch-sources.mjs`)

**Files:**
- Create: `hooks/PostToolUse/watch-sources.mjs`
- Test: `tests/hooks.watch-sources.test.mjs` (new)

- [ ] **Step 1: Write the failing tests.** Create `tests/hooks.watch-sources.test.mjs`:

```javascript
// tests/hooks.watch-sources.test.mjs — M3c PostToolUse decide() behavior
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../hooks/PostToolUse/watch-sources.mjs';

const PROFILES_FIXTURE = [
  { name: 'superpowers', watch: ['docs/superpowers/plans/**/*.md'] },
  { name: 'generic', watch: ['TODO.md'] },
];

function deps(overrides = {}) {
  return {
    getProfiles: async () => PROFILES_FIXTURE,
    readAnnounced: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    writeAnnounced: async () => {},
    ...overrides,
  };
}

const input = (file_path, session_id = 's1', cwd = '/work') => ({
  session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Write',
  tool_input: { file_path },
});

test('watched file, first time this session -> factual note naming the file + sync verbs', async () => {
  const r = await decide(input('/work/TODO.md'), deps());
  assert.ok(r, 'expected a note');
  assert.match(r.additionalContext, /TODO\.md/);
  assert.match(r.additionalContext, /sync scan/);
  assert.match(r.additionalContext, /sync record/);
});

test('same file, same session, already announced -> silent', async () => {
  const r = await decide(input('/work/TODO.md'), deps({
    readAnnounced: async () => ({ sessionId: 's1', files: ['TODO.md'] }),
  }));
  assert.equal(r, null);
});

test('same file, NEW session id -> announces again', async () => {
  const r = await decide(input('/work/TODO.md', 's2'), deps({
    readAnnounced: async () => ({ sessionId: 's1', files: ['TODO.md'] }),
  }));
  assert.ok(r && /TODO\.md/.test(r.additionalContext));
});

test('writeAnnounced is called with the updated file list', async () => {
  let written = null;
  await decide(input('/work/docs/superpowers/plans/p.md'), deps({
    readAnnounced: async () => ({ sessionId: 's1', files: ['TODO.md'] }),
    writeAnnounced: async (cwd, data) => { written = data; },
  }));
  assert.deepEqual(written, { sessionId: 's1', files: ['TODO.md', 'docs/superpowers/plans/p.md'] });
});

test('unwatched path -> silent', async () => {
  assert.equal(await decide(input('/work/src/index.js'), deps()), null);
});

test('path outside the repo -> silent', async () => {
  assert.equal(await decide(input('/elsewhere/TODO.md'), deps()), null);
});

test('missing tool_input / missing path field -> silent', async () => {
  assert.equal(await decide({ session_id: 's1', cwd: '/work' }, deps()), null);
  assert.equal(await decide({ session_id: 's1', cwd: '/work', tool_input: {} }, deps()), null);
  assert.equal(await decide({ session_id: 's1', cwd: '/work', tool_input: { file_path: 42 } }, deps()), null);
});

test('NotebookEdit notebook_path is honored', async () => {
  const r = await decide({
    session_id: 's1', cwd: '/work', tool_name: 'NotebookEdit',
    tool_input: { notebook_path: '/work/TODO.md' },
  }, deps());
  assert.ok(r && /TODO\.md/.test(r.additionalContext));
});

test('getProfiles throwing -> silent (degrade)', async () => {
  assert.equal(await decide(input('/work/TODO.md'), deps({ getProfiles: async () => { throw new Error('fs'); } })), null);
});

test('readAnnounced returning garbage -> still announces (treated as fresh)', async () => {
  const r = await decide(input('/work/TODO.md'), deps({ readAnnounced: async () => 'garbage' }));
  assert.ok(r && /TODO\.md/.test(r.additionalContext));
});

test('writeAnnounced throwing -> note still returned (duplicate later beats noise now)', async () => {
  const r = await decide(input('/work/TODO.md'), deps({ writeAnnounced: async () => { throw new Error('fs'); } }));
  assert.ok(r && /TODO\.md/.test(r.additionalContext));
});

test('note reads as a factual statement, not an imperative system command', async () => {
  const r = await decide(input('/work/TODO.md'), deps());
  assert.match(r.additionalContext, /^github-boards: watched source file changed/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/hooks.watch-sources.test.mjs`
Expected: FAIL — `Cannot find module … watch-sources.mjs`

- [ ] **Step 3: Implement.** Create `hooks/PostToolUse/watch-sources.mjs`:

```javascript
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/hooks.watch-sources.test.mjs`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add hooks/PostToolUse/watch-sources.mjs tests/hooks.watch-sources.test.mjs
git commit -m "feat(m3c): PostToolUse watch-sources hook — once-per-file-per-session change note"
```

---

### Task 3: Registration + drift guard + smoke

**Files:**
- Modify: `hooks/hooks.json`
- Test: `tests/hooks.watch-sources.test.mjs` (append)

- [ ] **Step 1: Append the failing tests** to `tests/hooks.watch-sources.test.mjs` (top-of-file imports: add `readFileSync` from `node:fs`, `join` from `node:path`, and `fileURLToPath` from `node:url`):

```javascript
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('hooks.json registers the PostToolUse watch-sources hook with the right matcher', () => {
  const cfg = JSON.parse(readFileSync(join(repoRoot, 'hooks', 'hooks.json'), 'utf8'));
  const entries = cfg.hooks.PostToolUse;
  assert.ok(Array.isArray(entries), 'PostToolUse entries missing');
  const entry = entries.find((e) => (e.hooks || []).some((h) => (h.args || []).join(' ').includes('watch-sources.mjs')));
  assert.ok(entry, 'watch-sources.mjs not registered');
  assert.equal(entry.matcher, 'Write|Edit|MultiEdit|NotebookEdit');
});

test('DRIFT GUARD: the note suggests verbs that actually exist in the CLI help', async () => {
  const r = await decide(input('/work/TODO.md'), deps());
  const help = readFileSync(join(repoRoot, 'scripts', 'board-manager.mjs'), 'utf8');
  for (const verb of ['sync scan', 'sync record']) {
    assert.match(r.additionalContext, new RegExp(verb));
    assert.ok(help.includes(verb), `CLI help no longer documents '${verb}' — the hook note is orphaned`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/hooks.watch-sources.test.mjs`
Expected: FAIL — hooks.json has no PostToolUse entry yet (drift-guard test should already pass)

- [ ] **Step 3: Register in `hooks/hooks.json`.** Add a `PostToolUse` key between the existing `PreToolUse` and `Stop` entries:

```json
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/PostToolUse/watch-sources.mjs"]
          }
        ]
      }
    ],
```

Also update the top-level `"description"` string to mention the new signal, e.g.:
`"github-boards: load board status at session start, fast-path the board script through PreToolUse, note watched-source changes through PostToolUse, and (quietly) nudge next actions on stop."`

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/hooks.watch-sources.test.mjs`
Expected: PASS (14 tests)

- [ ] **Step 5: Hook smoke via stdin (PowerShell, no Claude session needed):**

```powershell
$d = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid()))
Set-Content -Path (Join-Path $d 'TODO.md') -Value "- [ ] item" -Encoding utf8
$payload = '{"session_id":"smoke1","cwd":"' + ($d -replace '\\','\\\\') + '","tool_name":"Write","tool_input":{"file_path":"' + ((Join-Path $d 'TODO.md') -replace '\\','\\\\') + '"}}'
$payload | node "d:\Vibe Coding\github-boards-skill\hooks\PostToolUse\watch-sources.mjs"
# Expected: {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"github-boards: watched source file changed: TODO.md — ..."}}
$payload | node "d:\Vibe Coding\github-boards-skill\hooks\PostToolUse\watch-sources.mjs"
# Expected: NO output (already announced for session smoke1), exit 0
```

Report the actual outputs.

- [ ] **Step 6: Full suite, then commit**

Run: `npm test`
Expected: all pass, 2 pre-existing skips.

```bash
git add hooks/hooks.json tests/hooks.watch-sources.test.mjs
git commit -m "feat(m3c): register PostToolUse watch-sources hook + CLI-verb drift guard"
```

---

## Self-Review (run after all tasks)

1. **Spec coverage:** §2 in-scope items → Task 1 (`matchesWatch`), Task 2 (hook + announced.json), Task 3 (hooks.json); §3 flow incl. once-per-session posture → Task 2 tests; §4 parity guarantee → Task 1 Step 5; §5 anti-spam semantics (mismatch→fresh, best-effort write) → Task 2 tests; §6 never-throw + cheapest-first ordering → Task 2 implementation; §7 tests 1–5 → Tasks 1–3 respectively (drift guard = Task 3); §8 open questions → resolved in the plan header.
2. **Placeholder scan:** none — every step has complete code/commands.
3. **Type consistency:** `matchesWatch(relPath, patterns)` identical in Tasks 1–3; `decide(input, deps)` with `{getProfiles, readAnnounced, writeAnnounced}` consistent across Task 2 impl and tests; `announced.json` shape `{sessionId, files[]}` consistent in §5/Task 2.
