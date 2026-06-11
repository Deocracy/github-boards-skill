# M5 Skill Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch the LLM-facing layer up to the engine (SKILL.md/commands/AGENTS.md teach the full sync→map→promote→reconcile→snapshot pipeline plus a code-backed undo reflex) and keep it caught up via deterministic drift gates in `npm test`, with a `GBS_EVAL=1`-gated LLM scenario harness on the side.

**Architecture:** Pure `invertDiff(diff, routing)` in `lib/snapshots.mjs` + read-only `snapshot invert` verb/CLI compute undo plans mechanically (moves → `move` ops; pure owner-label flips → `route` ops; everything else → `manual`). `tests/skill-evals.test.mjs` parses `--help` as the source of truth and asserts prose coverage, hard-rule/trigger sentinels, and AGENTS.md mirror identity. `evals/scenarios.json` + `scripts/eval-skill.mjs` grade verb selection via `claude -p` — manual, advisory, never CI.

**Tech Stack:** Node ≥18 (ESM), `node:test`, no third-party deps. No new live surface; no LLM calls inside `npm test`.

**Spec:** [docs/superpowers/specs/2026-06-11-m5-skill-layer-design.md](../specs/2026-06-11-m5-skill-layer-design.md)

---

## SAFETY (all roles)
- NEVER set or export `GBS_LIVE=1` or `GBS_EVAL=1`; never run live tests or the eval runner (3 pre-existing gated skips stay skipped; the runner's refusal path is tested WITHOUT the gate set).
- NEVER run `node --test tests/` bare (MODULE_NOT_FOUND) — specific files or `npm test`.
- NEVER `git push`.

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `scripts/lib/snapshots.mjs` | Mod | + `invertDiff(diff, routing)` pure export. |
| `scripts/board-manager.mjs` | Mod | + `snapshotInvert(refA, refB, ctx)` verb; CLI `snapshot invert` beside `diff`; Tier-0 guard admits `invert`; help line; usage strings updated. |
| `skills/github-boards/SKILL.md` | Mod | Full rewrite (same voice/hard rules): pipeline map, new verb rows (incl. previously-missing `bootstrap`/`ledger`), hooks section, undo reflex, refreshed frontmatter triggers. |
| `skills/github-boards/references/undo-contract.md` | **New** | The full undo contract. |
| `AGENTS.md` | **New** | Vendor-neutral mirror: short header + `<!-- BEGIN MIRROR -->` + SKILL.md body byte-identical. |
| `commands/board.md` | Mod | Full verb list. |
| `tests/skill-evals.test.mjs` | **New** | Drift gates (8 tests) + later the harness gates (2 tests). |
| `tests/undo-pipeline.test.mjs` | **New** | Cross-module round-trip: real verbs mutate → invert → real verbs restore → diff empty. |
| `evals/scenarios.json` | **New** | 16 fixtures incl. 3 negatives. |
| `scripts/eval-skill.mjs` | **New** | Gated runner (`GBS_EVAL=1`), `claude -p` per scenario, scorecard. |
| `tests/snapshots.test.mjs` / `tests/snapshot-verb.test.mjs` | Mod | invertDiff unit tests / snapshotInvert verb tests (append). |

**Conventions:** node:test + assert/strict; temp dirs `mkdtempSync(join(os.tmpdir(), 'gbs-…'))`; imports extended, not duplicated. Diff buckets: `{moved, added, removed, relabeled, retitled}` (from `diffSnapshots`). `config.routing` = `{agent:'agent:go', human:'needs-claude'}` shape.

**Plan-time resolutions of spec §7:**
1. `--help` lines: each verb line starts with exactly two spaces then the verb token; flags start with `--` and don't match `/^ {2}([a-z][\w-]*)\b/`. 15 unique first tokens today.
2. `claude` CLI 2.1.172: `claude -p --output-format text --model <model>`, prompt via stdin; `spawnSync(…, {shell: process.platform === 'win32'})` for the `.cmd` shim. Default model `haiku` (override `GBS_EVAL_MODEL`).
3. Relabel execution: only owner flips are executable today (`route` = additive `setLabels` + `removeLabels`); `invertDiff` emits `{op:'route'}` for pure owner flips and sends every other label change to `manual`. There is NO `{op:'relabel'}`.

**Test-count baseline:** 365 tests (362 pass, 3 skipped) before Task 1.

---

### Task 1: `invertDiff` (pure) in `lib/snapshots.mjs`

**Files:**
- Modify: `scripts/lib/snapshots.mjs` (append after `readSnapshot`)
- Test: `tests/snapshots.test.mjs` (append; extend the top import from `../scripts/lib/snapshots.mjs` with `invertDiff`)

- [ ] **Step 1: Append the failing tests** to `tests/snapshots.test.mjs`:

```javascript
const ROUTING = { agent: 'agent:go', human: 'needs-claude' };

test('invertDiff: moved -> inverse move (from/to swapped)', () => {
  const inv = invertDiff({ moved: [{ itemId: 'it-1', issueNumber: 1, title: 'Card 1', from: 'Ideas', to: 'Building' }], added: [], removed: [], relabeled: [], retitled: [] }, ROUTING);
  assert.deepEqual(inv.ops, [{ op: 'move', itemId: 'it-1', issueNumber: 1, title: 'Card 1', to: 'Ideas' }]);
  assert.deepEqual(inv.manual, []);
});

test('invertDiff: pure owner-flip relabel -> route op back to the previous owner', () => {
  // A->B the card went human->agent (gained agent:go, lost needs-claude); undo routes back to human
  const inv = invertDiff({ moved: [], added: [], removed: [], retitled: [], relabeled: [{ itemId: 'it-1', issueNumber: 1, title: 'Card 1', added: ['agent:go'], removed: ['needs-claude'] }] }, ROUTING);
  assert.deepEqual(inv.ops, [{ op: 'route', itemId: 'it-1', issueNumber: 1, title: 'Card 1', to: 'human' }]);
  assert.deepEqual(inv.manual, []);
});

test('invertDiff: non-owner relabel -> manual (no generic relabel verb)', () => {
  const inv = invertDiff({ moved: [], added: [], removed: [], retitled: [], relabeled: [{ itemId: 'it-1', issueNumber: 1, title: 'Card 1', added: ['bug'], removed: [] }] }, ROUTING);
  assert.equal(inv.ops.length, 0);
  assert.equal(inv.manual.length, 1);
  assert.match(inv.manual[0].reason, /no generic relabel verb/);
});

test('invertDiff: added/removed/retitled -> manual with the exact reasons', () => {
  const inv = invertDiff({
    moved: [],
    added: [{ itemId: 'it-9', issueNumber: 9, title: 'New card' }],
    removed: [{ itemId: 'it-8', issueNumber: 8, title: 'Gone card' }],
    relabeled: [],
    retitled: [{ itemId: 'it-7', issueNumber: 7, from: 'Old', to: 'New' }],
  }, ROUTING);
  assert.equal(inv.ops.length, 0);
  assert.equal(inv.manual.length, 3);
  assert.match(inv.manual.find((m) => m.itemId === 'it-9').reason, /never auto-deleted/);
  assert.match(inv.manual.find((m) => m.itemId === 'it-8').reason, /not recreated/);
  assert.match(inv.manual.find((m) => m.itemId === 'it-7').reason, /no retitle verb/);
});

test('invertDiff: null/empty tolerated; ops order is moves then routes; no routing -> flips go manual', () => {
  assert.deepEqual(invertDiff(null, ROUTING), { ops: [], manual: [] });
  assert.deepEqual(invertDiff({}, null), { ops: [], manual: [] });
  const inv = invertDiff({
    moved: [{ itemId: 'it-2', issueNumber: 2, title: 'C2', from: 'Ideas', to: 'Building' }],
    relabeled: [{ itemId: 'it-1', issueNumber: 1, title: 'C1', added: ['needs-claude'], removed: ['agent:go'] }],
    added: [], removed: [], retitled: [],
  }, ROUTING);
  assert.deepEqual(inv.ops.map((o) => o.op), ['move', 'route']);
  assert.equal(inv.ops[1].to, 'agent'); // went agent->human; undo routes back to agent
  // without routing context, the same flip is not safely executable
  const noCtx = invertDiff({ moved: [], added: [], removed: [], retitled: [], relabeled: [{ itemId: 'it-1', issueNumber: 1, title: 'C1', added: ['needs-claude'], removed: ['agent:go'] }] }, null);
  assert.equal(noCtx.ops.length, 0);
  assert.equal(noCtx.manual.length, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/snapshots.test.mjs`
Expected: FAIL — `invertDiff` is not exported

- [ ] **Step 3: Implement.** Append to `scripts/lib/snapshots.mjs`:

```javascript
/**
 * PURE inverse of a diffSnapshots() result: what would put the board back.
 * Only mechanically executable inversions become ops — a move restores a lane;
 * a route restores a PURE owner-label flip (requires `routing`). Everything
 * else lands in `manual` with a reason: added cards are NEVER proposed for
 * deletion, removed cards are never recreated, retitles have no verb.
 * Ops order: all moves first, then route flips.
 * @param {object|null} diff   {moved, added, removed, relabeled, retitled}
 * @param {{agent:string, human:string}|null} [routing]  config.routing
 * @returns {{ops:object[], manual:object[]}}
 */
export function invertDiff(diff, routing = null) {
  const d = diff || {};
  const moveOps = [];
  const routeOps = [];
  const manual = [];

  for (const m of d.moved || []) {
    moveOps.push({ op: 'move', itemId: m.itemId, issueNumber: m.issueNumber ?? null, title: m.title ?? null, to: m.from ?? null });
  }
  for (const r of d.relabeled || []) {
    const invAdd = [...(r.removed || [])].sort();   // undo restores what was removed…
    const invRemove = [...(r.added || [])].sort();  // …and strips what was added
    const flip = routing && invAdd.length === 1 && invRemove.length === 1;
    if (flip && invAdd[0] === routing.agent && invRemove[0] === routing.human) {
      routeOps.push({ op: 'route', itemId: r.itemId, issueNumber: r.issueNumber ?? null, title: r.title ?? null, to: 'agent' });
    } else if (flip && invAdd[0] === routing.human && invRemove[0] === routing.agent) {
      routeOps.push({ op: 'route', itemId: r.itemId, issueNumber: r.issueNumber ?? null, title: r.title ?? null, to: 'human' });
    } else {
      manual.push({
        itemId: r.itemId, issueNumber: r.issueNumber ?? null, title: r.title ?? null,
        reason: `labels changed (+[${(r.added || []).join(', ')}] -[${(r.removed || []).join(', ')}]) — no generic relabel verb; adjust by hand`,
      });
    }
  }
  for (const a of d.added || []) {
    manual.push({ itemId: a.itemId, issueNumber: a.issueNumber ?? null, title: a.title ?? null, reason: 'filed during this window — archive by hand if unwanted; never auto-deleted' });
  }
  for (const x of d.removed || []) {
    manual.push({ itemId: x.itemId, issueNumber: x.issueNumber ?? null, title: x.title ?? null, reason: 'left the board — not recreated' });
  }
  for (const t of d.retitled || []) {
    manual.push({ itemId: t.itemId, issueNumber: t.issueNumber ?? null, title: `${t.from ?? ''} → ${t.to ?? ''}`, reason: 'no retitle verb — rename by hand' });
  }
  return { ops: [...moveOps, ...routeOps], manual };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/snapshots.test.mjs`
Expected: PASS (27 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/snapshots.mjs tests/snapshots.test.mjs
git commit -m "feat(m5): pure invertDiff — mechanical undo plans (move/route ops + manual bucket)"
```

---

### Task 2: `snapshotInvert` verb

**Files:**
- Modify: `scripts/board-manager.mjs` (verb after `snapshotLog`; extend the `./lib/snapshots.mjs` import with `invertDiff`)
- Test: `tests/snapshot-verb.test.mjs` (append; extend its board-manager import with `snapshotInvert`)

- [ ] **Step 1: Append the failing tests** to `tests/snapshot-verb.test.mjs` (its `CFG` already has `routing: { agent: 'agent:go', human: 'needs-claude' }` and `boardItem(n)` defaults `labels: ['needs-claude']`, `stageLabel: 'Ideas'`):

```javascript
test('snapshotInvert: ref vs live — proposes the inverse move; READ-ONLY (no write ops on engine)', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {}); // Ideas
  const engine = engineWith([boardItem(1, { stageLabel: 'Building' })]); // live: moved
  const r = await snapshotInvert('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(r.ops, [{ op: 'move', itemId: 'it-1', issueNumber: 1, title: 'Card 1', to: 'Ideas' }]);
  assert.deepEqual(r.manual, []);
  assert.match(r.say, /1 op/);
  const writeOps = engine.calls.filter((c) => ['createIssue', 'setStage', 'setLabels', 'removeLabels', 'addIssueToBoard', 'comment'].includes(c.op));
  assert.deepEqual(writeOps, [], 'snapshot invert must never write');
});

test('snapshotInvert: owner flip -> route op; non-owner label change -> manual', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1), boardItem(2)], {});
  const engine = engineWith([
    boardItem(1, { labels: ['agent:go'] }),            // pure owner flip human->agent
    boardItem(2, { labels: ['needs-claude', 'bug'] }), // gained a non-owner label
  ]);
  const r = await snapshotInvert('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(r.ops, [{ op: 'route', itemId: 'it-1', issueNumber: 1, title: 'Card 1', to: 'human' }]);
  assert.equal(r.manual.length, 1);
  assert.match(r.manual[0].reason, /no generic relabel verb/);
});

