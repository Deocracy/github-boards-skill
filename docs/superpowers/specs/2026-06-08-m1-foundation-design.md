# M1 Foundation — Design Spec

**Date:** 2026-06-08
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M1 of the github-boards buildout (see decomposition §7)
**Predecessor doc:** [docs/plans/2026-06-08-board-skill-buildout-feasibility.md](../../plans/2026-06-08-board-skill-buildout-feasibility.md)

---

## 1. Purpose

Evolve the github-boards skill from a single-board CRUD driver into a self-provisioning, work-mirroring layer. **M1 is the foundation** that the rest of that vision builds on: it makes a board something the skill can *create from nothing*, and makes "this work wants a board" a tracked, first-class fact from the moment the skill is invoked — without yet building the intelligence (M2) or the live promotion loop (M3).

M1 delivers two tiers of "bootstrap":

- **Tier 0 — intent ledger** (always, automatic, zero network): the instant the skill is invoked, a working file is dropped so Claude starts watching for board-able things, even if no board is ever created.
- **Tier 1 — `bootstrap` verb** (on demand, approval-gated): provision a real GitHub Project (v2) — Project → Stage field → lanes → routing labels — bound to the current project's repo, and write the binding to `board.json`.

## 2. Scope

### In scope
- Tier-0 intent ledger: always created on invoke; holds intent header + candidate items.
- Tier-1 `bootstrap` verb: provision a real board from the **current repo's** git remote, approval-gated.
- A `board.json` **writer** (the config loader is read-only today).
- Four provisioning engine ops behind `stagedGuard()`.
- SessionStart-hook extension (ensure ledger) + a small `ledger` verb.
- Print the browser-only "set view → group by Stage" checklist (never claimed as done).
- Tests: extend the deterministic unit suite + a gated live-integration smoke.

### Out of scope (deferred — see §7)
- The smart-model **mapper** that decides what's board-able and how it maps to lanes → **M2**.
- Promoting ledger candidates → cards **in real time while brainstorming** → **M3**.
- External-change detection, linked-document pull/act/record, board time-travel → **M4**.
- Enforcing `pushPolicy` / `pullCadence` (M1 only *stores* them) → M3/M4.
- Adding options to an *existing* Stage field (the `reshape`-apply path) — M1 creates a fresh field only.

## 3. Architecture & lifecycle

Two tiers, two files. The fail-closed `loadConfig` is **untouched**: the ledger is what exists pre-board, so the `board.json` loader never has to tolerate a half-populated config.

```
INVOKE SKILL
  │
  ├─[Tier 0 · always · no network]──────────────────────────────
  │   SessionStart hook → ensureLedger(.github-boards/ledger.json)
  │   → { intent:{wantsBoard?, boundBoard:null, pushPolicy, pullCadence}, candidates:[] }
  │   → Claude appends board-able candidates here as you work
  │
  └─[Tier 1 · on demand · approval-gated]───────────────────────
      bootstrap
        1. detectRepo()  ← current git remote → {owner, repo, ownerType}
        2. STAGED preview: "will create Project 'X' + Stage field
           [Ideas…Shipped] + labels [agent:go, needs-claude] under <owner>"
        3. on approval → createProject → createStageField (+options)
           → ensureLabels      (each via stagedGuard)
        4. writeBoardConfig(board.json)   ← NEW writer, persists IDs as it goes
        5. print browser-only step: "set board view → group by Stage"
        6. ledger.intent.boundBoard ← the new board ref
      → doctor now goes green
```

**Reuse:** `reshape()`'s lane-diff, `summary()`'s write-back pattern, the `stagedGuard()` preview-before-write gate, and the existing SessionStart hook plumbing.

**Hard constraint:** the board **view group-by is browser-only** (hard rule 5). `bootstrap` does everything via API *except* that, which stays a printed checklist item. Honestly labeled "almost-turnkey."

## 4. Components & interfaces

New code is **bold**; everything else is reuse. Each unit has one job, a small interface, and a clear dependency.

### New `lib/` modules (pure-ish, fs/cli only — unit-testable like `state.mjs`)

