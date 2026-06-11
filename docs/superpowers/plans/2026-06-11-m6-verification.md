# M6 Verification & Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared simulation world (stateful mock board + temp repo + real session boundaries + fault injection + invariants), crash-atlas recovery scenarios, three composition stories, a seeded soak, and one operator-gated live E2E with a runbook.

**Architecture:** `tests/helpers/sim-world.mjs` wraps the proven stateful-mock pattern with a session model (`newSession()` runs the REAL `summary`, piggyback included), an op vocabulary that calls ONLY real verbs/libs, one-shot fault injection at the engine and ledger-path seams (reachable crashes only — no hand-mutated state), and `checkInvariants()` built on the real `classifyDrift`. Scenarios, soak, and self-tests all consume the same world.

**Tech Stack:** Node ≥18 (ESM), `node:test`, no third-party deps. The soak PRNG is an inline LCG. No LLM calls; live E2E gated behind `GBS_LIVE=1` and never executed by implementers or reviewers.

**Spec:** [docs/superpowers/specs/2026-06-11-m6-verification-design.md](../specs/2026-06-11-m6-verification-design.md)

---

## SAFETY (all roles)
- NEVER set or export `GBS_LIVE=1` or `GBS_EVAL=1`. Task 7 WRITES the live test and runbook but NOBODY runs them — the 3 existing gated skips become 4; review is read-only.
- NEVER run `node --test tests/` bare (MODULE_NOT_FOUND) — specific files or `npm test`.
- NEVER `git push`.

## Verified signatures (checked against the code at plan time — if reality differs, adapt and report)
- `promoteApply(decisions, ctx{engine,config,staged,dir})` per-item card chain: `createIssue` → `writeLedger` (refs) → `addIssueToBoard` → `writeLedger` (itemId) → `setStage` → `setLabels` → `writeLedger` (status `promoted`). Per-item try/catch → `report.partial`; already-promoted → skipped (resume-safe). Card body = `bodyFor(cand, cid)` embedding `cidMarker(cid)`.
- `syncRecord(ctx{dir, config, extracted})` — validates, then appends per item with content-hash-id dedup (`added`/`deduped`); re-run with the same extraction dedups.
- `reconcileScan(ctx{engine,dir})` → `{drift{safeHeals,resumePending,uncertain,duplicates,clean}, say}` via `classifyDrift({ledger, items, sourceExists})` over `listItemsWithBodies`. `reconcileApply(decisions, ctx)` (throws on `ctx.staged`).
- `applyProposals(ledger, proposals, config)` → `{ledger}` — proposal `{candidateId, kind:'card', title, lane, owner, confidence, rationale}`.
- `summary(ctx{engine,config,staged,dir})` — listItems → diff vs state → writeState → optional teamSync → non-fatal `writeSnapshot` piggyback.
- `move(card, lane, ctx)` (resolves itemId via listItems), `route(card, owner, ctx)` (additive `setLabels` + `removeLabels`; comments on `human`), `put(tasks, ctx)`.
- snapshots lib: `writeSnapshot(dir, items, {label,keep})`, `listSnapshots(dir)`, `readLog(dir,n)` → `{entries,skippedLines}`, `resolveKeep(config)`, `diffSnapshots`, `invertDiff(diff, routing)`; verbs `snapshotTake(label,ctx)`, `snapshotInvert(refA,refB,ctx)`, `snapshotDiff(refA,refB,ctx)`.
- ledger lib: `readLedger(dir)`, `writeLedger(dir, ledger)`, candidates `{id, title, source?, status('pending'|'mapped'|…|'promoted'|'dismissed'), promotion?{issueNumber,issueUrl,issueNodeId,itemId}, …}` under `.github-boards/ledger.json`. (Verify the exact pre-promotion status values `classify` requires by reading `classify`/`applyProposals` before Task 2.)
- `makeMockEngine(overrides)` (tests/helpers/mock-engine.mjs) records `{op, args}` into `.calls`; overrides supply behavior.

**Test baseline:** 387 tests (384 pass, 3 gated skips). Per-task deltas listed; report actuals.

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `tests/helpers/sim-world.mjs` | **New** | `makeWorld()` — dir, stateful engine (+`failNext`), board backdoors (archive/retitle), `newSession`, ops vocabulary, faults, `checkInvariants`, soak helpers (`lcg`, `opTrace`). |
| `tests/sim-world.test.mjs` | **New** | World self-tests: mock semantics, fault one-shots, invariant checker non-vacuous. |
| `tests/sim-scenarios.test.mjs` | **New** | Crash-atlas rows A1–A4, B1, B2, C1, D1, E1 + 3 composition stories. |
| `tests/sim-soak.test.mjs` | **New** | Seeded soak: 4 seeds × 120 steps, invariants after every step. |
| `tests/live-e2e.test.mjs` | **New** | Gated live E2E (4th skip). NOT RUN in this milestone. |
| `docs/LIVE-RUNBOOK.md` | **New** | Operator instructions. |

---

### Task 1: World core — engine, faults, backdoors (+self-tests)

**Files:**
- Create: `tests/helpers/sim-world.mjs`
- Test: `tests/sim-world.test.mjs` (new)

- [ ] **Step 1: Write the failing self-tests.** Create `tests/sim-world.test.mjs`:

```javascript
// tests/sim-world.test.mjs — the harness must not be trusted untested: mock
// semantics, fault one-shots, and (Task 3) a deliberate invariant violation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/sim-world.mjs';

test('world board: setLabels is ADDITIVE, removeLabels subtractive (route depends on it)', async () => {
  const w = await makeWorld();
  const issue = await w.engine.createIssue('Card A', 'body');
  await w.engine.setLabels(issue.number, ['agent:go']);
  await w.engine.setLabels(issue.number, ['bug']);
  await w.engine.removeLabels(issue.number, ['agent:go']);
  await w.engine.addIssueToBoard(issue.url, {});
  const { items } = await w.engine.listItems();
  assert.deepEqual([...items[0].labels].sort(), ['bug']);
});

test('world board: archiveCard hides from listItems; retitle is visible', async () => {
  const w = await makeWorld();
  const a = await w.engine.createIssue('Card A', '');
  const b = await w.engine.createIssue('Card B', '');
  await w.engine.addIssueToBoard(a.url, {});
  await w.engine.addIssueToBoard(b.url, {});
  w.board.retitle(a.number, 'Card A renamed');
  w.board.archiveCard(b.number);
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Card A renamed');
});

test('world board: listItemsWithBodies carries the issue body (cid markers live there)', async () => {
  const w = await makeWorld();
  const a = await w.engine.createIssue('Card A', 'hello <!-- marker -->');
  await w.engine.addIssueToBoard(a.url, {});
  const { items } = await w.engine.listItemsWithBodies();
  assert.match(items[0].body, /<!-- marker -->/);
});

test('faults: failNext fires exactly once, then clears', async () => {
  const w = await makeWorld();
  w.engine.failNext('setStage');
  const a = await w.engine.createIssue('Card A', '');
  const it = await w.engine.addIssueToBoard(a.url, {});
  await assert.rejects(() => w.engine.setStage(it.itemId, 'Ideas', {}), /injected: setStage/);
  await w.engine.setStage(it.itemId, 'Ideas', {}); // second call succeeds
  const { items } = await w.engine.listItems();
  assert.equal(items[0].stageLabel, 'Ideas');
});

test('faults: failNext onCall targets the Nth call (batch windows)', async () => {
  const w = await makeWorld();
  w.engine.failNext('createIssue', { onCall: 2 });
  await w.engine.createIssue('first', '');                       // call 1 fine
  await assert.rejects(() => w.engine.createIssue('second', ''), /injected: createIssue/);
  await w.engine.createIssue('third', '');                       // cleared
});

test('faults: sabotageLedgerOnce makes the NEXT ledger write fail, then auto-repairs', async () => {
  const w = await makeWorld();
  const { writeLedger, readLedger } = await import('../scripts/lib/ledger.mjs');
  await writeLedger(w.dir, { candidates: [] }); // ledger exists
  w.faults.sabotageLedgerOnce();
  await assert.rejects(() => writeLedger(w.dir, { candidates: [] }));
  w.faults.repairLedger();
  await writeLedger(w.dir, { candidates: [{ id: 'x', title: 't', status: 'pending' }] });
  assert.equal((await readLedger(w.dir)).candidates.length, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/sim-world.test.mjs`