test('snapshotInvert: identical refs -> nothing to undo', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {});
  const r = await snapshotInvert('latest', 'latest', { engine: engineWith([]), config: CFG, dir });
  assert.deepEqual(r.ops, []);
  assert.deepEqual(r.manual, []);
  assert.match(r.say, /nothing to undo/i);
});

test('snapshotInvert: added card lands in manual — never deletable; say points at the manual list', async () => {
  const dir = tmp();
  await writeSnapshot(dir, [boardItem(1)], {});
  await writeSnapshot(dir, [boardItem(1), boardItem(2)], {});
  const r = await snapshotInvert('~2', '~1', { engine: engineWith([]), config: CFG, dir });
  assert.equal(r.ops.length, 0);
  assert.equal(r.manual.length, 1);
  assert.match(r.manual[0].reason, /never auto-deleted/);
  assert.match(r.say, /manual/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/snapshot-verb.test.mjs`
Expected: FAIL — `snapshotInvert` is not exported

- [ ] **Step 3: Implement.** (a) Extend the existing import in `scripts/board-manager.mjs`:

```javascript
import { writeSnapshot, listSnapshots, readSnapshot, readLog, diffSnapshots, invertDiff, resolveKeep } from './lib/snapshots.mjs';
```

(b) Add the verb directly after `snapshotLog` (before `ownerOf`):

```javascript
/**
 * snapshotInvert(refA, refB, ctx) — the undo plan: diff two points (refB null
 * -> live board, one listItems read) and invert it into executable ops + a
 * manual list. Read-only: PROPOSES; execution is the user-approved move/route
 * verbs (see references/undo-contract.md).
 * @param {string} refA
 * @param {string|null} refB
 * @param {object} ctx { engine, config, dir }
 * @returns {Promise<{ops:object[], manual:object[], say:string}>}
 */
export async function snapshotInvert(refA, refB, ctx) {
  const dir = ctx.dir || process.cwd();
  const a = await readSnapshot(dir, refA);
  let bItems;
  let bName;
  if (refB) {
    const b = await readSnapshot(dir, refB);
    bItems = b.items;
    bName = b.takenAt;
  } else {
    const { items } = await ctx.engine.listItems();
    bItems = items || [];
    bName = 'live board';
  }
  const inv = invertDiff(diffSnapshots(a.items, bItems), (ctx.config && ctx.config.routing) || null);
  const moves = inv.ops.filter((o) => o.op === 'move').length;
  const routes = inv.ops.filter((o) => o.op === 'route').length;
  let say;
  if (inv.ops.length === 0 && inv.manual.length === 0) {
    say = `Nothing to undo between ${a.takenAt} and ${bName}.`;
  } else if (inv.ops.length === 0) {
    say = `No executable undo ops vs ${a.takenAt} — ${inv.manual.length} item(s) need manual attention.`;
  } else {
    say = `Undo plan vs ${a.takenAt} (vs ${bName}): ${inv.ops.length} op(s) (${moves} move(s), ${routes} reroute(s)); ${inv.manual.length} manual item(s). Execute via move/route after approval.`;
  }
  return { ops: inv.ops, manual: inv.manual, say };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/snapshot-verb.test.mjs`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/board-manager.mjs tests/snapshot-verb.test.mjs
git commit -m "feat(m5): snapshotInvert verb — read-only undo plans from snapshot diffs"
```

---

### Task 3: CLI wiring for `snapshot invert`

**Files:**
- Modify: `scripts/board-manager.mjs` (help text; Tier-0 snapshot block; `case 'snapshot'`)

- [ ] **Step 1: Help text.** After the `snapshot log [N]` line add (match column alignment):

```
  snapshot invert [<ref>] [<ref2>]      the undo plan: inverse ops to restore a point (read-only)
```

- [ ] **Step 2: Tier-0 guard.** In the pre-loadConfig snapshot block, the unknown-sub check currently lets only `take`/`diff` fall through to `loadConfig`. Add `invert` to the allowed set and to the usage string, e.g. change the guard to:

```javascript
      if (sub !== 'take' && sub !== 'diff' && sub !== 'invert') {
        throw new Error('usage: snapshot <take ["label"] | list | diff [<ref>] [<ref2>] | invert [<ref>] [<ref2>] | log [N]>');
      }
```

(Read the actual block first and adapt names; keep `list`/`log` handled in Tier-0 exactly as they are.)

- [ ] **Step 3: Dispatch.** In `case 'snapshot'` in the main switch, beside the `diff` branch:

```javascript
      if (sub === 'invert') {
        const r = await snapshotInvert(rest[1] || 'latest', rest[2] || null, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify({ ops: r.ops, manual: r.manual }, null, 2));
        return;
      }
```

Update the switch's defensive usage throw to include `invert` too.

- [ ] **Step 4: Verify** (all fs-only from the repo root — safe):
- `node scripts/board-manager.mjs --help` → the invert line renders.
- `node scripts/board-manager.mjs snapshot bogus` → usage error mentioning `invert`.
- `npm test` → 374 tests, 371 pass, 0 fail, 3 skipped.
- `git status --porcelain` → only the edited file.

- [ ] **Step 5: Commit**

```bash
git add scripts/board-manager.mjs
git commit -m "feat(m5): CLI wiring for snapshot invert"
```

---

### Task 4: Drift gates + prose catch-up (TDD for docs)

The gates are written FIRST and run RED against today's stale prose (e.g. `bootstrap`/`ledger`/`promote`/`sync`/`reconcile`/`snapshot` absent from SKILL.md); the prose rewrite turns them green. One commit at the end (suite must be green at every commit).

**Files:**
- Create: `tests/skill-evals.test.mjs`
- Modify: `skills/github-boards/SKILL.md` (full rewrite below)
- Create: `skills/github-boards/references/undo-contract.md`
- Create: `AGENTS.md`
- Modify: `commands/board.md`

- [ ] **Step 1: Write the gates.** Create `tests/skill-evals.test.mjs`:

```javascript
// tests/skill-evals.test.mjs — deterministic drift gates: the CLI's --help is
// the source of truth; the prose surfaces (SKILL.md, /board, AGENTS.md) must
// cover it, keep their promises, and stay mirrored. These gates exist because
// the prose once went two milestones stale without anything failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const help = execFileSync(process.execPath, [join(ROOT, 'scripts', 'board-manager.mjs'), '--help'], { encoding: 'utf8' });
const verbTokens = [...new Set(
  help.split('\n')
    .map((l) => /^ {2}([a-z][\w-]*)\b/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]),
)];

const skill = read('skills/github-boards/SKILL.md');
const command = read('commands/board.md');
const agents = read('AGENTS.md');

/** SKILL.md body = everything after the closing frontmatter fence. */
function bodyOf(md) {
  const m = /^---\n[^]*?\n---\n/.exec(md);
  if (!m) throw new Error('no frontmatter found');
  return md.slice(m[0].length).replace(/^\s+/, '');
}

test('gates meta: the help parser finds a sane verb count', () => {
  assert.ok(verbTokens.length >= 12, `only ${verbTokens.length} verb tokens parsed from --help (${verbTokens.join(', ')}) — parser or help format drifted`);
});

test('every CLI verb is documented in SKILL.md', () => {
  const missing = verbTokens.filter((v) => !skill.includes('`' + v));
  assert.deepEqual(missing, [], `SKILL.md is missing CLI verb(s): ${missing.join(', ')}`);
});

test('every CLI verb is documented in commands/board.md', () => {
  const missing = verbTokens.filter((v) => !command.includes('`' + v));
  assert.deepEqual(missing, [], `commands/board.md is missing CLI verb(s): ${missing.join(', ')}`);
});

test('critical verb+sub pairs appear in SKILL.md', () => {
  const pairs = ['map prepare', 'map record', 'promote plan', 'promote apply', 'sync scan', 'sync record',
    'reconcile scan', 'reconcile apply', 'snapshot take', 'snapshot list', 'snapshot diff', 'snapshot log', 'snapshot invert'];
  const missing = pairs.filter((p) => !skill.includes(p));
  assert.deepEqual(missing, [], `SKILL.md is missing pair(s): ${missing.join(', ')}`);
});

test('the six hard rules survive (sentinels)', () => {
  const sentinels = ['Preview before every write', 'Report back', 'Owner ≠ author', 'stays claimed',
    'Never attempt board view configuration', 'Fail closed'];
  const missing = sentinels.filter((s) => !skill.includes(s));
  assert.deepEqual(missing, [], `hard-rule sentinel(s) missing: ${missing.join(' | ')}`);
});

test('frontmatter trigger phrases survive', () => {
  const fmMatch = /^---\n([^]*?)\n---\n/.exec(skill);
  assert.ok(fmMatch, 'SKILL.md has no frontmatter');
  const fm = fmMatch[1];
  const phrases = ['put this on the board', "what's on my plate", 'what is Claude working on',
    'promote the backlog', 'sync my TODOs onto the board', 'heal the ledger',
    'what changed this week', 'what did the board look like before', 'undo what happened since'];
  const missing = phrases.filter((p) => !fm.includes(p));
  assert.deepEqual(missing, [], `trigger phrase(s) missing from frontmatter: ${missing.join(' | ')}`);
});

test('AGENTS.md mirrors the SKILL.md body byte-identically', () => {
  const marker = '<!-- BEGIN MIRROR -->\n';
  const idx = agents.indexOf(marker);
  assert.ok(idx >= 0, 'AGENTS.md is missing the <!-- BEGIN MIRROR --> marker');
  const mirrored = agents.slice(idx + marker.length).replace(/^\s+/, '');
  assert.equal(mirrored, bodyOf(skill), 'AGENTS.md mirror has drifted from the SKILL.md body — re-copy it');
});

test('references/ links in SKILL.md resolve to real files', () => {
  const refs = [...new Set([...skill.matchAll(/references\/[\w-]+\.md/g)].map((m) => m[0]))];
  assert.ok(refs.length >= 2, `expected at least 2 references/ links, found ${refs.length}`);
  for (const r of refs) {
    assert.ok(existsSync(join(ROOT, 'skills', 'github-boards', r)), `SKILL.md links ${r} but the file does not exist`);
  }
});
```

- [ ] **Step 2: Run to verify the gates are RED against today's prose**

Run: `node --test tests/skill-evals.test.mjs`
Expected: FAIL — at minimum: missing verbs in SKILL.md (`bootstrap`, `ledger`, `promote`, `sync`, `reconcile`, `snapshot`), missing pairs, missing trigger phrases, AGENTS.md missing entirely (read throws → test file errors; that counts as red — if the readFileSync throws at module load, temporarily seeing the whole file error is acceptable red).

NOTE: because `AGENTS.md` doesn't exist yet, the top-level `read('AGENTS.md')` throws and ALL tests in the file fail at load — that is the expected red state.

- [ ] **Step 3: Rewrite `skills/github-boards/SKILL.md`** with exactly this content:

````markdown
---
name: github-boards
description: "Manage a GitHub Projects v2 Kanban board in natural language. Use when the user wants to put tasks or issues on a board, see what they (the human) need to work on versus what the AI is working on, move cards between lanes, route work as agent-actionable or human-actionable, reject with learnings, summarize what changed on the board, promote mapped backlog onto the board, sync TODOs or other skills' plans onto the board, check or heal ledger drift, browse board history, or undo recent board changes. Also use when ANOTHER skill needs to record tasks onto the board after research or planning. Reads and edits the board via the gh CLI and GitHub GraphQL, always previewing changes before writing and reporting back. Trigger phrases: put this on the board, add to kanban, what's on my plate, what is Claude working on, move card, update the board, show board status, reject with learnings, promote the backlog, sync my TODOs onto the board, heal the ledger, what changed this week, what did the board look like before, undo what happened since."
allowed-tools: "Bash, Read, Write"
---

# GitHub Boards

Drive a GitHub Projects (v2) Kanban board for the user in plain language, and let other skills record work onto it. This instruction body is **vendor-neutral** (it must mirror to `AGENTS.md` with no rewrite) — all board logic lives in the bundled script, not in this prose.

> **STATUS:** the engine (`scripts/board.mjs`), the verb layer (`scripts/board-manager.mjs`), the ledger pipeline (sync → map → promote), reconcile, and snapshots are implemented and tested. Before first use, configure `board.json` — run `node "<skill-dir>/scripts/board.mjs" doctor` for the setup checklist.

## How to run it

All board operations go through the bundled Node script (never hand-built `gh`/GraphQL — the script carries the safety rules). Invoke it cross-platform with an absolute path:

```
node "<skill-dir>/scripts/board-manager.mjs" <verb> [args] --config <path-to/board.json>
```

If the board isn't configured yet, run `node "<skill-dir>/scripts/board.mjs" doctor` first — it checks `gh`/Node, finds the project/field IDs, and prints the one-time human board-setup checklist.

## The pipeline (which verb when)

```
sources (TODO.md, plans, other skills' artifacts)
  └─ sync scan / sync record ─► intent LEDGER ─► map prepare / map record ─► promote plan / promote apply ─► BOARD
                                                          maintenance loops:
                                                          reconcile scan/apply  (drift report → ledger-only healing)
                                                          snapshot …            (board memory + the permanent journal)
```

Direct verbs (`put`, `move`, `route`, …) act on the board immediately. The pipeline verbs batch work through the ledger so nothing is filed twice and every promotion is resumable.

## The verbs

| User intent | Verb | Notes |
|---|---|---|
| "Put this/these on the board" | `put` | Files real Issues → adds to board → sets starting lane + owner label |
| "What do I need to do?" | `queue --owner human` | The 🧍 cards (`needs-claude`) |
| "What is Claude working on?" | `queue --owner agent` | The 🤖 cards (`agent:go`) |
| "Move card X to Review" | `move` | Sets the `Stage` field |
| "This needs me" / "Hand to Claude" | `route` | Flips the owner label; on 🧍 keeps the card claimed and @-mentions the human |
| "Reject, keep the learnings" | `move … --reject` | Moves to *Rejected (learnings kept)* + records a note |
| "Claude found more work" | `followup` | Files a child/sub-issue back onto the board |
| "Set up / adjust the lanes" | `reshape` | Sets `Stage` options to the preset's columns + prints the UI-only view checklist |
| "What changed / show the board" | `summary` | Diffs vs. last-seen state and reports |
| "Set up a board from this repo" | `bootstrap` | One-time provisioning: project, Stage field, labels — from the current repo |
| "Note this for the board later" | `ledger` | Show or append raw intent candidates (the pipeline's inbox) |
| "Figure out what goes on the board / map these" | `map` | Strongest-model mapper: raw candidates → validated card proposals (lane/owner/split/merge), surfacing ambiguity. See `references/mapper-contract.md`. Records to the ledger; never writes the board directly. |
| "Promote the backlog" | `promote` | `promote plan` (read-only buckets) → `promote apply` (ledger candidates → real cards; cid markers; idempotent + resume-safe) |
| "Sync my TODOs / record this skill's tasks" | `sync` | `sync scan` (read-only: what changed in watched files) → `sync record` (extracted items → ledger). Nothing touches the board until `promote`. |
| "Is the board out of sync? / heal the ledger" | `reconcile` | `reconcile scan` (drift report) → `reconcile apply` (gated healing — writes the LEDGER only, never the board) |
| "What did the board look like / board history" | `snapshot` | `snapshot take` (manual save-point) · `snapshot list` · `snapshot diff` (what changed between two points) · `snapshot log` (the permanent event journal). All read-only toward the board. |
| "Undo what happened since X" | `snapshot invert` | Computes the inverse plan (read-only); execute it via `move`/`route` after approval. See `references/undo-contract.md`. |

> **Mapping (M2):** to turn collected candidates into card proposals, run `map prepare` for the input packet, reason per `references/mapper-contract.md` (escalating to a stronger model when it says to), then `map record --proposals <file>`.

## Unprompted context (the hooks)

This plugin's hooks feed you board context without being asked:

- **Session start:** a board digest (what changed since the last look) is injected automatically — do not re-run `summary` at the start of a session just to orient; it already ran.
- **While editing:** when a watched source file (`board.json` → `sources.watch`) changes, a one-line note appears once per file per session. That is the cue to OFFER `sync scan` — not to run the pipeline silently.

## The undo reflex

When the user asks to undo or roll back board changes ("undo what happened since this morning", "put it back how it was"):

1. Run `snapshot invert <ref>` — it prints the inverse plan: `ops` (executable) and `manual` (never auto-executed).
2. Show both lists to the user; on approval execute `ops` one by one via `move`/`route`.
3. Report back what was restored and what remains manual. Full contract: `references/undo-contract.md`.

## Hard rules (do not violate)

1. **Preview before every write.** Run the verb in staged/preview mode first, show the user the exact diff (cards, lanes, labels), and only commit on explicit approval. Never write to the board silently.
2. **Report back.** After a committed change, state plainly what changed and what's on each plate, e.g. *"✅ Filed 3 cards, moved #12 → Review. On your plate: 2 forms to submit. Claude's queue: 4 tasks."*
3. **Owner ≠ author.** The 🤖/🧍 signal is *who should act* (`agent:go` / `needs-claude` labels), separate from who authored the card.
4. **A 🧍 card stays claimed and escalates** — never silently parked. Keep its owner and post a GitHub mention/assignment so the human queue is real.
5. **Never attempt board view configuration.** Layout / group-by is browser-only. `reshape` sets data (Stage options, fields) and prints a human checklist for the view; it never claims to set the view itself.
6. **Fail closed.** On missing/ambiguous config or inaccessible board, stop with a clear message — don't guess.

## Routing (🤖 vs 🧍)

Marked by labels already understood by the board: `agent:go` = Claude-actionable, `needs-claude` = human-actionable. `route` flips them; `queue --owner …` filters them. The two "plates" are just two filtered views over the one board.

## Configuration

`board.json` binds to a board via `projectId`, `stageFieldId`, the `stageOptions` (lane label → option-id) map, `preset` (lane-shape template), and `routing` labels (`agent`/`human`). Lanes are **read from config** — a software board and a grants board can have different columns with no code change. Optional blocks: `sources` (`watch` globs + per-skill profiles for `sync`) and `snapshots` (`keep`, default 50). `doctor` discovers the IDs.

## Being called by another skill

Other skills may invoke this one to record work: *"use the github-boards skill to put these tasks on the board."* When called this way: file the tasks via `put` (or, for batches that should dedup and resume, `ledger`/`sync record` → `map` → `promote`), still show the staged preview + get approval (unless the caller explicitly runs in an approved/unattended context), and return the report-back so the calling skill can relay it. See `docs/COMPOSABILITY.md` for the full contract.

## Memory

Before summarizing, read `.github-boards/state.json` (the last-seen board digest) to report *what changed*; update it after. Longer-range memory lives in `.github-boards/snapshots/` — pruned full board states plus `log.jsonl`, the append-only event journal that is never pruned; `snapshot diff` and `snapshot log` read them. The board is always the source of truth — the state files are delete-safe markers.
````

- [ ] **Step 4: Create `skills/github-boards/references/undo-contract.md`:**

````markdown
# The Undo Contract

How to undo board changes conversationally. The snapshot store is read-only toward the board; **all undo writes go through the existing approval-gated verbs** (`move`, `route`). There is no batch restore.

## When to trigger

The user asks to undo, roll back, revert, or "put the board back how it was" — optionally anchored to a point ("since this morning", "before the cleanup"). Resolve the anchor to a snapshot ref: `latest`, `~N` (1-based age), or an ISO date/time prefix (`2026-06-10`, `2026-06-10T09`). `snapshot list` shows what exists.

## The four steps

1. **Compute:** `node "<skill-dir>/scripts/board-manager.mjs" snapshot invert <ref> --config <path>` (add `<ref2>` to undo between two stored points; omitted = vs the live board). Output: `say` + JSON `{ops, manual}`.
2. **Preview:** show the user BOTH lists —
   - `ops`: each `{op:'move', issueNumber, to}` ("move #N back to <lane>") and `{op:'route', issueNumber, to}` ("route #N back to agent/human").
   - `manual`: items the verbs cannot restore, each with its `reason` (added cards are never auto-deleted; removed cards are never recreated; retitles and non-owner label changes have no verb).
3. **Execute on approval:** run each op via the normal verbs, in the listed order (moves first, then reroutes):
   - `move <issueNumber> <to>` · `route <issueNumber> <to>`
   - The user may approve a subset — execute only what they approved. `--staged` previews any single op.
4. **Report back:** what was restored, what was skipped, what remains manual.

## Invariants

- Never execute without showing the plan first (hard rule 1 applies to every op).
- Never act on `manual` items — surface them; the human decides.
- An empty `ops` with non-empty `manual` is a valid outcome: say so plainly and stop.
- `snapshot invert` itself never writes; if anything in the flow fails mid-way, re-running `snapshot invert` recomputes the remaining delta safely (already-restored cards drop out of the diff).
````

- [ ] **Step 5: Create `AGENTS.md`** (repo root) as: the header below, then the marker line, then **the exact SKILL.md body** (everything after the closing `---` of the frontmatter, starting at `# GitHub Boards`) — copy it byte-for-byte; the gate compares them:

```markdown
# github-boards — agent instructions (vendor-neutral mirror)

> This file mirrors `skills/github-boards/SKILL.md` for agents that don't read Claude skill frontmatter. **Do not edit below the marker** — edit SKILL.md and re-copy its body; `tests/skill-evals.test.mjs` enforces identity.

<!-- BEGIN MIRROR -->
```

(then the SKILL.md body, verbatim)

- [ ] **Step 6: Update `commands/board.md`** with exactly this content:

````markdown
---
description: Drive your GitHub Projects board in natural language — see your queue vs. Claude's, put/move/route/reject cards, run the ledger pipeline (sync/map/promote), heal drift, browse history, and report what changed. With no args, shows a summary.
argument-hint: "[verb] [args...]  (e.g. summary | queue human | put \"Fix login\" | move 41 Building | snapshot diff)"
---

Run the board verb layer with the user's arguments. Default to `summary` when no verb is given.

Execute this Bash command (the board script lives at the plugin root; `CLAUDE_PLUGIN_ROOT` resolves after install, and falls back to `.` when run from the repo):

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/scripts/board-manager.mjs" ${ARGUMENTS:-summary}
```

Here `$ARGUMENTS` is the full argument string the user typed after `/board`. If it is empty, the script is invoked with `summary`.

Then relay the script's first stdout line (the human-readable `say`) back to the user verbatim. The verbs available are: `summary`, `queue <agent|human>`, `put "<title>" [owner] [lane]`, `move <card#> <lane>`, `reject <card#> "<learnings>"`, `route <card#> <agent|human>`, `followup <parent#> "<title>" [owner]`, `reshape <preset>`, `bootstrap [--preset …]`, `ledger [add "<title>"]`, `map prepare|record`, `promote plan|apply`, `sync scan|record`, `reconcile scan|apply`, `snapshot take|list|diff|log|invert`. Add `--staged` to preview any write without committing. `snapshot list|log` and `sync scan` work before a board is configured; everything else needs `board.json`.

If the script exits non-zero (e.g. no `board.json` configured, or `gh` not authenticated), report the error line plainly and suggest the user copy `board.example.json` to `board.json` and run `gh auth login` — do not retry blindly.
````

- [ ] **Step 7: Run the gates to verify GREEN**

Run: `node --test tests/skill-evals.test.mjs`
Expected: PASS (8 tests). If the mirror test fails, re-copy the SKILL.md body into AGENTS.md below the marker (watch for editor-introduced CRLF differences — the gate normalizes `\r\n`, so a mismatch means real content drift).

- [ ] **Step 8: Full suite + commit**

Run: `npm test` → 382 tests, 379 pass, 0 fail, 3 skipped.

```bash
git add tests/skill-evals.test.mjs skills/github-boards/SKILL.md skills/github-boards/references/undo-contract.md AGENTS.md commands/board.md
git commit -m "feat(m5): drift gates + prose catch-up — SKILL.md/AGENTS.md/board command teach the full pipeline"
```

---

### Task 5: Cross-module undo round-trip (the standing lesson)

**Files:**
- Test: `tests/undo-pipeline.test.mjs` (new)

The undo plan must restore a board that was mutated through the REAL verbs, executed back through the REAL verbs — no hand-built diffs anywhere.

- [ ] **Step 1: Write the test.** Create `tests/undo-pipeline.test.mjs`:

```javascript
// tests/undo-pipeline.test.mjs — REAL chain: put files the card, real move/route
// mutate the board, snapshotInvert computes the plan, and the SAME real verbs
// execute it back to baseline. No hand-built diffs (MEMORY: real upstream only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { put, move, route, snapshotTake, snapshotInvert, snapshotDiff } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  preset: { lanes: [{ name: 'Ideas' }, { name: 'Building' }] },
};

/** Stateful mock board: listItems reflects setStage/setLabels/removeLabels.
 *  Label semantics mirror the real engine: setLabels ADDS, removeLabels removes
 *  (route's "add the new owner's label, remove the other's" depends on this). */
function makeBoard() {
  const issues = [];
  let n = 0;
  const stages = new Map();
  const labels = new Map();
  return makeMockEngine({
    createIssue: (title, body) => {
      n += 1;
      issues.push({ number: n, url: `https://github.com/o/r/issues/${n}`, issueNodeId: `node${n}`, title, body });
      return issues[issues.length - 1];
    },
    addIssueToBoard: (url) => ({ itemId: `item-${url.split('/').pop()}` }),
    setStage: (itemId, lane) => { stages.set(itemId, lane); return { ok: true }; },
    setLabels: (issueNumber, ls) => {
      labels.set(issueNumber, [...new Set([...(labels.get(issueNumber) || []), ...ls])]);
      return { ok: true };
    },
    removeLabels: (issueNumber, ls) => {
      labels.set(issueNumber, (labels.get(issueNumber) || []).filter((l) => !ls.includes(l)));
      return { ok: true };
    },
    comment: () => ({ ok: true }),
    listItems: () => ({
      items: issues.map((i) => ({
        itemId: `item-${i.number}`, contentType: 'Issue', issueNumber: i.number, title: i.title,
        state: 'OPEN', repo: 'o/r',
        stageLabel: stages.get(`item-${i.number}`) ?? null,
        labels: labels.get(i.number) ?? [],
      })),
      count: issues.length,
    }),
  });
}

