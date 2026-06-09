# M3a "Promotion + Resolution" — Design Spec

**Date:** 2026-06-09
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M3a of the github-boards buildout (see §12)
**Predecessors:** [M2 spec](2026-06-09-m2-brain-design.md) · [M1 spec](2026-06-08-m1-foundation-design.md) · [buildout feasibility](../../plans/2026-06-08-board-skill-buildout-feasibility.md)

---

## 1. Purpose

M1 provisioned the board + intent ledger; M2 enriched ledger candidates into well-shaped *proposals* (lane, owner, card-vs-comment, granularity) and surfaced genuine ambiguity as `needs-decision`. **Neither writes to the board.** M3a is the first module that does: it **promotes** `mapped`/`needs-decision` ledger candidates into real GitHub Projects v2 cards, reusing M1's engine ops unchanged.

Promotion is **approval-gated** and **idempotent**. Confident candidates auto-promote; uncertain ones (low-confidence or `needs-decision`) are surfaced to the human, whose answers are gathered into a decisions file and applied in one pass. Every created issue is stamped with a durable `candidateId` marker, and the ledger candidate flips to `promoted` per-candidate — making a mid-batch failure resumable. M3a also closes the `needs-decision` resolution loop that M2 explicitly deferred.

## 2. Scope

### In scope
- `lib/promote.mjs` — pure classify/resolve/marker core (`classify`, `resolveDecisions`, `cidMarker`, `parseCid`).
- `promote --plan` / `promote --decisions <file> [--staged]` verbs in `board-manager.mjs`.
- The **decisions-file schema** (Claude writes it after the AskUserQuestion round).
- The **body marker** (`<!-- gboards:cid=<candidateId> -->`) as the durable external-id key.
- `promoteConfidenceBelow` knob added to `resolveRules` defaults (default `0.8`).
- The **`needs-decision` resolution loop** deferred from M2 (answer → promote-or-hold).
- Deterministic unit tests + a gated (`GBS_LIVE=1`, operator-only) live smoke.

### Out of scope (later modules)
- Reading external GSD/superpowers artifact *files* (source adapters) → **M3b**. M3a operates only on the ledger.
- Real-time "build as you brainstorm" triggering → **M3c**.
- Board→skill change detection, linked-doc pull, time-travel snapshots → **M4**.
- SKILL.md triggering-description tuning + evals → **M5**.
- Board-scan reconcile (reading markers back off live issues to repair drift) → **M3b/M4**; M3a only *writes* the marker.

## 3. Architecture & data flow

```
board-manager.mjs promote --plan        (read-only — no board writes)
   classify mapped/needs-decision ledger candidates against
   rules.promoteConfidenceBelow:
     • mapped, kind:card, confidence ≥ threshold      → CONFIDENT (auto)
     • mapped, kind:card, confidence < threshold      → UNCERTAIN (ask)
     • needs-decision                                 → UNCERTAIN (carries its question)
     • mapped, kind:comment (confident)               → COMMENT (auto)
     • promoted | dismissed | merged | split(parent)  → SKIPPED
   → prints { confident[], uncertain[], comments[], skipped[] }
          │
   ┌──────┴── Claude (orchestrator) gathers decisions ──┐
   │  asks each UNCERTAIN item via AskUserQuestion        │
   │  → writes a DECISIONS file (§6):                     │
   │    { "<candidateId>": { action, lane?, owner? } }    │
          │
board-manager.mjs promote --decisions <file> [--staged]
   commit set = CONFIDENT + COMMENT (auto) + UNCERTAIN where action="promote"
   per candidate, in order, fail-closed, behind stagedGuard:
     card    → createIssue(title, body+marker) → addIssueToBoard
               → setStage(lane) → setLabels(owner)
     comment → comment(commentTarget, text)
     split parent → skipped (children promote as their own candidates)
   → after EACH success: ledger candidate.status = 'promoted'
     (records issueNumber / issueUrl / itemId)  ← persisted per-candidate (resumable)
   → returns { promoted[], partial[], held[], skipped[], failed[] }
```

**M3a boundary:** M3a is the *first* board-writer. It reads the ledger and M1's engine; it never reads external source files (M3b) and never reacts to live events (M3c).

## 4. Components & interfaces

New code is **bold**. M3a mirrors M1/M2's pure-module pattern (`ledger.mjs`, `mapper.mjs`) → unit-testable with a mock engine.