Expected: FAIL — cannot find `./helpers/sim-world.mjs`

- [ ] **Step 3: Implement the world core.** Create `tests/helpers/sim-world.mjs`:

```javascript
// tests/helpers/sim-world.mjs — the M6 simulation world.
//
// One stateful mock board + one temp repo dir + REAL verbs only. Crash windows
// are produced exclusively at reachable seams: one-shot engine-op throws
// (failNext — how network death presents to the verb layer) and ledger-path
// sabotage (how fs death presents to writeLedger). Persisted state is NEVER
// hand-mutated (MEMORY: reachable states only).
import { mkdtempSync, mkdirSync, rmdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { makeMockEngine } from './mock-engine.mjs';

export const WORLD_CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2', Review: 'o3' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  preset: { lanes: [{ name: 'Ideas' }, { name: 'Building' }, { name: 'Review' }] },
  rules: { promoteConfidenceBelow: 0.8 },
  snapshots: { keep: 50 },
};

export async function makeWorld({ config } = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-sim-'));
  const cfg = config || WORLD_CFG;

  // ---- board state (mutated ONLY via engine ops + the two GitHub-UI backdoors)
  const issues = [];            // {number, url, issueNodeId, title, body}
  let n = 0;
  const stages = new Map();     // itemId -> lane
  const labels = new Map();     // issueNumber -> string[]
  const onBoard = new Set();    // issueNumber
  const archived = new Set();   // issueNumber (GitHub-UI archive: off listItems)

  // ---- fault state
  const fail = new Map();       // op -> {countdown}
  function maybeFail(op) {
    const f = fail.get(op);
    if (!f) return;
    f.countdown -= 1;
    if (f.countdown <= 0) {
      fail.delete(op);
      throw new Error(`injected: ${op} died`);
    }
  }

  const itemsView = (withBodies) => issues
    .filter((i) => onBoard.has(i.number) && !archived.has(i.number))
    .map((i) => ({
      itemId: `item-${i.number}`, contentType: 'Issue', issueNumber: i.number, title: i.title,
      state: 'OPEN', repo: 'o/r',
      stageLabel: stages.get(`item-${i.number}`) ?? null,
      labels: labels.get(i.number) ?? [],
      ...(withBodies ? { body: i.body ?? '', issueUrl: i.url } : {}),
    }));

  const engine = makeMockEngine({
    createIssue: (title, body) => {
      maybeFail('createIssue');
      n += 1;
      const issue = { number: n, url: `https://github.com/o/r/issues/${n}`, issueNodeId: `node${n}`, title, body };
      issues.push(issue);
      return issue;
    },
    addIssueToBoard: (url) => {
      maybeFail('addIssueToBoard');
      const num = Number(url.split('/').pop());
      onBoard.add(num);
      return { itemId: `item-${num}` };
    },
    setStage: (itemId, lane) => { maybeFail('setStage'); stages.set(itemId, lane); return { ok: true }; },
    setLabels: (issueNumber, ls) => {
      maybeFail('setLabels');
      labels.set(issueNumber, [...new Set([...(labels.get(issueNumber) || []), ...ls])]);
      return { ok: true };
    },
    removeLabels: (issueNumber, ls) => {
      maybeFail('removeLabels');
      labels.set(issueNumber, (labels.get(issueNumber) || []).filter((l) => !ls.includes(l)));
      return { ok: true };
    },
    comment: () => { maybeFail('comment'); return { ok: true }; },
    listItems: () => ({ items: itemsView(false), count: itemsView(false).length }),
    listItemsWithBodies: () => ({ items: itemsView(true), count: itemsView(true).length }),
  });
  /** One-shot fault: the (onCall)th future call of `op` throws. */
  engine.failNext = (op, { onCall = 1 } = {}) => { fail.set(op, { countdown: onCall }); };

  // ---- GitHub-UI backdoors (real humans can do these in the browser; the
  // verbs cannot — they exist so scenarios/soak can exercise vanished/retitled)
  const board = {
    archiveCard: (num) => { archived.add(num); },
    retitle: (num, title) => { const i = issues.find((x) => x.number === num); if (i) i.title = title; },
  };

  // ---- ledger-path fault (how a dying fs presents to writeLedger: the path
  // becomes unwritable; readers that already read are unaffected)
  const ledgerPath = join(dir, '.github-boards', 'ledger.json');
  const ledgerBak = join(dir, '.github-boards', 'ledger.json.bak');
  const faults = {
    sabotageLedgerOnce() {
      // a DIRECTORY at the file path -> next writeFile throws (EISDIR/EPERM)
      if (existsSync(ledgerPath)) renameSync(ledgerPath, ledgerBak);
      mkdirSync(ledgerPath, { recursive: true });
    },
    repairLedger() {
      rmdirSync(ledgerPath);
      if (existsSync(ledgerBak)) renameSync(ledgerBak, ledgerPath);
    },
    sabotageSnapshotsDirOnce() {
      mkdirSync(join(dir, '.github-boards'), { recursive: true });
      writeFileSync(join(dir, '.github-boards', 'snapshots'), 'not a dir', 'utf8');
    },
  };

  return { dir, config: cfg, engine, board, faults, _internal: { issues, stages, labels, onBoard, archived } };
}
```

(`_internal` is exposed ONLY for Task 3's deliberate-violation backdoor and world self-tests — scenarios and the soak never touch it.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/sim-world.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/sim-world.mjs tests/sim-world.test.mjs
git commit -m "test(m6): sim-world core — stateful board, one-shot faults, GitHub-UI backdoors"
```

---

### Task 2: Session model + ops vocabulary (+self-tests)

