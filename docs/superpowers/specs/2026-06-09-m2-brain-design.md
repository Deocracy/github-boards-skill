# M2 "The Brain" — Design Spec

**Date:** 2026-06-09
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M2 of the github-boards buildout (see §12)
**Predecessors:** [M1 spec](2026-06-08-m1-foundation-design.md) · [buildout feasibility](../../plans/2026-06-08-board-skill-buildout-feasibility.md)

---

## 1. Purpose

M1 gave the skill an **intent ledger** that collects board-able *candidates* with `suggestedLane`/`suggestedOwner` left `null`. M2 is the reasoning layer that fills them in: a **strongest-model "mapper"** that turns raw candidates (plus live session work) into well-shaped board-card *proposals* — deciding card-vs-comment, lane, owner, granularity (split/merge), and flagging genuine ambiguity for the human instead of guessing.

The mapper is the LLM, so it cannot be a deterministic script. M2 bounds it with a **deterministic harness on both sides** (prepare the input → LLM reasons → validate + record the output) and a **ruleset** it must obey. M2 **enriches the ledger only — it never writes to the board** (M3 promotes). This keeps M2 a pure, simulation-testable brain.

## 2. Scope

### In scope
- `lib/mapper.mjs` — pure validate/enrich core (`resolveRules`, `prepareInput`, `validateProposal`, `applyProposals`).
- `map prepare` / `map record` verbs in `board-manager.mjs`.
- The **mapper contract** (`references/mapper-contract.md`): universal mapping principles + the proposal schema + escalation triggers; a minimal pointer from SKILL.md so it's usable.
- The **ruleset**: universal principles (in the contract) + a tunable `rules` block in `board.json` (defaults via `resolveRules`).
- **Hybrid invocation**: inline mapping by default; escalate to an opus sub-agent on low-confidence / large-batch / inter-skill ambiguity.
- **Ambiguity surfacing** (I5): `needsDecision` proposals recorded as `needs-decision`, returned as questions.
- **Simulation test harness** + deterministic unit tests.

### Out of scope (later modules)
- Board promotion of mapped candidates → **M3** (M2 stops at an enriched ledger).
- Reading external GSD/superpowers artifact *files* (source adapters) → **M3**. M2 reasons over ledger candidates + a session snapshot handed to it; it does not parse `.planning/` or plan markdown itself.
- Full SKILL.md triggering-description optimization + evals → **M5** (M2 ships only a minimal contract pointer).
- Real-time "build as you brainstorm" promotion loop → **M3** (M2 provides the brain it will call).

## 3. Architecture & data flow

```
board-manager.mjs map prepare [--session <file>]
   reads: unmapped ledger candidates + config rule-knobs + allowed lanes/owners
          + a session-work snapshot (passed in by the controller)
   → emits a MAPPER INPUT packet (JSON)
          │
   ┌──────┴──  MAPPER REASONING (Claude, per references/mapper-contract.md)  ──┐
   │  inline (default): the session Claude maps                                │
   │  escalate → dispatch opus sub-agent WHEN: any confidence <                │
   │     escalateConfidenceBelow, batch > escalateBatchOver, or inter-skill    │
   │     conflict (I5)                                                         │
   │  → PROPOSALS (array, the §5 schema)                                       │
          │
board-manager.mjs map record (--proposals <path> | stdin)
   → VALIDATE each proposal FAIL-CLOSED (§9): lane ∈ config.stageOptions,
     owner ∈ {agent,human}, valid kind, candidateId exists, confidence ∈ [0,1],
     distinct lanes ≤ maxLanes
   → write enriched candidates to the LEDGER (status → mapped | needs-decision
     | merged | split | dismissed[for kind:skip], extending M1's status enum);
     reject invalid proposals (report, don't write)
   → return a report + the ambiguity questions
          │
   [M3 later: promote 'mapped' candidates to the board, approval-gated]
```

**M2/M3 boundary:** M2 never touches the board; it only enriches `ledger.json` and surfaces questions. M3 owns promotion.

## 4. Components & interfaces

New code is **bold**.

