# GitHub Boards Skill — Build Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the executable logic for a standalone, self-contained Claude Code skill that reads and edits a GitHub Projects v2 Kanban board in natural language, routes 🤖/🧍 work, previews every write, and reports back.

**Architecture:** Two layers in one repo. A **ported engine** (`scripts/board.mjs`, from GCA's 38/38-tested `board-connection`) does the `gh`/GraphQL plumbing. A **new verb layer** (`scripts/board-manager.mjs`) composes the engine into conversational verbs and adds owner-routing, "what's on my plate", last-seen memory, and the report-back. The skill (`SKILL.md`), the `/board` command, and hooks wire it into Claude Code.

**Tech Stack:** Node.js ≥18 (ESM `.mjs`), `gh` CLI + GitHub GraphQL, Node's built-in `node:test` + `node:assert`. No runtime npm dependencies.

**Spec:** [docs/SPEC-BOARD-MANAGER.md](../SPEC-BOARD-MANAGER.md) · **Engine source to port:** `D:\Vibe Coding\GCA\skills\board-connection\` (contract: its `references/contract.md`).

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/board.mjs` | **Engine** (ported): `gh`/GraphQL ops — `stage-field`, `list-items`, `get-issue`, `snapshot`, `create-issue`, `add-to-board`, `set-labels`, `comment`, `set-stage`, `--staged`, `doctor`, `capabilities`. Exports each op as a function + a CLI shim. |
| `scripts/board-manager.mjs` | **Verb layer**: `put`, `queue`, `move`, `route`, `followup`, `reshape`, `summary` — composes the engine, adds routing + report-back. Exports functions + a CLI shim. |
| `scripts/lib/config.mjs` | Loads & validates `board.json`; merges the named preset from `presets/`. |
| `scripts/lib/presets.mjs` | Loads `presets/*.json`; resolves the active preset's lanes. |
| `scripts/lib/state.mjs` | Last-seen memory: read/write `.github-boards/state.json`, compute board diff. |
| `commands/board.md` | The `/board` slash command. |
| `hooks/SessionStart/load-board.mjs` | On session start: snapshot board + "what changed since last time" into context. |
| `hooks/Stop/report.mjs` | After a turn that changed the board: emit next-actions. |
| `hooks/PreToolUse/allow-board-script.mjs` | Pre-allow the bundled script so unattended/slash runs don't hang. |
| `board.example.json` | A documented example binding (users copy to `board.json`). |
| `tests/*.test.mjs` | One test file per module; a `tests/helpers/mock-engine.mjs`. |

---

## Build sequence (phases — each produces working, testable software)

| Phase | Delivers | Done when |
|---|---|---|
| **0 — Runtime scaffolding** | test harness + mock engine | `npm test` runs, 1 sample test green |
| **1 — Port the engine** | `scripts/board.mjs` ported + exported | engine's own tests green; `node scripts/board.mjs doctor` runs |
| **2 — Config + presets + doctor** | `lib/config.mjs`, `lib/presets.mjs`, doctor checks preset↔lanes | `doctor` confirms board matches active preset |
| **3 — Verb layer** | `scripts/board-manager.mjs` (7 verbs) | every verb tested vs mock engine; staged-before-write enforced |
| **4 — Memory** | `lib/state.mjs` + `summary` diff | "what changed" reported from `state.json`; opt-in `last-sync.json` |
| **5 — Skill wiring** | `/board` + 3 hooks | slash command runs a verb; SessionStart injects board; script never hangs |
| **6 — Integration + publish** | live-board E2E + publish checklist | happy paths green on a real test board; README/wiki final; version tagged |

Phases 0–2 are detailed to step level below (foundational + a port — completable now). Phases 3–6 have a **task brief + interfaces + test strategy**; expand each into step-level tasks when it starts (one plan per phase, per the writing-plans multi-subsystem guidance).

---

## Phase 0 — Runtime scaffolding

### Task 0.1: Test harness + mock engine

**Files:**
- Modify: `package.json` (the `test` script)
- Create: `tests/helpers/mock-engine.mjs`
- Create: `tests/smoke.test.mjs`

- [ ] **Step 1: Point the test script at node:test**

In `package.json`, set:
```json
"scripts": { "doctor": "node scripts/board.mjs doctor", "test": "node --test tests/" }
```

- [ ] **Step 2: Write the mock engine helper**

```javascript
// tests/helpers/mock-engine.mjs
// A fake of the engine surface (Phase 1 exports). Records calls; returns canned data.
export function makeMockEngine(overrides = {}) {
  const calls = [];
  const rec = (op) => (...args) => { calls.push({ op, args }); return (overrides[op]?.(...args)); };
  return {
    calls,
    listItems:      rec('listItems'),
    getStageField:  rec('getStageField'),
    createIssue:    rec('createIssue'),
    addIssueToBoard:rec('addIssueToBoard'),
    setLabels:      rec('setLabels'),
    comment:        rec('comment'),
    setStage:       rec('setStage'),
  };
}
```

- [ ] **Step 3: Write a smoke test**

```javascript
// tests/smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMockEngine } from './helpers/mock-engine.mjs';

test('mock engine records calls', () => {
  const e = makeMockEngine({ listItems: () => ({ items: [], count: 0 }) });
  const r = e.listItems('p1');
  assert.equal(r.count, 0);
  assert.equal(e.calls[0].op, 'listItems');
});
```

- [ ] **Step 4: Run** — `npm test` — Expected: 1 test passes.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "test: scaffold node:test harness + mock engine"`

---

## Phase 1 — Port the engine

The engine is GCA's hardened `board-connection`. **Port it, do not rewrite it** — rewriting re-creates the exact draft-card and Stage/Status defects its invariants prevent.

### Task 1.1: Copy the engine + its tests

**Files:**
- Create: `scripts/board.mjs` (from `D:\Vibe Coding\GCA\skills\board-connection\scripts\board.mjs`)
- Create: `tests/engine.test.mjs` (from that repo's `tests/run-tests.mjs`, adapted to `node:test` if needed)

- [ ] **Step 1:** Copy `board.mjs` verbatim into `scripts/board.mjs`.
- [ ] **Step 2:** Copy the engine's test suite into `tests/engine.test.mjs`.
- [ ] **Step 3: Run** the engine tests — `npm test` — Expected: the ported engine tests pass unchanged (they mock `gh`).
- [ ] **Step 4: Commit** — `git commit -am "feat: port board-connection engine (ghCli adapter) verbatim"`

### Task 1.2: Add a function-export surface (for verb-layer composition + mocking)

If `board.mjs` is CLI-only, refactor so each op is an exported function **and** the CLI shim calls those exports — so `board-manager.mjs` can import + a test can mock them.

- [ ] **Step 1: Write the failing test**
```javascript
// tests/engine.exports.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../scripts/board.mjs';
test('engine exports its ops as functions', () => {
  for (const op of ['listItems','getStageField','createIssue','addIssueToBoard','setLabels','comment','setStage'])
    assert.equal(typeof engine[op], 'function', `missing export: ${op}`);
});
```
- [ ] **Step 2: Run** — `npm test` — Expected: FAIL (exports missing).
- [ ] **Step 3:** Refactor `board.mjs`: lift each op into an exported `async function`; keep a `if (import.meta.url === pathToFileURL(process.argv[1]).href) { /* CLI dispatch */ }` shim that calls them. Preserve all invariants (real Issues; Stage by ID fail-closed; `--staged`).
- [ ] **Step 4: Run** — `npm test` — Expected: PASS (exports + ported tests).
- [ ] **Step 5: Commit** — `git commit -am "refactor: expose engine ops as ESM exports + CLI shim"`

### Task 1.3: Rename config to `board.json` + namespace routing labels

The engine reads `gca-board.json` with `owner` = the **repo owner**. Routing labels must NOT collide with that key.

- [ ] **Step 1:** Change the engine's config filename default from `gca-board.json` to `board.json`.
- [ ] **Step 2:** Add `board.example.json`:
```jsonc
{
  "owner": "deocracy", "ownerType": "organization",
  "projectNumber": 23, "projectId": "PVT_…", "repo": "github-boards-skill",
  "stageFieldId": "PVTSSF_…",
  "stageOptions": { "Ideas": "…", "Building": "…", "Shipped": "…" },
  "preset": "build",
  "routing": { "agent": "agent:go", "human": "needs-claude" }
}
```
- [ ] **Step 3: Run** `node scripts/board.mjs doctor` against a real test board — Expected: doctor reports node/gh/auth/board/lanes status.
- [ ] **Step 4: Commit** — `git commit -am "feat: board.json config + routing labels namespaced under routing{}"`

> **Doc fix (do in this task):** update `skills/github-boards/SKILL.md`, `wiki/Configuration.md`, `docs/SPEC-BOARD-MANAGER.md`, and `presets/*.json` so the routing labels are referenced as `routing.{agent,human}` (board.json), distinct from `owner` (repo owner). Presets keep `owner` only as a default the binding copies into `routing`.

---

## Phase 2 — Config + presets + doctor

### Task 2.1: Preset loader

**Files:** Create `scripts/lib/presets.mjs`, `tests/presets.test.mjs`

- [ ] **Step 1: Write the failing test**
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPreset, laneNames } from '../scripts/lib/presets.mjs';
test('loads a bundled preset and lists lane names in order', async () => {
  const p = await loadPreset('build');
  assert.equal(p.name, 'build');
  assert.deepEqual(laneNames(p).slice(0, 2), ['Ideas', 'Researching']);
});
test('unknown preset fails closed', async () => {
  await assert.rejects(() => loadPreset('nope'));
});
```
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `loadPreset(name)` (read `presets/<name>.json`, throw on missing) and `laneNames(preset)` (map `lanes[].name`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: project-agnostic preset loader"`

### Task 2.2: Config loader (board.json + preset merge)

**Files:** Create `scripts/lib/config.mjs`, `tests/config.test.mjs`

- [ ] **Step 1: Write the failing test** — assert `loadConfig(path)` returns `{ projectId, stageFieldId, stageOptions, routing, preset }` and throws (fail-closed) on a missing `stageFieldId` or unknown `preset`.
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../scripts/lib/config.mjs';
test('fails closed without stageFieldId', async () => {
  await assert.rejects(() => loadConfig('tests/fixtures/no-stage.json'));
});
```
- [ ] **Step 2: Run** — Expected: FAIL. (Create `tests/fixtures/no-stage.json`.)
- [ ] **Step 3: Implement** `loadConfig` (read JSON; validate required keys; resolve `preset` via `loadPreset`; default `routing` to `{agent:'agent:go',human:'needs-claude'}`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: board.json loader with preset merge, fail-closed"`

### Task 2.3: Extend `doctor` to check preset ↔ live lanes

- [ ] **Step 1: Write the failing test** — doctor returns a FAIL entry when a preset lane has no matching live `stageOptions` id.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the cross-check in the engine's `doctor` (every `laneNames(preset)` entry must appear in `stageOptions`; report the diff + print the one-time UI view checklist).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: doctor verifies the board matches the active preset"`

---

## Phase 3 — Verb layer (`scripts/board-manager.mjs`) — task brief

**Interface (all verbs take `{ engine, config, staged }`; return `{ ...result, say }`):**

```javascript
put(tasks, ctx)        // tasks: [{title, body?, lane?, owner?}] → createIssue→addIssueToBoard→setStage→setLabels(routing[owner]); returns {created[], say}
queue(owner, ctx)      // 'agent'|'human' → listItems + filter on routing[owner]; returns {items[], say}
move(card, lane, ctx)  // setStage; lane 'reject' → Rejected lane + comment; returns {moved, say}
route(card, owner, ctx)// setLabels(flip routing); owner 'human' → keep claimed + comment(@mention); returns {routed, say}
followup(parent, child, ctx) // createIssue(sub-issue body links parent)→addIssueToBoard; returns {created, say}
reshape(presetName, ctx)     // set Stage options to preset lanes (engine field op) + print UI checklist; returns {applied, checklist, say}
summary(ctx)           // listItems + diff vs state; returns {changes, queues, say}
```

**Hard rules under test (every verb):** in `staged` mode the engine's write ops are recorded but **not committed** (assert via mock `calls`); a non-staged write is only reached after preview; `route('human')` always produces BOTH a `setLabels` and a `comment` call (Invariant 8); `reshape` never calls any view/layout op.

**Test strategy:** import `board-manager.mjs`, inject `makeMockEngine`, assert the exact composed `engine.calls` sequence + the `say` string shape. One `tests/<verb>.test.mjs` per verb.

**Worked example — `put` (use as the template for the other six):**
```javascript
// tests/put.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { put } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

test('put files a human task: create → add → stage → label, staged preview first', async () => {
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId:'I_1', number:41, url:'u', contentType:'Issue' }),
    addIssueToBoard: () => ({ itemId:'IT_1' }),
  });
  const ctx = { engine, config: { routing:{agent:'agent:go',human:'needs-claude'}, stageOptions:{Intake:'o1'} }, staged:false };
  const r = await put([{ title:'Submit form', owner:'human', lane:'Intake' }], ctx);
  const ops = engine.calls.map(c => c.op);
  assert.deepEqual(ops, ['createIssue','addIssueToBoard','setStage','setLabels']);
  assert.match(engine.calls.at(-1).args.join(' '), /needs-claude/);
  assert.match(r.say, /On your plate/);
});
```

Tasks 3.1–3.7 = one per verb, each: write the failing test (its specific composition + assertions), run-fail, implement the verb, run-pass, commit.

---

## Phase 4 — Memory (`scripts/lib/state.mjs`) — task brief

**Interface:**
```javascript
readState(dir)             // → {seenAt, items:{[issueNumber]:{lane,labels,owner}}} | null
writeState(dir, snapshot)  // persist .github-boards/state.json
diff(prev, current)        // → {moved[], added[], removed[], rejected[]}
```
- `summary()` calls `readState` → `diff(prev, listItems())` → human "since last time" line → `writeState`.
- Opt-in committed `last-sync.json` when `config.teamSync === true` (otherwise only the git-ignored `.github-boards/state.json`).

**Tests:** `diff` detects a lane move, a new card, a rejection; `readState` returns `null` on first run (no crash); team-sync flag toggles which file is written.

---

## Phase 5 — Skill wiring — task brief

- **`commands/board.md`** — a `/board` slash command whose body instructs running `node scripts/board-manager.mjs <verb>`; verify it appears as `/board` and runs `summary` with no args.
- **`hooks/SessionStart/load-board.mjs`** — runs `summary` (read-only) and prints the two queues + "what changed"; **must not prompt** (read-only, pre-allowed).
- **`hooks/Stop/report.mjs`** — if the board changed this turn, print next-actions.
- **`hooks/PreToolUse/allow-board-script.mjs`** — return an allow decision for `Bash(node …/board*.mjs …)` so slash/unattended runs never hang; deny nothing else.
- Declare hooks in `.claude-plugin/plugin.json` per the plugin hook format; document the settings-allowlist alternative in the README.

**Tests:** each hook script is a pure function over its stdin JSON → assert output; the PreToolUse hook allows the board script and is a no-op for other tools.

---

## Phase 6 — Integration + publish — task brief

- A `tests/integration/` suite (guarded by an env flag + a real `GH_TEST_PROJECT`) running `put → queue → move → reject → summary` against a throwaway board; assert via `list-items`.
- `doctor` green end-to-end on a fresh machine (node + gh + auth + board + preset).
- Finalize README/wiki; confirm `/plugin marketplace add deocracy/github-boards-skill` + `/plugin install` against the pushed repo.
- Bump `version` in `plugin.json` + `package.json`; tag `v0.1.0`.

---

## Self-review (against the spec)

- **Coverage:** put/queue/move/route/followup/reshape/summary (Phase 3) ✓ · routing via labels (1.3, 3) ✓ · config-driven lanes/presets (2) ✓ · staged-preview HITL (3 hard rules) ✓ · report-back (`say`, every verb) ✓ · memory/last-seen (4) ✓ · reshape in v1 (3) ✓ · doctor + UI checklist / no view-config (2.3, Invariant) ✓ · local-first hooks rungs 1–4 (5) ✓ · agnostic instruction body (engine/verbs are vendor-neutral scripts) ✓.
- **Deferred (correctly absent):** MCP server, server "button", always-on, multi-board — none planned here.
- **Type consistency:** verb signatures `{engine,config,staged}`→`{...,say}` are used identically in the mock tests and the Phase 3 interface; engine op names match `references/contract.md` exactly.
- **Open before build:** confirm the engine's current export shape (Task 1.2 may be a no-op if `board.mjs` already exports); confirm a throwaway test board for Phase 6.