**Files:**
- Modify: `tests/helpers/sim-world.mjs`
- Test: `tests/sim-world.test.mjs` (append)

- [ ] **Step 1: Append the failing self-tests** to `tests/sim-world.test.mjs`:

```javascript
test('ops: full pipeline round — seedTodo -> pipelineSync -> mapAll -> promoteAll lands cards', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['Wire retry', 'Decide hosting']);
  const rec = await w.ops.pipelineSync();
  assert.equal(rec.added.length, 2);
  await w.ops.mapAll();
  const rep = await w.ops.promoteAll();
  assert.equal(rep.report.promoted.length, 2);
  const { items } = await w.engine.listItems();
  assert.deepEqual(items.map((i) => i.title).sort(), ['Decide hosting', 'Wire retry']);
  assert.ok(items.every((i) => i.stageLabel === 'Ideas' && i.labels.includes('agent:go')));
});

test('ops: newSession runs REAL summary (snapshot piggyback included) and returns the say', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  const say1 = await w.newSession();
  assert.match(say1, /First look|Since last time/);
  const { listSnapshots } = await import('../scripts/lib/snapshots.mjs');
  assert.equal((await listSnapshots(w.dir)).length, 1); // piggyback wrote the snapshot
  await w.ops.humanMove(1, 'Building');
  const say2 = await w.newSession();
  assert.match(say2, /1 moved/);
});

test('ops: humanFlip routes through the REAL route verb (escalation comment on ->human)', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.ops.humanFlip(1); // agent -> human
  const { items } = await w.engine.listItems();
  assert.deepEqual(items[0].labels.sort(), ['needs-claude']);
  assert.ok(w.engine.calls.some((c) => c.op === 'comment'), 'route->human escalates via comment');
});

test('ops: undoTo executes the inverse plan via real move/route and is sound (re-invert empty)', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.ops.snapshotTake('baseline');
  await w.ops.humanMove(1, 'Building');
  await w.ops.humanFlip(1);
  const r = await w.ops.undoTo('~1');
  assert.equal(r.executed, 2);
  const { items } = await w.engine.listItems();
  assert.equal(items[0].stageLabel, 'Ideas');
  assert.deepEqual(items[0].labels.sort(), ['agent:go']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/sim-world.test.mjs`
Expected: FAIL — `w.ops` undefined

- [ ] **Step 3: Implement.** In `tests/helpers/sim-world.mjs`, add imports at the top:

```javascript
import { appendFileSync } from 'node:fs';
import {
  summary, move, route, syncRecord, promoteApply, reconcileScan, reconcileApply,
  snapshotTake, snapshotInvert,
} from '../../scripts/board-manager.mjs';
import { readLedger, writeLedger } from '../../scripts/lib/ledger.mjs';
import { applyProposals } from '../../scripts/lib/mapper.mjs';
```

(Verify each named export exists; if `summary`/verbs live under different names, adapt — they are all used by existing tests.) Then, inside `makeWorld` before the return, add:

```javascript
  const ctx = () => ({ engine, config: cfg, staged: false, dir });

  /** Session boundary: what the SessionStart hook does — run REAL summary
   *  (state write + snapshot piggyback). Asserting it completes IS the
   *  recoverability check after a crashed session. */
  async function newSession() {
    const r = await summary(ctx());
    return r.say;
  }

  const ops = {
    /** Append TODO lines (the watched source the pipeline ingests). */
    async seedTodo(titles) {
      appendFileSync(join(dir, 'TODO.md'), titles.map((t) => `- [ ] ${t}\n`).join(''), 'utf8');
      ops._pendingTitles.push(...titles);
    },
    _pendingTitles: [],

    /** Record the "LLM extraction" of every seeded-but-unrecorded title. */
    async pipelineSync() {
      const extracted = ops._pendingTitles.map((t) => ({ title: t, source: 'TODO.md' }));
      ops._pendingTitles = [];
      return syncRecord({ dir, config: cfg, extracted });
    },

    /** Map every pending candidate to a confident agent/Ideas card proposal. */
    async mapAll() {
      const ledger = (await readLedger(dir)) || { candidates: [] };
      const pending = (ledger.candidates || []).filter((c) => c.status !== 'promoted' && c.status !== 'dismissed' && !c.lane);
      if (!pending.length) return { mapped: 0 };
      const proposals = pending.map((c) => ({
        candidateId: c.id, kind: 'card', title: c.title, lane: 'Ideas', owner: 'agent',
        confidence: 0.95, rationale: 'sim',
      }));
      const { ledger: mapped } = applyProposals(ledger, proposals, cfg);
      await writeLedger(dir, mapped);
      return { mapped: proposals.length };
    },

    async promoteAll() { return promoteApply(null, ctx()); },

    /** Crash a promote run at a named window (reachable seams only):
     *  'A1' ledger-write dies right after createIssue (refs never persist)
     *  'A2' addIssueToBoard dies (refs persisted; stage/labels unrun)
     *  'A3' setStage dies (labels unrun)  ·  'A3b' setLabels dies
     *  'A4' second item's createIssue dies (batch split)            */
    async crashedPromote(window) {
      if (window === 'A1') {
        engine.failNext('__never'); // no engine fault — the LEDGER write dies:
        const origCreate = null;    // sabotage AFTER promote has read the ledger,
        // trick: arm the sabotage from inside createIssue (runs post-read)
        w._armLedgerSabotageOnCreate = true;
      } else if (window === 'A2') engine.failNext('addIssueToBoard');
      else if (window === 'A3') engine.failNext('setStage');
      else if (window === 'A3b') engine.failNext('setLabels');
      else if (window === 'A4') engine.failNext('createIssue', { onCall: 2 });
      else throw new Error(`unknown crash window ${window}`);
      const rep = await promoteApply(null, ctx());
      if (window === 'A1') w.faults.repairLedger();
      return rep;
    },

    async humanMove(card, lane) { return move(card, lane, ctx()); },
    async humanFlip(card) {
      const { items } = await engine.listItems();
      const it = items.find((i) => i.issueNumber === card);
      const owner = (it?.labels || []).includes(cfg.routing.agent) ? 'human' : 'agent';
      return route(card, owner, ctx());
    },
    async humanRelabel(card, label) { await engine.setLabels(card, [label]); },

    async reconcileScanHeal(decisions = null) {
      const scan = await reconcileScan(ctx());
      if (scan.drift.clean) return { scan, applied: null };
      const applied = await reconcileApply(decisions, { engine, config: cfg, dir });
      return { scan, applied };
    },

    async snapshotTake(label = null) { return snapshotTake(label, ctx()); },

    /** Undo to a PINNED ref: invert, execute every op via the real verbs,
     *  then prove soundness (re-invert vs the same ref => no remaining ops
     *  for surviving cards). */
    async undoTo(ref) {
      const plan = await snapshotInvert(ref, null, ctx());
      for (const op of plan.ops) {
        if (op.op === 'move') await move(op.issueNumber, op.to, ctx());
        if (op.op === 'route') await route(op.issueNumber, op.to, ctx());
      }
      const recheck = await snapshotInvert(ref, null, ctx());
      if (recheck.ops.length !== 0) {
        throw new Error(`invariant undo-soundness: ${recheck.ops.length} op(s) remain after undoTo(${ref})`);
      }
      return { plan, executed: plan.ops.length };
    },
  };

  const w = { dir, config: cfg, engine, board, faults: null, ops, newSession,
    _internal: { issues, stages, labels, onBoard, archived },
    _armLedgerSabotageOnCreate: false };
```

