# M5 "Skill Layer" — Design Spec

**Date:** 2026-06-11
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M5 of the github-boards buildout (see §9).
**Predecessors:** [M4b spec](2026-06-10-m4b-timetravel-design.md) · [M4a spec](2026-06-10-m4a-reconcile-design.md) · [M3b spec](2026-06-10-m3b-source-adapters-design.md) · [M1 spec](2026-06-08-m1-foundation-design.md)

---

## 1. Purpose

The engine is five milestones deep; the prose that *triggers* it stopped at two. `skills/github-boards/SKILL.md` and `commands/board.md` document only the M1/M2 verbs — nothing about `promote` (M3a), `sync` (M3b), `reconcile` (M4a), `snapshot` (M4b), the hooks' unprompted context, or the undo story M4b §8 promised. M5 makes the LLM-facing layer catch up — **and stay caught up**, by making prose drift a test failure.

Three deliverable families:

1. **Prose** — SKILL.md rewritten to the full pipeline; `commands/board.md` refreshed; new `references/undo-contract.md`; `AGENTS.md` vendor-neutral mirror (fulfilling SKILL.md's existing "must mirror to AGENTS.md" promise).
2. **The undo reflex, code-backed** — a pure `invertDiff` + read-only `snapshot invert` CLI so the inverse of a diff is computed mechanically, never by model arithmetic.
3. **Evals** — deterministic drift gates inside `npm test` (CLI help is the source of truth; prose must cover it), plus a **gated** LLM scenario harness (`GBS_EVAL=1`, operator-only) grading verb selection against fixtures.

**Decided posture (Q&A):**
- **Evals: both kinds.** Deterministic gates run forever and for free; the LLM harness is occasional, manual, advisory — never CI, never automated runs.
- **Undo inversion is code-computed.** `invertDiff` is testable; prose-only inversion is unevaluable and occasionally wrong (swapped from/to, missed relabels).
- **AGENTS.md ships** (not dropped): identical body, no Claude-specific frontmatter, held identical by a drift gate.
- **Out of scope:** README/wiki refresh, `snapshot restore`, any new board-write verb, M6 simulation work.

## 2. Scope

### In scope
- **`skills/github-boards/SKILL.md`** — full rewrite (same voice, same hard rules): frontmatter trigger phrases for the new surfaces; verb table gains promote/sync/reconcile/snapshot rows; sections for session-start + real-time hook context; the undo reflex; a pipeline map.
- **`commands/board.md`** — verb list refreshed to the full CLI.
- **`skills/github-boards/references/undo-contract.md`** — the full undo contract (SKILL.md carries only the three-line reflex).
- **`AGENTS.md`** (repo root) — vendor-neutral mirror of SKILL.md's body.
- **`scripts/lib/snapshots.mjs`** — `invertDiff(diff)` pure → `{ops, manual}`.
- **`scripts/board-manager.mjs`** — `snapshotInvert(refA, refB, ctx)` verb + CLI `snapshot invert [<ref>] [<ref2>]` (same dispatch path and defaults as `snapshot diff`).
- **`tests/skill-evals.test.mjs`** — deterministic drift gates (in `npm test`).
- **`evals/scenarios.json`** + **`scripts/eval-skill.mjs`** — gated LLM harness.
- Unit/verb/cross-module tests for invert.

### Out of scope (deferred)
- **`snapshot restore`** — the invert→move/route path is the undo story; batch restore still waits for demonstrated need.
- **Auto-generated SKILL.md** — prose stays hand-written; gates enforce coverage, not wording.
- **README.md / wiki/** refresh — separate docs pass.
- **Retitle/archive verbs** — inversions that need them land in `manual` instead.

## 3. Architecture & data flow

```
                       ┌── deterministic gates (npm test) ──────────────┐
scripts/board-manager.mjs --help   ←── source of truth: the verb tokens │
        │ parsed by                                                     │
tests/skill-evals.test.mjs ──asserts──► SKILL.md verb table             │
                           ──asserts──► commands/board.md verb list     │
                           ──asserts──► AGENTS.md body ≡ SKILL.md body  │
                           ──asserts──► hard-rule + trigger sentinels   │
                           ──asserts──► references/ links resolve       │
                       └────────────────────────────────────────────────┘

undo reflex (read-only until the user approves):
  "undo what happened since X"
     → snapshot invert <ref>            CLI prints {ops, manual} + say   (zero writes)
         ops    = [{op:'move',  issueNumber, to}, …]                    (lane restores)
                  [{op:'relabel', issueNumber, add, remove}, …]         (label restores)
         manual = added/removed/retitled cards with reasons             (never proposed)
     → show user → approval → execute ops via existing move/route verbs → report back

gated LLM harness (manual only):
  GBS_EVAL=1 node scripts/eval-skill.mjs
     → for each evals/scenarios.json fixture {id, say, expectVerb, expectArgs?}
     → `claude -p` with SKILL.md body + "which verb? answer JSON"
     → grade, scorecard (advisory; never a CI gate; refuses without GBS_EVAL=1)
```

## 4. Components & interfaces

New code is **bold**.

| Unit | Responsibility | Interface |
|---|---|---|
| **`invertDiff`** (lib/snapshots.mjs) | PURE inverse of a `diffSnapshots` result. | `invertDiff(diff)` → `{ops:[…], manual:[…]}`. `moved {from,to}` → `{op:'move', itemId, issueNumber, title, to:<from>}`; `relabeled {added,removed}` → `{op:'relabel', itemId, issueNumber, title, add:<removed>, remove:<added>}`; `added` → manual `{itemId, issueNumber, title, reason:'filed during this window — archive by hand if unwanted; never auto-deleted'}`; `removed` → manual (`'left the board — not recreated'`); `retitled` → manual (`'no retitle verb — rename by hand'`). Null/empty-bucket tolerant. Ops order: all moves, then all relabels. |
| **`snapshotInvert`** (board-manager.mjs) | Verb: diff two refs (refB omitted → live board, one `listItems` read) then invert. Zero board writes. | `snapshotInvert(refA, refB, ctx{engine,config,dir})` → `{ops, manual, say}`. Empty diff → say "Nothing to undo …". CLI: `snapshot invert [<ref>] [<ref2>]` (defaults `latest` vs live), prints say + JSON, dispatched beside `snapshot diff` (loadConfig path; honors `--config`). Unknown-sub Tier-0 guard updated to admit `invert`. |
| **`SKILL.md`** | Teach the full pipeline + reflexes. | Frontmatter description adds trigger phrases: "promote the backlog", "sync my TODOs onto the board", "heal the ledger / is the board out of sync", "what changed this week", "what did the board look like before", "undo what happened since". Body adds: verb-table rows (`promote scan\|apply`, `sync scan\|record`, `reconcile scan\|apply`, `snapshot take\|list\|diff\|log\|invert`); a **session-start & real-time** section (hooks inject the summary digest and once-per-file change notes unprompted — don't re-run summary redundantly); the **undo reflex** (3 lines, linking the contract); a **pipeline map** (sync → ledger → map → promote → board; reconcile + snapshots as maintenance loops). Existing six hard rules and `AGENTS.md`-mirror sentence kept verbatim. |
| **`references/undo-contract.md`** | Full undo contract. | When to trigger; run `snapshot invert`; preview `ops`+`manual` to the user; on approval execute `ops` one-by-one via `move`/`route` (each already approval-gated/staged-capable); never act on `manual` items; report back; what to say when `ops` is empty but `manual` isn't. |
| **`AGENTS.md`** | Vendor-neutral mirror. | SKILL.md body (everything below the frontmatter) byte-identical, prefixed by a 2–3 line plain header (title + "this mirrors skills/github-boards/SKILL.md; do not edit separately"). The drift gate enforces identity of the shared body. |
| **`commands/board.md`** | `/board` keeps parity. | Verb list extended with promote/sync/reconcile/snapshot (+invert) and the `--staged` note unchanged. |
| **`tests/skill-evals.test.mjs`** | The drift gates. | Spawns `node scripts/board-manager.mjs --help` (execFile, fs-only), parses verb tokens from help lines; asserts each token appears in SKILL.md AND commands/board.md; strips frontmatter and asserts AGENTS.md shared body equals SKILL.md body; sentinel-asserts the six hard rules, each frontmatter trigger phrase, and that every `references/…` path SKILL.md mentions exists. |
| **`evals/scenarios.json`** | Fixture corpus. | ~15–20 of `{id, say, expectVerb, expectArgs?}` covering every verb family + ≥3 negatives (`expectVerb: null` — e.g. "move this function into utils.mjs" must trigger nothing). |
| **`scripts/eval-skill.mjs`** | Gated runner. | Refuses without `GBS_EVAL=1` (live-gate-style message). Per scenario: `claude -p` with a fixed prompt embedding SKILL.md body + the scenario `say`, demanding JSON `{verb: string\|null}`; grade vs `expectVerb`; scorecard to stdout (per-scenario pass/fail + totals). Exits non-zero if `claude` CLI missing, with a plain message. Advisory only. |

## 5. Error handling

- **`snapshot invert` is loud** (user verb): unresolvable refs error exactly like `diff`; corrupt snapshot errors name the file.
- **Empty diff** → `{ops:[], manual:[]}`, say "Nothing to undo between A and B."
- **Ops-empty but manual-nonempty** → say states there's nothing executable and points at the manual list.
- **Eval runner**: no `GBS_EVAL=1` → refusal naming the gate; `claude` missing → plain error, exit 1; per-scenario model output that isn't parseable JSON → that scenario FAILS (counted, not fatal to the run).
- **Drift gates** fail with messages naming the missing verb/sentinel/file, so the fix is obvious from the test output.

## 6. Testing

All deterministic unless gated. Temp dirs, mock engine, no live surface, no LLM calls in `npm test`.

1. **`invertDiff` unit** (append to `tests/snapshots.test.mjs`): moved → inverse move (from/to swapped); relabeled → add/remove swapped; retitled/added/removed → `manual` with the exact reasons; empty/null diff → empty result; multi-bucket card → one op per inversion, moves ordered before relabels.
2. **`snapshotInvert` verb** (append to `tests/snapshot-verb.test.mjs`): two refs; ref vs live (exactly one `listItems`, and `engine.calls` contains NO createIssue/setStage/setLabels/addIssueToBoard/comment — the read-only promise pinned); empty-diff say; manual rendering.
3. **Drift gates** (`tests/skill-evals.test.mjs`): the assertions in §4 — incl. a meta-check that the help parser found a sane number of verbs (≥ 10) so a help-format change can't silently turn the gates into no-ops.
4. **Cross-module reality check** (standing lesson; `tests/skill-evals.test.mjs` or a sibling): REAL chain — `writeSnapshot` baseline from the stateful mock board → mutate via the engine's own `setStage`/`setLabels` → real `snapshotDiff` → real `invertDiff` → execute the proposed ops back through the engine's `setStage`/`setLabels` → final `diffSnapshots(baseline, live)` is empty for surviving cards. No hand-built diff fixtures at the boundary.
5. **Gated harness** (never in `npm test`): `GBS_EVAL=1 node scripts/eval-skill.mjs` — manual, advisory.

**Safety rule (standing, extends GBS_LIVE):** `GBS_EVAL=1` is operator-only. Never set it in automated/subagent runs; the runner's refusal is the enforcement backstop.

## 7. Open questions (resolve/verify at plan time)

- **Help-token parsing**: verify the exact `--help` line format (column layout, sub-verb spellings like `promote scan|apply`) and pick a tolerant token extractor; the ≥10 meta-check guards it.
- **`claude -p` invocation shape**: verify headless flags (`-p`, output format) on the installed CLI at plan time; keep the prompt fixed and minimal.
- **`relabel` op execution**: `route` flips owner labels; arbitrary label restores may need `move`-adjacent handling — verify which existing verb (or `setLabels` via which verb) executes a generic relabel, and have `undo-contract.md` say exactly that. If only owner-label swaps are executable today, non-owner relabels land in `manual` (decide at plan time from the real verb surface).

## 8. Module context

| Module | What it is | Status |
|---|---|---|
| **M1 · Foundation** | Provisioning + intent ledger | ✅ shipped |
| **M2 · The Brain** | Mapper + ruleset + ambiguity dialogue | ✅ shipped |
| **M3a/b/c** | Promote · source adapters · real-time signal | ✅ shipped |
| **M4a · Reconcile** | Drift detection + ledger-only healing | ✅ shipped |
| **M4b · Time-travel** | Snapshots + permanent event log (read-only) | ✅ shipped |
| **M5 · Skill layer** *(this spec)* | SKILL.md, triggering, evals, undo reflex | designing |
| **M6 · Verification & simulation** | Unit + simulation + live integration | backlog |