| Unit | What it does | Interface | Depends on |
|---|---|---|---|
| **`lib/ledger.mjs`** | Tier-0 intent ledger (mirrors `state.mjs`) | `ensureLedger(dir)` (idempotent create→return) · `readLedger(dir)` · `appendCandidate(dir, item)` · `setIntent(dir, partial)` | `node:fs` only — **no network** |
| **`lib/repo-detect.mjs`** | Resolve current repo from the git remote | `detectRepo()` → `{owner, repo, ownerType}`; **Refusal** if no remote | `gh repo view --json owner,name` |
| **`lib/config-writer.mjs`** | Persist `board.json` (loader is read-only today) | `writeBoardConfig(path, cfg)` — validate required keys, then write | `node:fs`; round-trips with `loadConfig` |

### New engine ops in `board.mjs` (each behind `stagedGuard()`)

| Unit | What it does | Interface |
|---|---|---|
| **`getOwnerId(login, ownerType)`** | Resolve owner login → node id | → `ownerId` |
| **`createProject(ownerId, title)`** | `createProjectV2` mutation | → `{projectId, projectNumber, url}` |
| **`createStageField(projectId, lanes[])`** | One `createProjectV2Field` (SINGLE_SELECT) with all lane options inline | → `{stageFieldId, options:[{label,optionId}]}` |
| **`ensureLabels(repo, labels[])`** | `gh label create`, idempotent (ignore "exists") | → created/existing labels |

> M1 creates a **fresh** Stage field with its options in one mutation (the clean, well-supported API path). Adding options to an *existing* field is the gnarlier `reshape`-apply path and is a noted follow-on, not M1.

### New verbs in `board-manager.mjs`

| Verb | What it does | Flow |
|---|---|---|
| **`bootstrap`** | Tier-1 orchestrator | `detectRepo` → resolve preset (default `build`) → **STAGED preview of the whole plan** → on approval: `createProject` → `createStageField` → `ensureLabels` → `writeBoardConfig` → `setIntent(boundBoard)` → print view-checklist + report-back |
| **`ledger`** | Inspect/append candidates | `ledger` (show) · `ledger add "<item>"` (append) |

### Changed

| Unit | Change |
|---|---|
| `hooks/SessionStart/load-board.mjs` | Call `ensureLedger(dir)` **first** (Tier 0, always), then keep existing load-board-if-configured behavior; inject a one-line note ("ledger ready · N candidates · board: bound/unbound") |

**Boundary check:** `bootstrap` is understandable without reading the mutations' internals; `detectRepo` can change without touching `bootstrap`; the ledger never touches the network, so Tier 0 cannot fail on a bad token. Each op is independently testable against the existing engine mock.

## 5. Data shapes

### `.github-boards/ledger.json` (gitignored working state)

```jsonc
{
  "ledgerVersion": 1,
  "createdAt": "<iso>",
  "intent": {
    "wantsBoard": null,            // null=undecided → true/false once known
    "boundBoard": null,            // null until bootstrap binds → {projectNumber, projectUrl}
    "pushPolicy": "on-approval",   // "on-approval"(default) | "manual" | "auto-low-risk"
    "pullCadence": "session-start" // "session-start"(default) | "off" | "watch:<sec>"
  },
  "candidates": [
    { "id": "<content-hash>",                 // hash → re-appending the same item dedups
      "title": "...", "note": "...",
      "source": "superpowers:brainstorming",  // provenance
      "suggestedLane": null, "suggestedOwner": null,  // null in M1 — the mapper (M2) fills these
      "addedAt": "<iso>", "status": "candidate" }     // candidate | promoted | dismissed
  ]
}
```