…and rework the A1 arming so it is clean: in the `createIssue` override, after `issues.push(issue)`, add:

```javascript
      if (w._armLedgerSabotageOnCreate) {
        w._armLedgerSabotageOnCreate = false;
        faults.sabotageLedgerOnce(); // the very next writeLedger (refs persist) dies
      }
      return issue;
```

Finally set `w.faults = faults;` and `return w;` (replacing the Task 1 return — keep `faults` defined before the engine so the override can see it; reorder declarations as needed: `const w = {…}` may be assembled after ops since ops close over `w` only for the A1 flag — declare `let _armA1 = false` as a plain closure variable instead of hanging it on `w` if simpler, with `ops.crashedPromote` setting it and `createIssue` reading it).

NOTE on `ops.crashedPromote('A1')`: delete the dead `engine.failNext('__never')`/`origCreate` lines from the sketch above — the final body for A1 is just `_armA1 = true`, run promote, then `faults.repairLedger()`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/sim-world.test.mjs`
Expected: PASS (10 tests)
Also: `npm test` → no regressions (≈397 tests, 0 fail, 3 skips).

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/sim-world.mjs tests/sim-world.test.mjs
git commit -m "test(m6): sim-world session model + real-verb op vocabulary"
```

---

### Task 3: `checkInvariants` (+non-vacuity self-test)

**Files:**
- Modify: `tests/helpers/sim-world.mjs`
- Test: `tests/sim-world.test.mjs` (append)

- [ ] **Step 1: Append the failing self-tests**:

```javascript
test('checkInvariants: clean world passes; deliberate duplicate-cid violation throws (non-vacuous)', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.newSession();
  await w.checkInvariants(); // must not throw

  // Backdoor (test-only): clone card 1 with the SAME cid marker body onto the board.
  const src = w._internal.issues[0];
  const dupe = await w.engine.createIssue(src.title + ' (dupe)', src.body);
  await w.engine.addIssueToBoard(dupe.url, {});
  await assert.rejects(() => w.checkInvariants(), /no-duplicate-cards/);
});

test('checkInvariants: journal regression (line count shrinks) throws', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.newSession();
  await w.checkInvariants(); // primes the monotonic counter
  const { writeFileSync: wf } = await import('node:fs');
  wf(`${w.dir}/.github-boards/snapshots/log.jsonl`, '', 'utf8'); // truncate (test-only backdoor)
  await assert.rejects(() => w.checkInvariants(), /journal-integrity/);
});

test('checkInvariants: resume-pending candidates must be classifiable, not lost', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll();
  await w.ops.crashedPromote('A3'); // refs persisted, stage died -> resume-pending
  await w.checkInvariants();        // crashed state is LEGAL: classifiable, no dupes
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/sim-world.test.mjs`
Expected: FAIL — `w.checkInvariants` is not a function

- [ ] **Step 3: Implement.** Add imports to `sim-world.mjs`:

```javascript
import { classifyDrift } from '../../scripts/lib/reconcile.mjs';
import { listSnapshots, readLog, resolveKeep } from '../../scripts/lib/snapshots.mjs';
import { readState } from '../../scripts/lib/state.mjs';
```

(Verify `readState` is the exported reader in lib/state.mjs; adapt the name if it differs.) Inside `makeWorld`, before the return, add a closure `let lastLogLines = 0;` and:

```javascript
  /** Throws naming the violated invariant + offending ids. Cheap enough to run
   *  after every soak step. Crashed states are LEGAL states — the invariants
   *  assert classifiability and integrity, not absence of drift. */
  async function checkInvariants() {
    const ledger = (await readLedger(dir)) || { candidates: [] };
    const { items } = await engine.listItemsWithBodies();
    const drift = classifyDrift({ ledger, items, sourceExists: () => true });

    // 1. no-duplicate-cards: one board card per cid marker
    if (drift.duplicates.length) {
      throw new Error(`invariant no-duplicate-cards: duplicate marker group(s): ${JSON.stringify(drift.duplicates)}`);
    }

    // 2. ledger<->board: refs-bearing non-final candidates must be classified resume-pending
    const resumeIds = new Set(drift.resumePending.map((r) => r.candidateId ?? r.id));
    for (const c of ledger.candidates || []) {
      if (c.promotion && c.promotion.issueNumber != null && c.status !== 'promoted' && c.status !== 'dismissed') {
        if (!resumeIds.has(c.id)) {
          throw new Error(`invariant ledger-board: candidate ${c.id} has live refs but is not classified resume-pending`);
        }
      }
      if (c.status === 'promoted' && c.promotion?.itemId) {
        const onBoardNow = items.some((i) => i.itemId === c.promotion.itemId);
        // vanished cards are LEGAL (reconcile's job) — only assert classifiability:
        if (!onBoardNow && drift.clean) {
          throw new Error(`invariant ledger-board: promoted ${c.id} vanished but scan says clean`);
        }
      }
    }

    // 3. journal-integrity: append-only, parseable
    const logPath = join(dir, '.github-boards', 'snapshots', 'log.jsonl');
    const lines = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).length
      : 0;
    if (lines < lastLogLines) {
      throw new Error(`invariant journal-integrity: log shrank ${lastLogLines} -> ${lines}`);
    }
    lastLogLines = lines;
    const { skippedLines } = await readLog(dir, 1);
    if (skippedLines > 0) {
      throw new Error(`invariant journal-integrity: ${skippedLines} unparseable line(s)`);
    }

    // 4. snapshot-store: never more files than keep
    const snaps = await listSnapshots(dir);
    const keep = resolveKeep(cfg);
    if (snaps.length > keep) {
      throw new Error(`invariant snapshot-store: ${snaps.length} snapshots > keep=${keep}`);
    }

    // 5. state-honesty: state.json, when present, parses (readState throws/derives null otherwise)
    await readState(dir); // a corrupt state file should throw here, failing the invariant loudly
  }
  // (then add `checkInvariants` to the returned world object)
```

NOTE: verify `readState`'s corrupt-file behavior by reading lib/state.mjs — if it silently returns null on corruption, replace invariant 5 with a direct `JSON.parse(readFileSync(statePath))` guarded by existsSync, throwing `invariant state-honesty: …` on parse failure.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/sim-world.test.mjs`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/sim-world.mjs tests/sim-world.test.mjs
git commit -m "test(m6): checkInvariants — drift-classifiability, journal monotonicity, store bounds; proven non-vacuous"
```

---

### Task 4: Crash-atlas scenarios A1–A4 (promote windows)

**Files:**
- Test: `tests/sim-scenarios.test.mjs` (new)

- [ ] **Step 1: Write the scenarios.** Create `tests/sim-scenarios.test.mjs`:

```javascript
// tests/sim-scenarios.test.mjs — the crash atlas (spec §5) + composition
// stories (§6). Every crash is injected at a REACHABLE seam; recovery always
// happens in a NEW session through the real verbs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/sim-world.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';

