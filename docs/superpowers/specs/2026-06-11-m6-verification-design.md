# M6 "Verification & Simulation" — Design Spec

**Date:** 2026-06-11
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M6 of the github-boards buildout (see §9) — the capstone milestone.
**Predecessors:** [M5 spec](2026-06-11-m5-skill-layer-design.md) · [M4b spec](2026-06-10-m4b-timetravel-design.md) · [M4a spec](2026-06-10-m4a-reconcile-design.md) · [M1 spec](2026-06-08-m1-foundation-design.md)

---

## 1. Purpose

The suite is deep per-milestone (387 tests; real-chain pipeline tests for sync/reconcile/snapshot/undo; 3 gated live smokes) — but the worst bugs of this project were never *inside* a milestone. M4a's HIGH lived in an unreachable simulated crash state; M4b's blocker was an untested second write of a two-write sequence; M5's anchor trap only existed across *session boundaries*. M6 attacks exactly that residue: prove the **system** survives realistic multi-session life, every enumerable crash window, and one real-GitHub end-to-end pass.

**Decided posture (Q&A):**
- **Simulation = scenarios + seeded soak.** Hand-written multi-session lifecycle stories with exact assertions, plus a seeded-PRNG soak running random op sequences with invariants checked after every step. Both deterministic, both inside `npm test`.
- **Live = one gated E2E + runbook.** A single `GBS_LIVE=1` test walks the full story once (bootstrap → promote → move → reconcile → snapshot/invert → teardown); `docs/LIVE-RUNBOOK.md` tells the operator how. The existing 3 smokes stay. Never automated.
- **Crash atlas — exhaustive.** Every multi-write sequence in the codebase is enumerated with every gap between writes; each gap gets a recovery scenario (§5). Unlisted windows are where the next M4b-class bug hides.

## 2. Scope

### In scope
- **`tests/helpers/sim-world.mjs`** — the shared world: stateful mock board + temp repo dir + session model + op vocabulary + fault injection + invariant checker. Promotes the hand-rolled stateful mocks of the four existing pipeline tests into one helper (existing tests are NOT rewritten — new consumers only).
- **`tests/sim-scenarios.test.mjs`** — lifecycle scenarios: one per crash-atlas row (§5) + three composition stories (§6).
- **`tests/sim-soak.test.mjs`** — seeded soak: fixed seeds × bounded steps, invariants after every step, replayable failures.
- **World self-tests** (`tests/sim-world.test.mjs`) — mock semantics + a deliberate-violation test proving `checkInvariants()` is not vacuous.
- **`tests/live-e2e.test.mjs`** — the one gated live E2E (4th gated skip).
- **`docs/LIVE-RUNBOOK.md`** — operator instructions: prerequisites, what gets created, expected output, teardown verification, the never-automated rule.
- **Bug fixes** the harness surfaces — separate atomic commits with their own regression tests.

### Out of scope (deferred)
- New product features or verbs; refactors not forced by a found bug.
- Rewriting existing pipeline tests onto the world helper (drift risk for zero coverage gain).
- CI configuration; the LLM eval harness (M5 owns it).
- Shrinking/minimization framework for soak failures — the seed + op trace is the repro; minimization is manual.

## 3. Architecture

```
tests/helpers/sim-world.mjs
  makeWorld({seed?}) → world
    world.dir            mkdtemp repo dir — ledger/state/snapshots/TODO.md live here
    world.engine         stateful mock board (proven pipeline-test pattern, promoted):
                         createIssue / addIssueToBoard / setStage / additive setLabels /
                         subtractive removeLabels / comment / listItems(+WithBodies);
                         plus board-side edits the verbs can't make but GitHub can:
                         world.board.archiveCard(n) · world.board.retitle(n, title)
    world.newSession()   the session boundary: clears per-session hook state, then runs
                         REAL summary(ctx) — snapshot piggyback included (what the
                         SessionStart hook does). Returns the say.
    world.ops            vocabulary — every op is REAL verb/lib calls only:
                         seedTodo(titles[]) · pipelineSync() · mapAll() · promoteAll() ·
                         crashedPromote(window) · humanMove(n, lane) · humanFlip(n) ·
                         humanRelabel(n, label) · reconcileScanHeal() · snapshotTake(label?)
                         · undoTo(ref)  (snapshotInvert + execute ops via real move/route)
    world.engine.failNext(op)   one-shot fault: next call of that engine op throws
                                (how network death presents to the verb layer)
    world.checkInvariants()     throws naming the invariant + offending ids (+ seed/trace
                                in the soak)
```