test('REAL chain: put -> baseline -> real move+route mutations -> invert -> real move/route restore -> diff is empty', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-undo-'));
  const engine = makeBoard();

  // Real put: create -> add -> stage -> label.
  await put([{ title: 'Wire retry', lane: 'Ideas', owner: 'agent' }], { engine, config: CFG, staged: false });
  await snapshotTake('baseline', { engine, config: CFG, dir });

  // "What happened": a relane and an owner flip — through the REAL verbs.
  await move(1, 'Building', { engine, config: CFG, staged: false });
  await route(1, 'human', { engine, config: CFG, staged: false });

  // The mechanical undo plan.
  const plan = await snapshotInvert('latest', null, { engine, config: CFG, dir });
  assert.equal(plan.ops.length, 2, `expected 2 ops, got ${JSON.stringify(plan.ops)}`);
  assert.deepEqual(plan.ops.map((o) => o.op), ['move', 'route']);
  assert.deepEqual(plan.manual, []);

  // Execute the plan through the same approval-gated verbs the contract names.
  for (const op of plan.ops) {
    if (op.op === 'move') await move(op.issueNumber, op.to, { engine, config: CFG, staged: false });
    if (op.op === 'route') await route(op.issueNumber, op.to, { engine, config: CFG, staged: false });
  }

  // The board is back at baseline.
  const after = await snapshotDiff('latest', null, { engine, config: CFG, dir });
  assert.deepEqual(after.diff, { moved: [], added: [], removed: [], relabeled: [], retitled: [] });
});
```

- [ ] **Step 2: Run**

Run: `node --test tests/undo-pipeline.test.mjs`
Expected: PASS (1 test). Before trusting a pass, sanity-check the mock against reality: `route` in `board-manager.mjs` calls `engine.setLabels(card, [newLabel])` then `engine.removeLabels(card, [oldLabel])` — additive + subtractive — and `move` resolves the itemId via `listItems`. If the test fails after faithful wiring, that is a real cross-module bug: investigate and report (DONE_WITH_CONCERNS); never bend assertions.

- [ ] **Step 3: Full suite + commit**

Run: `npm test` → 383 tests, 380 pass, 0 fail, 3 skipped.

```bash
git add tests/undo-pipeline.test.mjs
git commit -m "test(m5): real-verb undo round-trip — mutate, invert, restore, diff empty"
```

---

### Task 6: The gated LLM eval harness

**Files:**
- Create: `evals/scenarios.json`
- Create: `scripts/eval-skill.mjs`
- Modify: `tests/skill-evals.test.mjs` (append 2 gate tests; extend imports with `spawnSync` from `node:child_process`)

- [ ] **Step 1: Create `evals/scenarios.json`:**

```json
[
  { "id": "put-1",          "say": "put this on the board: fix the login bug",                       "expectVerb": "put" },
  { "id": "queue-human",    "say": "what's on my plate?",                                            "expectVerb": "queue" },
  { "id": "queue-agent",    "say": "what is Claude working on right now?",                           "expectVerb": "queue" },
  { "id": "move-1",         "say": "move card 41 to Building",                                       "expectVerb": "move" },
  { "id": "route-1",        "say": "card 12 actually needs me, not Claude",                          "expectVerb": "route" },
  { "id": "reject-1",       "say": "reject #7 but keep the learnings",                               "expectVerb": "reject" },
  { "id": "summary-1",      "say": "what changed on the board since yesterday?",                     "expectVerb": "summary" },
  { "id": "followup-1",     "say": "Claude found two more tasks while working #5 — file them under it", "expectVerb": "followup" },
  { "id": "map-1",          "say": "figure out which of these meeting notes belong on the board",    "expectVerb": "map" },
  { "id": "promote-1",      "say": "promote the mapped backlog onto the board",                      "expectVerb": "promote" },
  { "id": "sync-1",         "say": "sync my TODO file onto the board",                               "expectVerb": "sync" },
  { "id": "reconcile-1",    "say": "I think the ledger is out of sync with the board — heal it",     "expectVerb": "reconcile" },
  { "id": "snapshot-hist",  "say": "what did the board look like before yesterday's cleanup?",       "expectVerb": "snapshot" },
  { "id": "undo-1",         "say": "undo everything that happened on the board since this morning",  "expectVerb": "snapshot", "expectArgs": "invert" },
  { "id": "neg-code-move",  "say": "move this function into utils.mjs",                              "expectVerb": null },
  { "id": "neg-screenshot", "say": "take a screenshot of the homepage",                              "expectVerb": null },
  { "id": "neg-gpu",        "say": "what's the best graphics card for gaming?",                      "expectVerb": null }
]
```

- [ ] **Step 2: Create `scripts/eval-skill.mjs`:**

```javascript
#!/usr/bin/env node
// scripts/eval-skill.mjs — GATED LLM scenario evals for the github-boards skill.
// Grades verb selection: would a model reading SKILL.md pick the right verb for
// each evals/scenarios.json fixture? ADVISORY — tune the prose, not the fixtures.
//
// SAFETY: refuses without GBS_EVAL=1 (operator-only; each scenario is a real
// model call). NEVER wire this into npm test, CI, or any automated loop.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.GBS_EVAL !== '1') {
  console.error('eval-skill: refusing to run — set GBS_EVAL=1 (operator-only; this makes real model calls).');
  process.exit(1);
}