async function seededWorld(titles = ['Wire retry']) {
  const w = await makeWorld();
  await w.ops.seedTodo(titles);
  await w.ops.pipelineSync();
  await w.ops.mapAll();
  return w;
}

test('A1: ledger write dies after createIssue — refs never persist; board still gets exactly ONE card', async () => {
  const w = await seededWorld();
  const rep = await w.ops.crashedPromote('A1');
  assert.equal(rep.report.partial.length, 1, 'the item must report partial');
  // persisted truth: candidate has NO refs; the created issue exists OFF-board
  let ledger = await readLedger(w.dir);
  assert.equal(ledger.candidates[0].promotion ?? null, null);
  assert.equal((await w.engine.listItems()).items.length, 0, 'nothing reached the board');

  await w.newSession(); // crashed session over; world must be recoverable
  // recovery: re-promote files a fresh issue and lands ONE card; the original
  // issue is off-board garbage (documented accepted loss — reconcile is
  // board-scoped and structurally cannot see it).
  const rep2 = await w.ops.promoteAll();
  assert.equal(rep2.report.promoted.length, 1);
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 1, 'exactly one card despite the orphan issue');
  await w.checkInvariants();
});

test('A2: addIssueToBoard dies — refs persisted; reconcile reports resume-pending; promote resumes the SAME issue', async () => {
  const w = await seededWorld();
  await w.ops.crashedPromote('A2');
  const ledger = await readLedger(w.dir);
  assert.ok(ledger.candidates[0].promotion.issueNumber, 'refs persisted before the crash');
  assert.equal(ledger.candidates[0].promotion.itemId ?? null, null);

  await w.newSession();
  const { scan, applied } = await w.ops.reconcileScanHeal();
  assert.equal(scan.drift.resumePending.length, 1, 'classified resume-pending');
  assert.equal(applied ?? null, applied); // heal may be null when only resume-pending
  const rep2 = await w.ops.promoteAll();
  assert.equal(rep2.report.promoted.length, 1);
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].issueNumber, 1, 'the ORIGINAL issue was resumed, not re-created');
  assert.equal(items[0].stageLabel, 'Ideas');
  assert.deepEqual(items[0].labels, ['agent:go']);
  await w.checkInvariants();
});

test('A3: setStage dies — card on board laneless; resume completes stage+labels on the same card', async () => {
  const w = await seededWorld();
  await w.ops.crashedPromote('A3');
  const before = (await w.engine.listItems()).items;
  assert.equal(before.length, 1);
  assert.equal(before[0].stageLabel, null);

  await w.newSession();
  const rep2 = await w.ops.promoteAll();
  assert.equal(rep2.report.promoted.length, 1);
  const after = (await w.engine.listItems()).items;
  assert.equal(after.length, 1, 'no second card');
  assert.equal(after[0].stageLabel, 'Ideas');
  assert.deepEqual(after[0].labels, ['agent:go']);
  await w.checkInvariants();
});

test('A3b: setLabels dies — staged but labelless; resume is a safe idempotent completion', async () => {
  const w = await seededWorld();
  await w.ops.crashedPromote('A3b');
  assert.deepEqual((await w.engine.listItems()).items[0].labels, []);
  await w.newSession();
  await w.ops.promoteAll();
  const items = (await w.engine.listItems()).items;
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].labels, ['agent:go']);
  await w.checkInvariants();
});

test('A4: batch splits — item 1 promoted once, item 2 crashes at create; re-run completes only item 2', async () => {
  const w = await seededWorld(['First card', 'Second card']);
  const rep = await w.ops.crashedPromote('A4');
  assert.equal(rep.report.promoted.length, 1);
  assert.equal(rep.report.partial.length, 1);

  await w.newSession();
  const rep2 = await w.ops.promoteAll();
  assert.equal(rep2.report.promoted.length, 1, 'only the crashed item promotes');
  assert.ok(rep2.report.skipped.some((s) => s.reason === 'already promoted'), 'item 1 skipped, not re-filed');
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 2);
  await w.checkInvariants();
});
```

- [ ] **Step 2: Run**

Run: `node --test tests/sim-scenarios.test.mjs`
Expected: PASS (5 tests). A failure here is a REAL recovery bug (or a world-wiring error — check wiring first against the verified signatures). Investigate; never bend an assertion. Report bugs as DONE_WITH_CONCERNS with the failing scenario.

NOTE on A2's heal expectation: read `resolveReconcileDecisions` — resume-pending is report-only (apply may legitimately be a no-op or even throw if invoked with nothing to apply); if `reconcileApply` errors on an empty toApply, change the op call to plain `reconcileScan` assertions in this scenario and note the adaptation.

- [ ] **Step 3: `npm test`** → ≈402 tests, 0 fail, 3 skips. Commit:

```bash
git add tests/sim-scenarios.test.mjs
git commit -m "test(m6): crash atlas A1-A4 — every promote window recovers without duplicates"
```

---

### Task 5: Atlas B/C/D/E + composition stories

**Files:**
- Test: `tests/sim-scenarios.test.mjs` (append)

- [ ] **Step 1: Append the remaining atlas rows**:

```javascript
test('B1: snapshot log-append dies — rollback leaves no orphan; retry records the event (through the world)', async () => {
  const w = await seededWorld();
  await w.ops.promoteAll();
  await w.ops.snapshotTake('baseline');
  await w.ops.humanMove(1, 'Building');
  // sabotage: a DIRECTORY at the log path -> appendFile dies inside writeSnapshot
  const { mkdirSync: mkd, rmdirSync: rmd } = await import('node:fs');
  const logPath = `${w.dir}/.github-boards/snapshots/log.jsonl`;
  const { renameSync: ren } = await import('node:fs');
  ren(logPath, `${logPath}.bak`); mkd(logPath);
  const r = await w.ops.snapshotTake('doomed').catch((e) => ({ error: e.message }));
  assert.ok(r.error, 'take must fail loudly');
  rmd(logPath); ren(`${logPath}.bak`, logPath);
  // rollback: no orphan snapshot poisons dedup — retry records the move event
  await w.ops.snapshotTake('retry');
  const { readLog } = await import('../scripts/lib/snapshots.mjs');
  const { entries } = await readLog(w.dir, 10);
  assert.equal(entries[0].moved.length, 1, 'the event reached the permanent journal');
  await w.checkInvariants();
});