| Unit | Responsibility | Interface |
|---|---|---|
| **`lib/promote.mjs`** | Pure classify/resolve/marker core (no network, no board) | `classify(ledger, config)` → `{confident[], uncertain[], comments[], skipped[]}` · `resolveDecisions(plan, decisions)` → `{toCommit[], held[], errors[]}` · `cidMarker(candidateId)` → string · `parseCid(body)` → candidateId\|null |
| **`board-manager.mjs` `promote` verb** | Wrap the M1 engine in plan/apply modes | `promote --plan` → prints classification · `promote --decisions <file> [--staged]` → commits + updates ledger + prints report |
| **`promoteConfidenceBelow`** in `resolveRules` | Confidence threshold for auto-promote | default `0.8`; per-board override in `board.json` `rules` |

`promote --decisions` is fail-closed like the M1 engine and reuses its ops (`createIssue`, `addIssueToBoard`, `setStage`, `setLabels`, `comment`) unchanged. The engine is injectable so unit tests can mock it.

## 5. `classify` buckets

`classify(ledger, config)` is pure and read-only. It buckets every candidate by status + (for cards) confidence against `rules.promoteConfidenceBelow`:

| Candidate | Bucket | Notes |
|---|---|---|
| `status:mapped, kind:card, confidence ≥ threshold` | **confident** | auto-promote |
| `status:mapped, kind:card, confidence < threshold` | **uncertain** | reason `"low-confidence"`; synthesizes a lane/owner-confirmation question |
| `status:needs-decision` | **uncertain** | carries its own `needsDecision.question` / `options` |
| `status:mapped, kind:comment, confidence ≥ threshold` | **comments** | auto-promote |
| `status:mapped, kind:comment, confidence < threshold` | **uncertain** | low-confidence comment → ask |
| `status ∈ {promoted, dismissed, merged}` | **skipped** | already settled |
| `status:split` (parent) | **skipped** | children carry their own `candidateId` and classify normally |

An empty/no-mapped ledger yields empty buckets — not an error.

## 6. The decisions file

Claude writes this after the AskUserQuestion round (Approach B — one-shot with pre-gathered decisions):

```jsonc
{
  "<candidateId>": {
    "action": "promote" | "hold",   // hold = leave the candidate untouched this run
    "lane": "Building",              // optional — overrides the mapped lane
    "owner": "agent" | "human"       // optional — overrides the mapped owner
  }
}
```

**`resolveDecisions(plan, decisions)`** — pure merge. Commit set = `plan.confident` + `plan.comments` (auto) **plus** every `plan.uncertain` item whose decision is `action:"promote"` (applying any `lane`/`owner` override). Items with `action:"hold"` or no decision → `held`. A decision referencing an unknown or already-settled `candidateId`, an `action` outside `{promote,hold}`, or an override `lane ∉ stageOptions` / `owner ∉ {agent,human}` → `errors` (fail-closed, never silently dropped).

## 7. The body marker & idempotency

Two layers, marker is source-of-truth:

- **`cidMarker(cid)`** → `<!-- gboards:cid=<candidateId> -->`, appended to every created issue body. **`parseCid(body)`** extracts it back (returns `null` if absent; ignores unrelated HTML comments).
- **Ledger `promoted` status** — the fast path; flipped per-candidate immediately after a successful chain, recording `{issueNumber, issueUrl, itemId}` (or `{commentTarget}` for comments).

Stable key throughout is M1's content-hash `candidateId` (and M2's index-salted `splitChildId` for split children). `promote` skips anything already `promoted`. Before `createIssue`, the apply loop treats an existing issue bearing this `candidateId` marker as "already created" → it does not create a duplicate; it resumes the chain from the first missing step. This is why the marker is stamped **at creation**, not after the full chain completes.

## 8. `promote --decisions` apply loop

In `board-manager.mjs`, behind `stagedGuard`, for each item in the commit set, in order, fail-closed:

- **card:** `createIssue(title, body+marker)` → `addIssueToBoard(projectId, issueId)` → `setStage(itemId, lane)` → `setLabels(issueNumber, [ownerLabel])`. On success: ledger candidate `status → 'promoted'` with refs. **Persist the ledger after each candidate.**
- **comment:** `comment(commentTarget, text)` → `status → 'promoted'` (records `commentTarget`).
- **split parent:** skipped (children promote as their own candidates).

`--staged` runs the identical classification + resolution and prints exactly what *would* be created/commented, writing nothing (the stagedGuard preview path, as in M1).

## 9. Error handling (fail-closed, resumable)

