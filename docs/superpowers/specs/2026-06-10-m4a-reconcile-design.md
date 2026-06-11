# M4a "Reconcile" — Design Spec

**Date:** 2026-06-10
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M4a of the github-boards buildout (see §11). M4 was decomposed: **M4a · Reconcile** (this spec) and **M4b · Time-travel** (versioned snapshots — separate later spec).
**Predecessors:** [M3c spec](2026-06-10-m3c-realtime-design.md) · [M3b spec](2026-06-09-m3b-sources-design.md) · [M3a spec](2026-06-09-m3a-promotion-design.md)

---

## 1. Purpose

Three stores can drift apart: **source files**, the **ledger**, and the **live board**. M3a stamped every created issue with a `<!-- gboards:cid=… -->` marker and M3b recorded `source` provenance *precisely for this module* — until now both are write-only promises. M4a reads them back, classifies drift, and heals it — closing the trust gap that makes the pipeline safe to rely on daily.

**The key architectural decision: reconcile heals the LEDGER, never the board.** Every healing action — adopting an orphaned issue's refs, settling a crash-window candidate, dismissing dead-source work, resetting a vanished card for re-promotion — is a ledger write. Board mutations remain exclusively `promote`'s job (a `re-promote` decision resets the candidate to `mapped`; the next `promote apply` does the creating). Consequences: `reconcile apply` needs no stagedGuard and no pushPolicy gate; the only new live surface is **one read** (issue bodies, so the scan can see markers).

## 2. Scope