test('B2: store transiently over keep is pruned by the next successful write; journal intact', async () => {
  const w = await makeWorld({ config: { ...((await import('./helpers/sim-world.mjs')).WORLD_CFG), snapshots: { keep: 2 } } });
  await w.ops.seedTodo(['One']); await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  // three distinct boards -> three writes with keep=2: store must end at 2 files,
  // journal must keep ALL events.
  await w.ops.snapshotTake('s1');
  await w.ops.humanMove(1, 'Building'); await w.ops.snapshotTake('s2');
  await w.ops.humanMove(1, 'Review');   await w.ops.snapshotTake('s3');
  const { listSnapshots, readLog } = await import('../scripts/lib/snapshots.mjs');
  assert.equal((await listSnapshots(w.dir)).length, 2);
  assert.equal((await readLog(w.dir, 100)).entries.length, 3);
  await w.checkInvariants();
});

test('C1: sync re-run with the same extraction dedups — no duplicate candidates', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['Alpha', 'Beta']);
  const r1 = await w.ops.pipelineSync();
  assert.equal(r1.added.length, 2);
  // a "crashed settlement" presents as: same extraction recorded again next session
  await w.newSession();
  const r2 = await (await import('../scripts/board-manager.mjs')).syncRecord({
    dir: w.dir, config: w.config, extracted: [{ title: 'Alpha', source: 'TODO.md' }, { title: 'Beta', source: 'TODO.md' }],
  });
  assert.equal(r2.added.length, 0);
  assert.equal(r2.deduped.length, 2, 'content-hash ids dedup the re-run');
  assert.equal((await readLedger(w.dir)).candidates.length, 2);
  await w.checkInvariants();
});

test('D1: snapshot piggyback dies — summary still succeeds; NEXT session diffs from the state that DID persist', async () => {
  const w = await seededWorld();
  await w.ops.promoteAll();
  w.faults.sabotageSnapshotsDirOnce();
  const say1 = await w.newSession();
  assert.match(say1, /snapshot skipped/i);
  const { rmSync } = await import('node:fs');
  rmSync(`${w.dir}/.github-boards/snapshots`); // clear the sabotage file
  await w.ops.humanMove(1, 'Building');
  const say2 = await w.newSession();
  assert.match(say2, /1 moved/, 'state persisted through the piggyback failure');
  await w.checkInvariants();
});

test('E1: undo crashes between ops — re-invert vs the SAME pinned anchor proposes only the remainder', async () => {
  const w = await seededWorld();
  await w.ops.promoteAll();
  await w.ops.snapshotTake('anchor');
  await w.ops.humanMove(1, 'Building');
  await w.ops.humanFlip(1); // agent -> human
  const { snapshotInvert, move } = await import('../scripts/board-manager.mjs');
  const ctx = { engine: w.engine, config: w.config, staged: false, dir: w.dir };
  const plan = await snapshotInvert('~1', null, ctx);
  assert.equal(plan.ops.length, 2);
  await move(plan.ops[0].issueNumber, plan.ops[0].to, ctx); // execute op 1, then "crash"
  await w.newSession();
  const plan2 = await snapshotInvert('~2', null, ctx); // SAME anchor — newSession snapshotted, so it aged to ~2
  assert.equal(plan2.ops.length, 1, 'only the route op remains');
  assert.equal(plan2.ops[0].op, 'route');
  await w.checkInvariants();
});
```

NOTE on E1's `~2`: `newSession`'s piggyback writes a new snapshot, aging the anchor by one. THIS IS THE ANCHOR TRAP IN MINIATURE — if the re-invert under `~1` were used, it would diff against the post-crash snapshot. The scenario intentionally demonstrates correct pinned-anchor discipline; if the piggyback dedups (board unchanged between the partial undo and the session start — it is NOT unchanged here, the move ran), verify with `listSnapshots` and adjust the ref math only with evidence.

- [ ] **Step 2: Append the three composition stories**:

```javascript
test('STORY anchor-trap: a new session re-snapshots the mutated board; pinned ref undoes, latest warns', async () => {
  const w = await seededWorld();
  await w.ops.promoteAll();
  await w.newSession();                       // snapshot #1: the pre-mutation board
  await w.ops.humanMove(1, 'Building');
  const say = await w.newSession();           // snapshot #2: the MUTATED board (the trap)
  assert.match(say, /1 moved/);
  const { snapshotInvert } = await import('../scripts/board-manager.mjs');
  const ctx = { engine: w.engine, config: w.config, staged: false, dir: w.dir };
  const viaLatest = await snapshotInvert('latest', null, ctx);
  assert.equal(viaLatest.ops.length, 0);
  assert.match(viaLatest.say, /older ref/i, 'the anchor-trap hint fires');
  const pinned = await w.ops.undoTo('~2');    // the pre-mutation snapshot
  assert.equal(pinned.executed, 1);
  assert.equal((await w.engine.listItems()).items[0].stageLabel, 'Ideas');
  await w.checkInvariants();
});

test('STORY long-week: 5 sessions of pipeline + human edits — summaries and the journal agree end-to-end', async () => {
  const w = await makeWorld();
  // S1: first batch
  await w.ops.seedTodo(['One', 'Two']); await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.newSession();
  // S2: human edits
  await w.ops.humanMove(1, 'Building'); await w.ops.humanFlip(2);
  assert.match(await w.newSession(), /1 moved/);
  // S3: second batch + an archive (GitHub-UI)
  await w.ops.seedTodo(['Three']); await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  w.board.archiveCard(2);
  await w.newSession();
  // S4: a retitle (GitHub-UI) + a move
  w.board.retitle(1, 'One v2'); await w.ops.humanMove(3, 'Review');
  await w.newSession();
  // S5: quiet session — dedup'd snapshot
  const { listSnapshots, readLog } = await import('../scripts/lib/snapshots.mjs');
  const before = (await listSnapshots(w.dir)).length;
  await w.newSession();
  assert.equal((await listSnapshots(w.dir)).length, before, 'idle session adds no snapshot');
  // the journal tells the whole story: initial + every changed session
  const { entries, skippedLines } = await readLog(w.dir, 50);
  assert.equal(skippedLines, 0);
  assert.ok(entries.length >= 4);
  const total = entries.reduce((acc, e) => acc + (e.initial ? 0 :
    e.moved.length + e.added.length + e.removed.length + e.relabeled.length + e.retitled.length), 0);
  assert.ok(total >= 5, `journal recorded the week (${total} events)`);
  await w.checkInvariants();
});