const MODEL = process.env.GBS_EVAL_MODEL || 'haiku';
let scenarios;
try {
  scenarios = JSON.parse(readFileSync(join(ROOT, 'evals', 'scenarios.json'), 'utf8'));
} catch (e) {
  console.error(`eval-skill: cannot read evals/scenarios.json (${e.message})`);
  process.exit(1);
}
const skill = readFileSync(join(ROOT, 'skills', 'github-boards', 'SKILL.md'), 'utf8');

const results = [];
for (const s of scenarios) {
  const prompt = [
    'You are an AI coding assistant. The following skill is installed:',
    '--- SKILL ---',
    skill,
    '--- END SKILL ---',
    `The user says: ${JSON.stringify(s.say)}`,
    'If this message should trigger one of the skill\'s board verbs, name the verb.',
    'Answer with ONLY compact JSON, nothing else:',
    '{"verb": "<first word of the verb: queue|put|move|reject|route|followup|reshape|summary|bootstrap|ledger|map|promote|sync|reconcile|snapshot>", "args": "<sub-verb/args or empty>"}',
    'or {"verb": null} if no board verb applies.',
  ].join('\n');

  const r = spawnSync('claude', ['-p', '--output-format', 'text', '--model', MODEL], {
    input: prompt,
    encoding: 'utf8',
    shell: process.platform === 'win32', // .cmd shim
    timeout: 120000,
  });
  if (r.error || r.status === null) {
    console.error(`eval-skill: failed to run the claude CLI (${r.error ? r.error.message : 'timeout'}) — is it installed and on PATH?`);
    process.exit(1);
  }
  let got = '(unparseable)';
  let args = '';
  try {
    const m = (r.stdout || '').match(/\{[^]*?\}/);
    const parsed = JSON.parse(m ? m[0] : '{}');
    got = 'verb' in parsed ? parsed.verb : '(unparseable)';
    args = typeof parsed.args === 'string' ? parsed.args : '';
  } catch { /* counted as a failure below */ }
  let pass = got === s.expectVerb;
  if (pass && s.expectArgs) pass = args.includes(s.expectArgs);
  results.push({ id: s.id, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${s.id}  expected=${JSON.stringify(s.expectVerb)}${s.expectArgs ? `+${s.expectArgs}` : ''}  got=${JSON.stringify(got)}${args ? ` args=${JSON.stringify(args)}` : ''}`);
}

const passed = results.filter((x) => x.pass).length;
console.log(`\nScorecard: ${passed}/${results.length} — advisory; tune SKILL.md prose, not the scenarios.`);
```

- [ ] **Step 3: Append the two deterministic gates** to `tests/skill-evals.test.mjs` (and add `spawnSync` to its `node:child_process` import):

```javascript
test('evals/scenarios.json is valid and covers negatives', () => {
  const sc = JSON.parse(read('evals/scenarios.json'));
  assert.ok(Array.isArray(sc) && sc.length >= 15, `expected >=15 scenarios, found ${sc.length}`);
  assert.ok(sc.filter((s) => s.expectVerb === null).length >= 3, 'need >=3 negative scenarios (expectVerb: null)');
  for (const s of sc) {
    assert.ok(s.id && typeof s.say === 'string' && 'expectVerb' in s, `malformed scenario: ${JSON.stringify(s)}`);
  }
});

test('eval runner refuses without GBS_EVAL=1 (the gate is the enforcement)', () => {
  const env = { ...process.env };
  delete env.GBS_EVAL;
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'eval-skill.mjs')], { encoding: 'utf8', env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /GBS_EVAL=1/);
});
```

- [ ] **Step 4: Verify.** `node --test tests/skill-evals.test.mjs` → PASS (10 tests). Do NOT run the harness itself (`GBS_EVAL` stays unset — the refusal test just proved the gate).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → 385 tests, 382 pass, 0 fail, 3 skipped.

```bash
git add evals/scenarios.json scripts/eval-skill.mjs tests/skill-evals.test.mjs
git commit -m "feat(m5): gated LLM eval harness — scenario fixtures, claude -p runner, refusal gate"
```

---

## Self-Review (run after all tasks)

1. **Spec coverage:** §2 prose surfaces → Task 4; `invertDiff` (§4) → Task 1; `snapshotInvert` + CLI (§4) → Tasks 2–3; drift gates (§3/§4/§6.3) → Task 4; cross-module round-trip (§6.4) → Task 5; harness + refusal + scenario gates (§4/§6.5) → Task 6; §7 resolutions recorded in the File Structure preamble. No new live surface.
2. **Placeholder scan:** none — complete file contents in every step (AGENTS.md body is an exact copy operation, specified mechanically).
3. **Type consistency:** `invertDiff(diff, routing)` → `{ops, manual}` with op shapes `{op:'move', itemId, issueNumber, title, to}` / `{op:'route', itemId, issueNumber, title, to:'agent'|'human'}` used identically in Tasks 1, 2, 5 and `undo-contract.md`; `snapshotInvert(refA, refB, ctx)` → `{ops, manual, say}` consistent across Tasks 2, 3, 5; gate helpers (`read`, `bodyOf`, `verbTokens`) defined once in Task 4 and reused by Task 6's appends.