**Crash semantics (the reachable-states rule, operationalized):** crash windows are produced ONLY by (a) one-shot engine-op throws (`failNext`) that make the real verb throw mid-sequence, or (b) the lib seams that already exist (mkdir-as-file sabotage, log-path-as-directory). The world catches the verb's throw, marks the session crashed, and the next `newSession()` asserts recoverability. Persisted state is never hand-mutated. **Sim-world facts:** faults are one-shot — `failNext` fires exactly once; `crashedPromote` calls `faults.clearFaults()` in its `finally` block so any unconsumed fault (e.g. an A3 partial whose resume path skips `addIssueToBoard`) cannot leak onto a later innocent operation. The soak trace is replayable only by re-running the same seed end-to-end — there is no minimization framework (the seed + op trace IS the repro).

## 4. The invariants

Checked after every soak step and at scenario checkpoints. Violation → throw with label + ids.

1. **No duplicate cards** — at most one board card per ledger candidate (cid marker uniqueness across `listItemsWithBodies`).
2. **Ledger↔board consistency** — every refs-bearing (`itemId` set) non-final candidate must be classified either resume-pending (card still on board) or vanished (card archived/deleted via the GitHub UI) — never silent. Off-board partials where `itemId == null` (A2 window) are invisible to board-scoped `classifyDrift` by design and are legal; `promote apply` resumes them.
3. **Journal integrity** — `log.jsonl` line count never decreases; one line per non-skipped snapshot write; every line parses (torn lines only via injected faults, and then counted by `readLog`).
4. **Snapshot store sanity** — snapshot file count ≤ keep (monotone cap). The full dedup-iff (same content → no new snapshot) is exercised by the B-row scenarios and the long-week idle assertion; this invariant asserts only the simpler bound.
5. **State honesty** — `state.json` parses as valid JSON and each item carries the expected `{lane, labels, owner}` structure (pass-on-mock / break-on-live guard); reflects the last *completed* summary's view.
6. **Undo soundness** — after `undoTo(ref)` executes its ops, re-running invert against the SAME pinned ref yields zero remaining ops for surviving cards.

## 5. The crash atlas

Every multi-write sequence and every gap; one recovery scenario per row. (Sequence owners verified against the code at plan time — any sequence discovered missing from this table is added, not skipped.)

| # | Sequence (owner) | Window: crash after… | Required recovery (next session) |
|---|---|---|---|
| A1 | promote apply per-item: createIssue → addIssueToBoard → setStage → setLabels → ledger persist | createIssue (nothing persisted, issue exists off-board) | orphan issue lives off-board; board-scoped `classifyDrift` cannot see it (accepted loss, documented). Recovery: fresh re-promote lands exactly one card (cid marker found, no duplicate); reconcile is not involved. |
| A2 | 〃 | addIssueToBoard + refs persist (stage/labels unrun) | refs are in the ledger but the card is off-board — board-scoped reconcile sees clean (by design: `itemId == null`); `promote apply` resumes the SAME card completing stage+labels, same issue resumed. |
| A3 | 〃 | setStage (labels unrun) | as A2 — resume completes labels only; no second issue |
| A4 | 〃 batch | between item N and N+1 | items ≤N promoted exactly once; N+1 promotes on resume |
| A3-then-archive | mid-promote partial (setStage crash): card on board, laneless; status mapped + full refs (itemId set); user then archives the card via the GitHub UI | card has left the board by the time reconcile runs | previously silent + unresumable; M6 product fix (commit dbb00a0): `classifyDrift` vanished class widened — any candidate with `promotion.itemId` whose marker left the board and whose status ≠ dismissed is classified vanished and offered re-promote \| dismiss \| keep. |
| B1 | writeSnapshot: file write → log append → prune | file write (append fails) | M4b rollback re-proved through the world: orphan unlinked, retry records the event |
| B2 | 〃 | log append (prune fails) | store may exceed keep transiently; next successful write prunes; journal intact |
| C1 | syncRecord: per-candidate ledger appends + hash/manifest settlement | mid-batch | re-run records only missing items (coverage-gated hashes); no duplicate candidates |
| D1 | summary: writeState → snapshot piggyback | writeState (piggyback fails) | non-fatal by design; next session diffs correctly from the state that DID persist. Scope: snapshot-piggyback failure only — `teamSync` sits outside this non-fatal guard and is not exercised by M6 config. |
| E1 | undo execution: move ops → route ops | between ops | re-running invert vs the SAME pinned anchor proposes only the remainder |