test('STORY messy-repo: dismissed-but-live + vanished cards reconcile with ZERO board writes; self-extinguishing', async () => {
  const w = await seededWorld(['Keep me', 'Dismiss me']);
  await w.ops.promoteAll();
  // a human dismisses candidate 2 in the ledger while its card lives on (uncertain class)…
  const { readLedger: rl, writeLedger: wl } = await import('../scripts/lib/ledger.mjs');
  const ledger = await rl(w.dir);
  const c2 = ledger.candidates.find((c) => c.title === 'Dismiss me');
  c2.status = 'dismissed'; // reachable: `ledger`-level dismissal is a real user action
  await wl(w.dir, ledger);
  // …and card 1 vanishes via the GitHub UI
  w.board.archiveCard(1);

  await w.newSession();
  const callsBefore = w.engine.calls.length;
  const { scan } = await w.ops.reconcileScanHeal({
    [c2.id]: 'keep',
    [ledger.candidates.find((c) => c.title === 'Keep me').id]: 'keep',
  });
  assert.ok(!scan.drift.clean, 'drift detected');
  const writes = w.engine.calls.slice(callsBefore)
    .filter((c) => ['createIssue', 'setStage', 'setLabels', 'removeLabels', 'addIssueToBoard', 'comment'].includes(c.op));
  assert.deepEqual(writes, [], 'reconcile NEVER writes the board');
  await w.checkInvariants();
});
```

NOTE on messy-repo decisions: read `resolveReconcileDecisions` for the exact decisions-map shape (`{candidateId: action}` vs an array) and the allowed actions per class (`dismissed-but-live` → settle|keep; `vanished` → re-promote|dismiss|keep), and adapt the literal. The zero-board-writes assertion is the heart — keep it exact.

- [ ] **Step 3: Run + commit**

Run: `node --test tests/sim-scenarios.test.mjs` → PASS (13 tests). `npm test` → ≈410 tests, 0 fail, 3 skips.

```bash
git add tests/sim-scenarios.test.mjs
git commit -m "test(m6): crash atlas B/C/D/E + anchor-trap, long-week, messy-repo stories"
```

---

### Task 6: The seeded soak

**Files:**
- Test: `tests/sim-soak.test.mjs` (new)

- [ ] **Step 1: Write the soak.** Create `tests/sim-soak.test.mjs`:

```javascript
// tests/sim-soak.test.mjs — seeded random walks over the op vocabulary with
// invariants checked after EVERY step. Deterministic: fixed seeds, inline LCG.
// A failure prints seed + step + full trace — replayable verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/sim-world.mjs';

const SEEDS = [0xC0FFEE, 0xBADF00D, 0x5EED, 0xA11CE];
const STEPS = 120;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Weighted op table. Each op must be safe to attempt in ANY world state
 *  (no-op gracefully when preconditions are absent). */
function buildOps(w, rnd) {
  let todoN = 0;
  const cards = async () => (await w.engine.listItems()).items;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const lanes = Object.keys(w.config.stageOptions);
  return [
    { w: 3, name: 'seed+sync', run: async () => { todoN += 1; await w.ops.seedTodo([`Task ${todoN}-${Math.floor(rnd() * 1e6)}`]); await w.ops.pipelineSync(); } },
    { w: 2, name: 'mapAll', run: () => w.ops.mapAll() },
    { w: 2, name: 'promoteAll', run: () => w.ops.promoteAll() },
    { w: 1, name: 'crashedPromote', run: () => w.ops.crashedPromote(pick(['A2', 'A3', 'A3b'])) },
    { w: 4, name: 'humanMove', run: async () => { const c = await cards(); if (c.length) await w.ops.humanMove(pick(c).issueNumber, pick(lanes)); } },
    { w: 2, name: 'humanFlip', run: async () => { const c = await cards(); if (c.length) await w.ops.humanFlip(pick(c).issueNumber); } },
    { w: 1, name: 'archive', run: async () => { const c = await cards(); if (c.length > 1) w.board.archiveCard(pick(c).issueNumber); } },
    { w: 1, name: 'retitle', run: async () => { const c = await cards(); if (c.length) w.board.retitle(pick(c).issueNumber, `Renamed ${Math.floor(rnd() * 1e6)}`); } },
    { w: 3, name: 'newSession', run: () => w.newSession() },
    { w: 1, name: 'snapshotTake', run: () => w.ops.snapshotTake(null) },
    { w: 1, name: 'reconcile', run: async () => {
        // keep-everything decisions: safe in any state (uncertain -> keep)
        const { drift } = await (await import('../scripts/board-manager.mjs')).reconcileScan({ engine: w.engine, config: w.config, dir: w.dir });
        if (drift.clean) return;
        const decisions = Object.fromEntries(drift.uncertain.map((u) => [u.candidateId ?? u.id, 'keep']));
        await w.ops.reconcileScanHeal(decisions);
      } },
  ];
}

for (const seed of SEEDS) {
  test(`soak seed=0x${seed.toString(16).toUpperCase()}: ${STEPS} steps, invariants after every step`, async () => {
    const w = await makeWorld();
    const rnd = lcg(seed);
    const ops = buildOps(w, rnd);
    const totalW = ops.reduce((a, o) => a + o.w, 0);
    const trace = [];
    for (let step = 0; step < STEPS; step++) {
      let roll = rnd() * totalW;
      const op = ops.find((o) => (roll -= o.w) < 0) || ops[ops.length - 1];
      trace.push(op.name);
      try {
        await op.run();
        await w.checkInvariants();
      } catch (e) {
        throw new Error(
          `SOAK FAILURE seed=0x${seed.toString(16)} step=${step} op=${op.name}\n` +
          `trace: ${trace.join(' -> ')}\n${e.stack || e.message}`,
        );
      }
    }
    await w.checkInvariants();
  });
}
```

NOTE: `crashedPromote` draws exclude 'A1'/'A4' — A1's ledger sabotage + repair inside a random walk risks repairing over states other ops created; A4 needs ≥2 pending candidates. Both are covered by their dedicated scenarios; the soak exercises the engine-seam windows. If an op legitimately CAN throw in some state (e.g. promoteAll with `pushPolicy` quirks), that is a finding, not noise — investigate before touching the table.

- [ ] **Step 2: Run**

Run: `node --test tests/sim-soak.test.mjs`
Expected: PASS (4 tests) in a few seconds. ANY failure: replay with the printed seed/trace; classify as (a) world-wiring bug — fix the world; (b) REAL system bug — report DONE_WITH_CONCERNS with the trace, and the orchestrator decides the fix task. Never reweight the table to dodge a failure.

- [ ] **Step 3: `npm test`** → ≈414 tests, 0 fail, 3 skips. Time the suite — if total runtime exceeded ~30s, lower STEPS to 80 and note it. Commit:

```bash
git add tests/sim-soak.test.mjs
git commit -m "test(m6): seeded soak — 4 deterministic random walks, invariants after every step"
```

---

### Task 7: Live E2E + runbook (WRITTEN, NEVER RUN)

**Files:**
- Create: `tests/live-e2e.test.mjs`
- Create: `docs/LIVE-RUNBOOK.md`

Read `tests/live-bootstrap.test.mjs` and `tests/live-promote.test.mjs` FIRST and mirror their conventions exactly (env names, sandbox repo selection, makeRealEngine/loadConfig usage, teardown helpers). The code below is the blueprint; align every helper call with what those files actually do, and note adaptations.

- [ ] **Step 1: Create `tests/live-e2e.test.mjs`** (blueprint — align with the live-* conventions):

```javascript
// tests/live-e2e.test.mjs — the ONE full-story live pass. Skipped unless
// GBS_LIVE=1. DO NOT set GBS_LIVE=1 in automated/subagent runs — this creates
// and deletes REAL GitHub resources. Operator instructions: docs/LIVE-RUNBOOK.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const LIVE = process.env.GBS_LIVE === '1';