- **Per-candidate atomicity within the chain:** if a later step throws (e.g. `setStage` fails after the issue exists), the candidate is **not** marked `promoted` — reported as `partial` with whatever refs succeeded (`issueNumber`/`issueUrl` captured, `itemId` null). Re-running detects the orphan via the body marker, skips `createIssue`, and resumes from the missing step.
- **One bad candidate can't poison the batch:** the apply loop catches per-candidate, records the failure in `failed[]`, and continues. Report shape: `{promoted[], partial[], held[], skipped[], failed[]}`.
- **Decisions-file validation (fail-closed):** unknown `candidateId`, bad `action`, or invented `lane`/`owner` override → the whole `--decisions` run is refused with a legible message **before any board write**. Malformed JSON → refused the same way.
- **Empty cases:** `--plan` with nothing mapped → empty classification, not an error. `--decisions` with an empty commit set → no-op report.
- **stagedGuard:** `--staged` guarantees zero board writes — the guard wraps the engine calls exactly as in M1 so preview can never leak a real mutation.
- **pushPolicy gate:** `pushPolicy: manual` → `--decisions` refuses to commit (directs the user to `--staged`); `auto-low-risk` (default) and `on-approval` both commit the resolved set. (Reconciliation: M1 wrote the default as `on-approval`; M3a sets the effective default to `auto-low-risk` per the brainstorming decision.)

## 10. Testing & simulation

**1. Deterministic unit — `lib/promote.mjs` (mock engine, no network):**
- `classify`: confident vs. uncertain split at `promoteConfidenceBelow`; `needs-decision` → uncertain with its question; comment bucketing; settled/split-parent → skipped; empty ledger → empty buckets.
- `resolveDecisions`: confident+comments auto-included; uncertain promoted only with `action:"promote"`; lane/owner override applied; `hold`/missing → held; unknown candidateId / bad action / invented lane → error.
- `cidMarker`/`parseCid`: round-trip; marker-less body → null; ignores unrelated HTML comments.

**2. `promote` verb (injected mock engine):**
- `--staged`: classification correct, **zero** engine mutation calls, ledger unchanged.
- commit (card): full chain called in order; ledger candidate → `promoted` with refs; body carries marker.
- commit (comment): `comment` called with `commentTarget`; status → `promoted`.
- idempotency: re-run over a `promoted` candidate → skipped, no second issue.
- **partial-failure resumability:** mock `setStage` to throw once → candidate reported `partial`, not `promoted`; re-run with marker present → `createIssue` skipped, chain resumes, candidate finishes `promoted`.
- split parent → skipped; children promote independently.
- decisions-file validation: unknown cid / bad action / invented lane → run refused, no engine calls.
- `pushPolicy: manual` → `--decisions` refused.

**3. Gated live smoke (`GBS_LIVE=1`, operator-only):** end-to-end against a throwaway project — `map record` → `promote --plan` → `promote --decisions` → assert a real card with the marker, then tear down. **Marked in the plan as operator-gated: never executed in automated/subagent runs.** Per the M1 lesson, this directive must reach implementer, reviewer, AND fixer roles, and the plan task itself flags the live step non-executable so the spec gate stays consistent with the guardrail.

## 11. Open questions (resolve/verify at plan time)

- **Engine injection seam:** confirm the exact mechanism by which `board-manager.mjs` passes a mockable engine into the promote apply loop (mirror how M2's `map record` is tested), so unit tests need no network. Verify against the current `board-manager.mjs` structure during planning.
- **Comment text source:** for `kind:comment`, confirm where the comment body text comes from (the candidate `note`/`title` vs. a refined field) and that `commentTarget` is an issue number the engine's `comment` op accepts.
- **Existing-issue marker scan cost:** `--decisions` resume relies on detecting an issue already bearing a `candidateId` marker. Decide the cheapest reliable check at plan time (ledger `promoted` fast-path covers the common case; the live marker scan is the fallback for orphaned `partial` candidates) — and whether M3a needs any live read at all or can rely on the `partial` ref captured in the ledger.
- **AskUserQuestion batching:** confirm how Claude batches multiple uncertain items into AskUserQuestion rounds (the orchestrator's job, not the script's) and the exact file path/handoff for the written decisions file.

## 12. Module context

M3a is the first slice of M3, the third of six modules ([M1 spec §8](2026-06-08-m1-foundation-design.md)).

| Module | What it is | Status |
|---|---|---|
| **M1 · Foundation** | Provisioning + intent ledger | ✅ shipped |
| **M2 · The Brain** | Mapper + ruleset + ambiguity dialogue | ✅ shipped |
| **M3a · Promotion + resolution** *(this spec)* | Promote mapped candidates to the board; close the needs-decision loop (C2, C3, I8) | designing |
| **M3b · Source adapters** | Read external GSD/superpowers artifacts into the ledger | backlog |
| **M3c · Real-time triggering** | "Build as you brainstorm" promotion loop | backlog |
| **M4 · Board→skill + time-travel** | External-change detection; linked-doc pull/act/record; versioned snapshots (C4, I10) | backlog |
| **M5 · Skill layer** | SKILL.md, triggering-description tuning, evals (C5) | backlog |
| **M6 · Verification & simulation** | Unit + simulation + live integration (I4) | seeded by M1/M2 |