| Unit | Responsibility | Interface |
|---|---|---|
| **`lib/mapper.mjs`** | Pure validate/enrich core (no network, no board) | `resolveRules(config)` → rules · `prepareInput(ledger, config, session)` → packet · `validateProposal(p, config, rules)` → `{ok, errors[]}` · `applyProposals(ledger, proposals, config)` → `{ledger, report, questions}` |
| **`board-manager.mjs` `map` verb** | Wrap the LLM in two deterministic modes | `map prepare [--session <file>]` → prints input packet · `map record --proposals <path>` → validates + enriches ledger + prints report/questions |
| **`references/mapper-contract.md`** | The reasoning contract: universal principles, the proposal schema, escalation triggers | read by the skill when mapping |
| **`rules` block** in `board.json` | Per-board tunable knobs (optional; defaults via `resolveRules`) | see §6 |

`lib/mapper.mjs` mirrors M1's pure-module pattern (`state.mjs`/`ledger.mjs`) → unit- and simulation-testable. `map record` is fail-closed like the M1 engine.

## 5. Proposal schema (per candidate)

```jsonc
{
  "candidateId": "<M1 content-hash>",      // ties back to the ledger candidate
  "kind": "card" | "comment" | "skip",     // skip = not board-able (noise)
  "title": "...",                          // refined card title
  "lane": "Building" | null,               // MUST ∈ config allowed lanes (null for comment/skip)
  "owner": "agent" | "human" | null,
  "confidence": 0.0,                        // 0..1 — drives escalation + surfacing
  "commentTarget": 12 | null,               // for kind:comment — the card it annotates
  "split": [{ "title": "...", "lane": "...", "owner": "..." }] | null,  // bundle → multiple cards
  "mergeWith": "<candidateId>" | null,      // duplicate → merge (idempotency)
  "needsDecision": { "question": "...", "options": ["..."] } | null,    // I5 ambiguity → ask the user
  "rationale": "..."                        // brief why (report + audit trail)
}
```

Carries every mapping decision: card-vs-comment-vs-skip, lane/owner, granularity (`split`), dedup (`mergeWith`), ambiguity (`needsDecision`), rationale.

## 6. The `rules` config block

Optional in `board.json`; back-compat — M1 configs without it still load (defaults from `resolveRules`).

```jsonc
"rules": {
  "maxLanes": 8,                   // cap on distinct lanes the mapper may use
  "useTags": false,                // may it suggest labels/tags, or lanes only?
  "defaultOwner": "human",         // owner when it can't infer one
  "granularity": "fine",           // "coarse" (epics) | "fine" (tasks) → split preference
  "escalateConfidenceBelow": 0.6,  // inline maps; escalate to opus if any candidate is below this
  "escalateBatchOver": 12          // escalate if a single run exceeds N candidates
}
```

Universal principles (*"a card is one actionable outcome; a comment is context on an existing card; never invent a lane outside the allowed set"*) live in `mapper-contract.md`; only these knobs are per-board.

## 7. Idempotency

- Stable key = M1's content-hash **`candidateId`**.
- `applyProposals` enriches only candidates in status `candidate` (skips settled items: `mapped`/`needs-decision`/`merged`/`split`/`dismissed`/`promoted`) → re-running `map` is a no-op on settled items. (Re-mapping a settled candidate — the `needsDecision` resolution / re-record path — is deferred to M3; M2 ships no `--remap`.)
- **`mergeWith`** marks the duplicate `merged` (pointing at the survivor) → never a second card.
- **`split`** children get deterministic ids (`hash(parentId + childTitle)`) → re-running yields the same children, no duplicate splits.
- Promotion-level dedup (no duplicate GitHub issues) is M3's job; M2 sets the durable `candidateId` M3 will stamp into the issue body as the external-id marker.

## 8. Ambiguity & escalation (I5)