test('LIVE E2E: bootstrap -> sync/map/promote one card -> move -> reconcile clean -> snapshot diff/invert -> teardown',
  { skip: !LIVE ? 'set GBS_LIVE=1 to run (see docs/LIVE-RUNBOOK.md)' : false, timeout: 300000 }, async () => {
  // Mirror live-bootstrap.test.mjs: provision a throwaway board, capture every
  // created resource id for teardown.
  const { bootstrap, syncRecord, promoteApply, move, reconcileScan, snapshotTake, snapshotDiff, snapshotInvert }
    = await import('../scripts/board-manager.mjs');
  const { readLedger, writeLedger } = await import('../scripts/lib/ledger.mjs');
  const { applyProposals } = await import('../scripts/lib/mapper.mjs');

  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-live-e2e-'));
  const created = { projectId: null, issues: [] };
  let engine; let config;
  try {
    // 1. bootstrap (follow live-bootstrap.test.mjs for ctx/engine construction
    //    and how it returns project/config handles)
    const boot = await bootstrap({ preset: 'build', title: `gbs-e2e-${Date.now()}` }, /* ctx per live-bootstrap */);
    created.projectId = boot.projectId ?? boot.project?.id ?? null;
    config = boot.config; engine = boot.engine; // adapt to the real return shape

    // 2. one card through the REAL pipeline
    writeFileSync(join(dir, 'TODO.md'), '- [ ] E2E smoke card', 'utf8');
    await syncRecord({ dir, config, extracted: [{ title: 'E2E smoke card', source: 'TODO.md' }] });
    const ledger = await readLedger(dir);
    const { ledger: mapped } = applyProposals(ledger, [{
      candidateId: ledger.candidates[0].id, kind: 'card', title: 'E2E smoke card',
      lane: Object.keys(config.stageOptions)[0], owner: 'agent', confidence: 0.95, rationale: 'e2e',
    }], config);
    await writeLedger(dir, mapped);
    const rep = await promoteApply(null, { engine, config, staged: false, dir });
    assert.equal(rep.report.promoted.length, 1);
    created.issues.push(rep.report.promoted[0].issueNumber);

    // 3. live move + reconcile + snapshots
    await snapshotTake('e2e-baseline', { engine, config, dir });
    const lanes = Object.keys(config.stageOptions);
    await move(created.issues[0], lanes[1] ?? lanes[0], { engine, config, staged: false, dir });
    const scan = await reconcileScan({ engine, config, dir });
    assert.ok(scan.drift.clean || scan.drift.resumePending.length === 0, `reconcile must be clean: ${scan.say}`);
    const d = await snapshotDiff('latest', null, { engine, config, dir });
    assert.equal(d.diff.moved.length, 1, 'the live move is visible in the diff');
    const inv = await snapshotInvert('latest', null, { engine, config, dir });
    assert.equal(inv.ops.length, 1, 'invert proposes exactly the inverse move (read-only)');
  } finally {
    // TEARDOWN — close created issues + delete the project; on failure print
    // every leftover id so the runbook's cleanup step has a target.
    try {
      // mirror live-bootstrap.test.mjs's teardown helpers here
    } catch (e) {
      console.error(`LIVE E2E TEARDOWN FAILED — clean up by hand: ${JSON.stringify(created)} (${e.message})`);
      throw e;
    }
  }
});
```

The implementer MUST replace the two `mirror live-…` placeholders with the real construction/teardown code from the existing live tests (read them; they contain working gh/GraphQL setup + deletion). That is the task's main work — the blueprint's pipeline middle is already verified against the mock-world signatures.

- [ ] **Step 2: Create `docs/LIVE-RUNBOOK.md`:**

```markdown
# Live E2E Runbook

The live suite creates and deletes REAL GitHub resources. It is operator-only.

## The standing rule

`GBS_LIVE=1` is set by a HUMAN at a terminal, never in CI, never in automated or
agent-driven sessions. The tests skip without it; the skip message points here.

## Prerequisites

- `gh auth status` succeeds; the token has `project` + `repo` scopes.
- A sandbox repository you own (the suite files real Issues in it). Configure it
  the same way the existing live smokes do (see tests/live-bootstrap.test.mjs
  for the env/config it reads).
- Node ≥18; run from the repo root.

## Running

    GBS_LIVE=1 npm test                      # whole suite incl. all 4 live tests
    GBS_LIVE=1 node --test tests/live-e2e.test.mjs   # just the E2E

PowerShell: `$env:GBS_LIVE='1'; node --test tests/live-e2e.test.mjs; Remove-Item Env:GBS_LIVE`

## What it creates

- One throwaway Projects v2 board named `gbs-e2e-<timestamp>`
- One Issue ("E2E smoke card") in the sandbox repo, labeled `agent:go`
- Local state under a temp dir (auto-removed by the OS)

## Expected output

All assertions pass; the final lines confirm teardown. Total runtime is a few
minutes (GraphQL round-trips).

## Teardown verification

The test tears down in a `finally` block. Verify afterwards:
- The board no longer appears in your Projects list.
- The smoke Issue is closed.

If teardown fails, the test prints `LIVE E2E TEARDOWN FAILED` with every
leftover resource id — delete those by hand (`gh project delete`, `gh issue
close`) and re-run when clean.
```

- [ ] **Step 3: Verify WITHOUT running live:** `node --test tests/live-e2e.test.mjs` → 1 skipped ("set GBS_LIVE=1 to run"). `npm test` → ≈415 tests, 0 fail, **4 skips**.

- [ ] **Step 4: Commit**

```bash
git add tests/live-e2e.test.mjs docs/LIVE-RUNBOOK.md
git commit -m "test(m6): gated live E2E (4th skip) + operator runbook — written, never auto-run"
```

---

## Self-Review (run after all tasks)

1. **Spec coverage:** §3 world (Tasks 1–2); §4 invariants (Task 3 — invariant 4's dedup-iff clause implemented as the long-week story's idle-session assertion + B-row scenarios, not per-step: cheaper and equally pinning; reconcile at spec time); §5 atlas A1–A4 (Task 4), B1/B2/C1/D1/E1 (Task 5); §6 stories + soak + self-tests (Tasks 5, 6, 1–3); §7 live E2E + runbook (Task 7); §8 error posture woven through (loud labeled throws, one-shot faults, finally-teardown).
2. **Placeholder scan:** Task 7's two `mirror live-…` markers are explicit implementer instructions to lift working code from named existing files — the only intentional indirection (the live setup/teardown already exists and must not be reinvented blind). Everything else is complete code.
3. **Type consistency:** `makeWorld()` → `{dir, config, engine, board, faults, ops, newSession, checkInvariants, _internal}` used identically in Tasks 1–6; `engine.failNext(op, {onCall})`; ops names (`seedTodo/pipelineSync/mapAll/promoteAll/crashedPromote/humanMove/humanFlip/humanRelabel/reconcileScanHeal/snapshotTake/undoTo`) consistent across scenarios and soak; crash windows 'A1'|'A2'|'A3'|'A3b'|'A4' consistent between Task 2's implementation and Task 4's scenarios.