## 6. Scenarios & soak

**`tests/sim-scenarios.test.mjs`** — the atlas rows plus four composition stories:
- **The anchor-trap session:** session 1 promotes + snapshots; user mutates; session 2 starts (hook re-snapshots the mutated board); undo via pinned older ref succeeds; undo via `latest` yields the empty plan WITH the anchor-trap hint in the say.
- **The long week:** 5 sessions of mixed pipeline runs + human edits (moves, flips, an archive, a retitle); each session's summary diff is consistent with the journal's account; `snapshot log` tells the same story end-to-end.
- **The messy repo:** two promoted cards; user archives one and ledger-dismisses the other (a dismissed-but-live card + a vanished card). `reconcileScan` detects both; operator keeps both (`keep` decisions). Board write-ops are asserted zero — reconcile heals the ledger only. Heal is self-extinguishing: second scan clean, dismissal preserved.
- **Heal-for-real:** a separate story exercising actual mutations. Two legs: (1) a dismissed-but-live card settled via `settle` — `reconcileApply` re-adopts the live card: status set to `promoted`, refs written from the board scan; (2) a dead-source candidate (source file `GONE.md` absent on disk) dismissed. Both heals are self-extinguishing: second scan clean. `settle`'s exact semantics: sets status → `'promoted'` and writes `promotion` refs (issueNumber, issueUrl, itemId) from the reconcile scan's board read — not from any cached state. `dismiss` sets status → `'dismissed'`; the candidate record is retained.

**`tests/sim-soak.test.mjs`** — seeded LCG PRNG (no deps; the seed is the test's name). 4 fixed seeds × ~120 steps; weighted op draw (heavy: humanMove/summary/newSession; light: crashedPromote/archive/retitle/undoTo). `checkInvariants()` after every step. On violation: throw includes seed, step index, and the full op trace (replayable verbatim). Runtime budget: a few seconds total.

**`tests/sim-world.test.mjs`** — world self-tests: additive/subtractive label semantics, archive/retitle visible in `listItems`, `failNext` fires exactly once, and a deliberate violation (hand-broken world via a test-only backdoor) proves `checkInvariants()` throws — the harness cannot be vacuous.

## 7. Live E2E & runbook

**`tests/live-e2e.test.mjs`** (skip unless `GBS_LIVE=1`; becomes the 4th gated skip): bootstrap a throwaway board from a sandbox repo → seed one TODO line → real sync/map/promote of one card → live `move` → `reconcile scan` (expect clean) → `snapshot take` + live mutation + `snapshot diff`/`invert` (read-only assertions) → teardown in a `finally` block; if teardown itself fails, print every leftover resource id. **Teardown deletes the project only** — issues are left open (the runbook documents manual closure and the `gbs-e2e-` title-prefix search for orphans).

**`docs/LIVE-RUNBOOK.md`**: prerequisites (gh auth, scopes, sandbox repo), the exact command, what gets created (names/labels), expected output shape, how to verify teardown, what to do about leftovers, and the standing rule — `GBS_LIVE=1` is operator-only, never set in automated/subagent runs.

## 8. Error handling

- **The world fails loud and labeled** — invariant throws name the invariant and ids; soak throws add seed + step + trace.
- **Faults are one-shot and scoped** — `failNext` clears after firing; `crashedPromote` also clears any unconsumed faults in its `finally` block (leak-proofing); no fault leaks across scenarios; sabotage paths live under the world's temp dir only.
- **`newSession()` after a crash asserts recoverability** (summary completes; invariants hold) rather than assuming it.
- **Live E2E**: teardown in `finally`; leftover ids printed on teardown failure so the runbook's cleanup-verification step has a target.
- **Found bugs**: fixed in separate atomic commits, each with a regression test; the scenario/soak that found it keeps passing afterward.

## 9. Module context

| Module | What it is | Status |
|---|---|---|
| **M1 · Foundation** | Provisioning + intent ledger | ✅ shipped |
| **M2 · The Brain** | Mapper + ruleset + ambiguity dialogue | ✅ shipped |
| **M3a/b/c** | Promote · source adapters · real-time signal | ✅ shipped |
| **M4a · Reconcile** | Drift detection + ledger-only healing | ✅ shipped |
| **M4b · Time-travel** | Snapshots + permanent event log | ✅ shipped |
| **M5 · Skill layer** | SKILL.md, drift gates, undo reflex, evals | ✅ shipped |
| **M6 · Verification & simulation** *(this spec)* | Sim world, crash atlas, soak, live E2E | designing |