- **Escalate inline → opus sub-agent** when any trigger fires: a candidate `confidence < escalateConfidenceBelow`, batch `> escalateBatchOver`, or **inter-skill conflict** (candidates from 2+ sources that disagree). The contract instructs Claude to re-map the affected batch with the strong model and use its proposals.
- **Surface, don't guess:** a `needsDecision` proposal is recorded as `needs-decision` (never auto-mapped); `map record` returns these as questions the controller puts to the user. The answer→re-record path itself lands in **M3** (M2 only surfaces). Inter-skill ambiguity becomes an explicit "which source should drive this?" question.

## 9. Error handling (fail-closed)

- `map record` validates every proposal: lane ∈ `config.stageOptions` (rejects invented lanes), `owner ∈ {agent,human}`, valid `kind`, `candidateId` exists, `confidence ∈ [0,1]`, distinct lanes ≤ `maxLanes`. **Valid proposals record; invalid ones are rejected (never written) and returned in the report** — one bad proposal can't poison a good batch, and nothing invalid reaches the ledger.
- Malformed / non-schema mapper output → the whole batch is refused with a legible message.
- `map prepare` with nothing unmapped → empty packet, not an error.
- M2 **never writes to the board**, even on success.

## 10. Testing & simulation

1. **Deterministic unit** (extend the suite): `resolveRules` (default+override merge) · `prepareInput` (packet shape; skips settled candidates) · `validateProposal` (each fail-closed rule: invented lane, bad owner, over `maxLanes`, missing `candidateId`, bad confidence) · `applyProposals` (enrich; merge-collapse; deterministic split ids; needs-decision status; partial-validity report).
2. **Simulation harness** (the LLM mapper — the "verify with N simulations" requirement; built here). A scenario corpus — *clean single-source set · bundle-needing-split · duplicates-needing-merge · low-confidence lane · inter-skill conflict · pure noise (skip) · oversized batch (escalation)* — each run **N times**, measuring: **correctness** (proposals vs. a golden/rubric, graded by assertions or an LLM judge), **consistency** (variance across runs; mean±stddev), **idempotency** (re-map → identical enriched ledger, no dupes), **rule-adherence** (never invents a lane; respects `maxLanes`; escalates when it should). Gated behind a flag (LLM runs are costly + nondeterministic), like M1's live test.

## 11. Open questions (resolve/verify at plan time)

- **Sub-agent model override:** confirm the mechanism by which the skill dispatches a model-pinned (opus) sub-agent for escalation, and how the session-work snapshot is passed to it. (Load-bearing for hybrid invocation — verify against Claude Code's Task/Agent capabilities during planning, the way M1 verified GraphQL shapes.)
- **Simulation grading:** golden-fixture assertions vs. an LLM judge vs. both — decide per scenario; LLM-judge needs a rubric and adds nondeterminism to the test itself.
- **Contract location:** `references/mapper-contract.md` read on demand vs. inlined into SKILL.md — settle the discovery path (SKILL.md edits otherwise belong to M5).
- **Session snapshot shape:** what exactly the controller hands the mapper as "live session work" (a freeform summary vs. structured recent-actions) — define the minimal useful shape.
- **`needsDecision` resolution loop:** RESOLVED at plan time — deferred to **M3** (its interactive promotion loop owns the answer→re-record path). M2 only surfaces the questions and ships no `map resolve` / `--remap`.

## 12. Module context

M2 is the second of six modules ([M1 spec §8](2026-06-08-m1-foundation-design.md)).

| Module | What it is | Status |
|---|---|---|
| **M1 · Foundation** | Provisioning + intent ledger | ✅ shipped |
| **M2 · The Brain** *(this spec)* | Mapper + ruleset + ambiguity dialogue (I1, I2, I5, I7) | designing |
| **M3 · Real-time import** | Feed sources to the mapper; build the board live; approval-gated promotion; boundary sync (C2, C3, I8, I9) | backlog |
| **M4 · Board→skill + time-travel** | External-change detection; linked-doc pull/act/record; versioned snapshots (C4, I10) | backlog |
| **M5 · Skill layer** | SKILL.md, triggering-description tuning, evals (C5) | backlog |
| **M6 · Verification & simulation** | Unit + simulation (N-run variance, idempotency) + live integration (I4) | seeded by M1/M2 |