In M1, candidates carry **no** intelligent lane/owner (that is M2's mapper job). `id` is a content hash so re-appending the same item dedups — this seeds the idempotency story M2/M3 rely on.

### `board.json` additions

Existing schema unchanged; three new **optional** fields (old configs still load):

```jsonc
{ /* …existing binding (owner, ownerType, projectNumber, projectId, repo,
       stageFieldId, stageOptions, preset, routing)… */
  "projectUrl": "https://github.com/...",  // NEW — for report-back
  "pushPolicy": "on-approval",             // NEW — stored now, enforced by M3
  "pullCadence": "session-start"           // NEW — stored now, enforced by M4
}
```

The policy fields are **stored** in M1 but not yet acted on. The loader must **not** fail-closed on their absence (back-compat).

## 6. Error handling (fail-closed, per the engine's invariants)

- **No git remote** → `detectRepo` raises a Refusal with the fix (`bootstrap --repo owner/name`). Tier-0 ledger still works regardless (no network).
- **Staged-first (Invariant 4):** `bootstrap` always previews the full plan (project title · lanes · labels · owner) and writes nothing until explicit approval.
- **Partial-provision resumability** (project created, field fails): **write-as-you-go** (persist each ID into `board.json` immediately after each successful mutation) + **pre-create existence check** (adopt an existing same-title project instead of duplicating). Net: `bootstrap` is **idempotent and safe to re-run**.
- **Idempotent labels:** `ensureLabels` ignores "already exists."
- **Browser-only view step** is never claimed done — printed as a checklist item; `bootstrap` ends by suggesting `doctor` to confirm green.

## 7. Testing

M1's slice of the eventual M6 verification harness.

1. **Deterministic unit** (extend the existing 115-test mock-engine suite):
   - `ledger`: ensure/read/append/`setIntent`; **dedup by content-hash**; idempotent `ensureLedger`.
   - `config-writer`: writes a `board.json` that `loadConfig` round-trips; rejects invalid input.
   - `repo-detect`: parses owner/repo/ownerType; **Refusal** on no remote (mock the `gh` call).
   - `bootstrap` (against the mock engine): staged preview lists the full plan and **writes nothing**; commit path calls ops in order; **resumes from a partial `board.json`**; **adopts** an existing same-title project.
   - SessionStart hook: `ensureLedger` runs even with no `board.json`.
2. **Live integration smoke** (gated on `gh` auth, on-demand): `bootstrap` a throwaway board → assert Project/field/lanes/labels via the read path → `doctor` green → **teardown**. Seeds M6's live layer.
3. **Simulation:** none in M1 (no LLM mapper yet). The **content-hash dedup** is what M2's idempotency simulations will hammer, so it is tested hard now.

## 8. The larger decomposition (backlog — context for M1)

M1 is the first of six modules. Recorded so the foundation's forward-compatibility is deliberate, not accidental.

| Module | What it is | Absorbs |
|---|---|---|
| **M1 · Foundation** *(this spec)* | Provisioning + intent ledger + board-intent contract | C1, I3, I6 |
| **M2 · The Brain** | Smart-model mapper agent; board-shape ruleset; inter-skill ambiguity dialogue | I1, I2, I5, I7 |
| **M3 · Real-time import** | Feed sources to the mapper; build the board live while brainstorming; approval-gated promotion; boundary sync | C2, C3, I8, I9 |
| **M4 · Board→skill + time-travel** | External-change detection (local-poll → Channels later); linked-doc pull/act/record; versioned snapshots / rewind | C4, I10 |
| **M5 · Skill layer** | SKILL.md, triggering-description tuning, evals (skill-creator's job) | C5 |
| **M6 · Verification & simulation** | Unit + simulation (N-run variance, idempotency) + live integration | (testing) + I4 |

**Idea ledger (source of the module mapping):**
- **C1–C5** from the feasibility study: self-bootstrap; import other skills' work; skill→board sync; board→skill sync; skill-creator's role.
- **I1** agent-based mapper · **I2** smartest model for the mapper · **I3** board-intent contract · **I4** design/verify adversarially · **I5** inter-skill ambiguity dialogue · **I6** bootstrap-on-invoke always drops a ledger · **I7** solid board-shape rules · **I8** setup process that asks, doesn't act · **I9** build the board in real time while brainstorming · **I10** skill-built board time-travel.

## 9. Open questions carried to later modules (not M1 blockers)

- **M2:** GSD card granularity (plan vs phase); how the LLM mapper guarantees idempotent card identity; the exact board-shape ruleset (lane count, lanes-vs-tags, card-vs-comment).
- **M3:** trigger mechanism (PostToolUse on TodoWrite vs poll vs reconcile-at-Stop); auto-write HITL threshold ("low-risk" moves).
- **M4:** local-first polling vs Channels true-push this cycle; linked-document policy (which doc types, what "act" means, record format); when to invest in ADR-028 PAT/App identity.