### In scope
- **`lib/reconcile.mjs`** — pure drift classification + decision resolution (`classifyDrift`, `resolveReconcileDecisions`).
- **`engine.listItemsWithBodies()`** — one new read op in `board.mjs` + the DI contract.
- **`reconcile scan` / `reconcile apply [--decisions <file>]`** verbs in `board-manager.mjs` + CLI.
- The reconcile **decisions-file schema** (same idiom as promote's).
- Four drift classes: crash-orphan, unknown-marker (safe heals); vanished, dead-source (needs-decision).
- `duplicates[]` **report-only** bucket (two live issues bearing the same cid).
- Deterministic unit + cross-module integration tests; one gated (`GBS_LIVE=1`, operator-only) live smoke for the new read op.

### Out of scope (deferred)
- **Board writes of any kind** — including deleting duplicate issues. Reconcile reports; promote (or the human) mutates.
- **Source-file writes** (board→plan checkbox writeback) → M5+, it edits user files and wants the conversational layer.
- **Retitle-ghost heuristics** (old+new candidates sharing a `source` ref) → deferred; same-source matching is judgment-shaped and wants the LLM in the loop (M5).
- **Hook integration** — reconcile is on-demand (or an M5 reflex). Session start already does one board read for `summary`; adding per-item body fetches there would bloat it.
- **Time-travel snapshots** → M4b.
- **Permanent mute for `keep`** — `keep` means "not now," not "never ask again"; kept items resurface on later scans. A durable mute is YAGNI until someone wants it.

## 3. Architecture & data flow

```
reconcile scan        (read-only: one live board read + fs existence probes)
   boardItems = engine.listItemsWithBodies()        ← NEW engine read op
   parseCid(item.body) per item (reuses lib/promote.parseCid)
   classifyDrift({ledger, items, sourceExists}):
     • marker ↔ candidate match, cand NOT promoted   → CRASH-ORPHAN  (safe heal)
     • marker matches NO candidate                   → UNKNOWN-MARKER (safe heal: adopt)
     • promoted cand, no live item carries it        → VANISHED      (needs-decision)
     • unpromoted cand, source file gone             → DEAD-SOURCE   (needs-decision)
     • two live items, same cid                      → DUPLICATES    (report-only)
   → prints { safeHeals[], uncertain[], duplicates[], clean }
        │
   Claude gathers decisions for uncertain items (AskUserQuestion → decisions file):
     { "<candidateId>": { "action": "re-promote" | "dismiss" | "keep" } }
        │
reconcile apply [--decisions <file>]   (LEDGER-ONLY writes, fail-closed)
   safe heals auto-apply on every run:
     crash-orphan  → status→'promoted', promotion refs adopted from the live item
     unknown-marker→ append candidate {id: cid, …, status:'promoted', refs}
   decided uncertain items:
     re-promote → status→'mapped', promotion deleted  (promote re-creates later)
     dismiss    → status→'dismissed'
     keep       → untouched, reported (resurfaces on later scans)
   undecided uncertain → held (never blocks the safe heals)
   → report { healed[], adopted[], reset[], dismissed[], held[], duplicates[], errors[] }
```

## 4. Components & interfaces

New code is **bold**. Same pure-module + injectable-engine pattern as M1–M3.

| Unit | Responsibility | Interface |
|---|---|---|
| **`lib/reconcile.mjs`** | Pure classification + decision resolution. No fs, no network — board items, ledger, and an existence-probe are passed in. | `classifyDrift({ledger, items, sourceExists})` → `{safeHeals[], uncertain[], duplicates[], clean:boolean}` · `resolveReconcileDecisions(drift, decisions)` → `{toApply[], held[], errors[]}` |
| **`engine.listItemsWithBodies()`** (`board.mjs` + DI contract in board-manager's header) | Board items including each issue's **body**. Read-only — no stagedGuard. | → `{ items: [{itemId, issueNumber, title, stageLabel, labels[], body}], count }` |
| **`board-manager.mjs` verbs** | `reconcileScan(ctx)` read-only compose; `reconcileApply(decisions, ctx)` fail-closed ledger-only writes, per-item persist. | `ctx = {engine, config, dir}` |
| **CLI** | Dispatch + help. Requires a configured board (loadConfig path — unlike `sync`, reconcile is meaningless without one). | `reconcile <scan\|apply> [--decisions <file>]` |

### Classification details (`classifyDrift` is pure)

- **Marker index:** `parseCid(item.body)` over all items → `cid → item[]` map. Items without markers (hand-made cards) are ignored — reconcile governs only skill-created cards.
- **crash-orphan** (safe): a marker's cid matches a candidate with `status !== 'promoted'`. Heal = `status→'promoted'`, `promotion = {issueNumber, itemId}` (+`issueUrl` if derivable) adopted from the live item.
- **unknown-marker** (safe): cid matches no candidate (ledger wiped/regenerated). Heal = append candidate `{id: cid, title: item.title, source: 'reconcile:adopted', status: 'promoted', promotion: {…refs}}`. The explicit `id` (the marker's cid) wins over a fresh title-hash so future scans match. (`appendCandidate` already accepts an explicit `id`.)
- **vanished** (uncertain): candidate `status === 'promoted'` with `promotion.issueNumber`, but no live item carries its marker **or** its issueNumber. The question carries the candidate title + last-known refs; allowed actions `re-promote | dismiss | keep`.
- **dead-source** (uncertain): candidate in `{candidate, mapped, needs-decision}` whose `source` names a file (the part before `#`) that fails `sourceExists` — only when the source **looks like a path** (contains `/` or ends `.md`/known file shape); non-path sources (`manual`, `reconcile:adopted`) are exempt. Allowed actions `dismiss | keep`.
- **duplicates** (report-only): a cid carried by ≥2 live items. First match (lowest issueNumber) is used for any healing; the rest are listed in `duplicates[]`.
- **Boundary cases that classify CLEAN:** promoted candidate whose marker is found (normal); unpromoted candidate with no marker anywhere (normal pre-promotion); a promoted candidate found by issueNumber even if the body lost its marker (edited by a human — issueNumber match is sufficient to count as present).

### `resolveReconcileDecisions` (fail-closed, M3a idiom)

Unknown candidateId, an action outside the class's allowed set, or a decision targeting a safe-heal/clean item → `errors[]`; the **whole apply is refused** before any ledger write. Undecided uncertain items → `held`. Safe heals are always in `toApply` (no decision needed).

## 5. Apply semantics

All ledger-only; **persist after each item** (resumable, as in promote). Heals are **self-extinguishing**: a settled crash-orphan is `promoted` → no longer flagged; an adopted unknown-marker now has a candidate → clean; a re-promoted vanished card is `mapped` → leaves the bucket (and rejoins promote's pipeline, where its re-created issue gets the same cid marker); a dismissed dead-source is settled. Re-running `scan` after `apply` → clean report; re-running `apply` → no-op. Only `keep` items intentionally resurface.

## 6. Error handling

- **Fail-closed apply:** decisions validated wholesale before any write (one bad decision refuses the run — M3a/M3b posture).
- **Scan failures are loud:** a failed live read (gh down, not authed) throws a legible error. Unlike the hooks, this is a user-invoked verb — silent degradation would fake a clean bill of health.
- **Malformed markers** → `parseCid` returns null → item ignored.
- **Crash mid-apply:** per-item persist → re-run continues; already-healed items reclassify clean.
- **Empty cases:** empty board / empty ledger / no markers anywhere → `clean: true` report, not an error.

## 7. Testing

1. **Pure unit (`lib/reconcile.mjs`, no I/O):** every bucket incl. boundaries (promoted+marker → clean; unpromoted+no-marker → clean; marker-lost-but-issueNumber-present → clean; promoted candidate whose marker sits on an item with a *different* issueNumber than its recorded refs → clean — marker presence wins, stale-ref correction is YAGNI); `resolveReconcileDecisions` fail-closed paths (unknown cid, illegal action per class, decision targeting safe-heal); dead-source only for path-like sources; duplicates ordering (lowest issueNumber wins).
2. **Verb tests (mock engine whose `listItemsWithBodies` returns marker-bearing bodies):** scan is read-only (zero ledger writes); apply heals the safe set with per-item persistence; decisions flow incl. held; report shape; loud failure when the engine read throws.
3. **Cross-module integration (the M3a/M3b lesson — real chain, no boundary fixtures):** `syncRecord` → `applyProposals` → `promoteApply` (mock engine) produces real marker bodies → simulate the crash window by reverting the candidate's status and dropping `promotion` → `classifyDrift` catches it → `reconcileApply` heals → re-scan clean. Also: real `promoteApply` output → delete the item from the mock board → vanished detected → `re-promote` decision → candidate back to `mapped` → real `promote apply` re-creates with the same cid.
4. **Gated live smoke (`GBS_LIVE=1`, operator-only):** `listItemsWithBodies` against a real board (the only new live surface). **Never executed in automated/subagent runs. The directive must reach implementer, spec-reviewer, quality-reviewer, AND fixer roles, and the plan marks the live step non-executable.**

## 8. The decisions file

```jsonc
{
  "<candidateId>": { "action": "re-promote" }   // vanished:    re-promote | dismiss | keep
  // "<candidateId>": { "action": "dismiss" }   // dead-source: dismiss | keep
}
```

No lane/owner overrides here (unlike promote's) — a `re-promote` re-enters the normal promote pipeline where lane/owner already live on the mapped candidate.

## 9. Open questions (resolve/verify at plan time)

- **GraphQL body fetch:** confirm whether `board.mjs`'s existing `listItems` GraphQL query can simply add `body` to its issue content fragment (preferred: one op, optional field) or whether a separate `listItemsWithBodies` query/op is cleaner. Decide against the real query shape in board.mjs; the DI contract above is the spec either way.
- **`issueUrl` derivation for adopted refs:** the live item gives issueNumber/itemId; confirm whether the existing query returns the issue URL (promote's resume guards key on `issueNumber`/`itemId`, so `issueUrl` may be null-able in adopted refs — verify nothing downstream requires it).
- **`appendCandidate` explicit-id path:** confirm it accepts `status`/`promotion` fields on insert or whether the adopt heal writes the candidate then patches it (one write preferred).

## 10. Module context

| Module | What it is | Status |
|---|---|---|
| **M1 · Foundation** | Provisioning + intent ledger | ✅ shipped |
| **M2 · The Brain** | Mapper + ruleset + ambiguity dialogue | ✅ shipped |
| **M3a · Promotion + resolution** | Promote mapped candidates; needs-decision loop | ✅ shipped |
| **M3b · Source adapters** | Read external skill artifacts into the ledger | ✅ shipped |
| **M3c · Real-time triggering** | Mid-session change signal (PostToolUse hook) | ✅ shipped |
| **M4a · Reconcile** *(this spec)* | Drift detection + ledger-only healing across source/ledger/board | designing |
| **M4b · Time-travel** | Versioned board snapshots, diff/restore | backlog |
| **M5 · Skill layer** | SKILL.md, triggering, evals — incl. retitle-ghost judgment + board→source writeback | backlog |
| **M6 · Verification & simulation** | Unit + simulation + live integration | seeded by M1–M4 |
