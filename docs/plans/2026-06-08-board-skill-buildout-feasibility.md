# Buildout Feasibility — From single-board CRUD to a bidirectional work-mirroring board layer

Date: 2026-06-08
Status: Feasibility study (pre-brainstorm). No build authorized yet.
Scope: Evaluate five target capabilities (C1–C5) against the verified v0.1 codebase, the GSD/superpowers work models, the Claude Code hook/Channels reality as of June 2026, and skill-creator's actual scope.

---

## 1. Vision (one paragraph)

Today the github-boards skill is a **single-board CRUD driver**: a well-tested engine ([scripts/board.mjs](scripts/board.mjs)) that reads, creates, and moves cards on one already-provisioned GitHub Projects v2 board, fronted by a verb layer ([scripts/board-manager.mjs](scripts/board-manager.mjs)) and wired as a plugin with three turn-boundary hooks. The vision is to grow it into an **orchestration + bidirectional sync layer**: a board that **provisions itself from nothing** (C1), **imports the work other skills are already producing** — GSD phases/plans and superpowers tasks/TodoWrite — and mirrors them as cards (C2), **pushes work changes onto the board as a session progresses** (C3), and — to the realistic limit of the platform — **detects board changes made by a human or a teammate and signals the active skill, pulling and acting on any linked document and keeping a record** (C4). C5 is the meta-question: skill-creator builds the *skill layer* (SKILL.md, triggering, evals); ordinary TDD against the existing 115-test suite builds the *engine/adapter/hook layer*. The reusable spine for all of this is real and already shipped (staged dry-run guard, fail-closed config, the pure diff engine, the DI verb seam, the composability contract); what is missing is mostly **new provisioning mutations, an external-artifact importer, mid-session trigger plumbing, and a board→skill signaling channel.**

---

## 2. Per-capability assessment (C1–C5)

> Effort key: **S** = days / one focused TDD chunk · **M** = ~1–2 weeks / several chunks · **L** = multi-week / new subsystem with its own invariants.

### C1 — SELF-BOOTSTRAP

| Field | Assessment |
|---|---|
| **Current state** | Essentially **absent**. Every write op assumes the Project, Stage field, lane options, and routing labels already exist. `loadConfig` **fail-closes** if `projectId`/`stageFieldId`/`stageOptions` are missing — so bootstrap cannot even start from a blank config ([scripts/board.mjs:52-82](scripts/board.mjs)). `reshape()` is read-only by design: it computes missing/extra lanes and emits a human checklist, returning `applied:false` unconditionally ([scripts/board-manager.mjs:325-357](scripts/board-manager.mjs)). |
| **Reuse** | The only implemented mutations: `addProjectV2ItemById` ([board.mjs:371](scripts/board.mjs)), `updateProjectV2ItemFieldValue` ([board.mjs:483](scripts/board.mjs)), `gh issue create` ([board.mjs:345](scripts/board.mjs)). `reshape()` already computes the **exact missing-lane diff** the bootstrapper must act on. `summary()` already proves the **write-back-to-disk** pattern via `writeState`/`writeFile` ([board-manager.mjs:416-423](scripts/board-manager.mjs)) — reuse it to persist created IDs. The staged guard ([board.mjs:118-123](scripts/board.mjs)) and fail-closed `loadConfig` give the right HITL + safety frame. SPEC already maps `reshape` to `createProjectV2Field` ([docs/SPEC-BOARD-MANAGER.md:39](docs/SPEC-BOARD-MANAGER.md)). |
| **Missing** | (a) Four new mutations: `createProjectV2` (project), `createProjectV2Field` (Stage single-select), `createProjectV2SingleSelectOption` (lanes), `gh label create` (`agent:go` / `needs-claude`). Grep confirmed **zero** implementation hits for any of these. (b) A **board.json writer** — `config.mjs`/`board.mjs` only read+validate; bootstrap must persist created `projectId`/`stageFieldId`/`stageOptions` back. (c) A new `bootstrap`/`init` verb that orchestrates create → write-back, honoring the staged→approve gate. |
| **Mechanism** | New `bootstrap`/`init` verb: run create mutations behind `stagedGuard()`, then write discovered/created IDs into board.json. Turn `reshape()`'s checklist-only path into an optional **apply** path (the half the SPEC always intended but never built). |
| **Effort** | **M** — four bounded GraphQL/gh mutations + a config writer + one verb, all TDD-able against the existing engine mock. Low *risk* (each mutation is small and independently testable), which is why it should go first. |
| **HARD CONSTRAINT** | The **board view group-by is browser-only** and stays a printed human step. SKILL.md hard rule 5: "Never attempt board view configuration. Layout / group-by is browser-only" ([skills/github-boards/SKILL.md:43](skills/github-boards/SKILL.md)); `reshape()` always appends "Set the board view to group by `Stage`." ([board-manager.mjs:346](scripts/board-manager.mjs)); SPEC Invariant 8 codifies `capabilities().viewConfig===false`. So C1 can create project + field + options + labels via API, but the **final view group-by remains a manual checklist item** — bootstrap is "almost-turnkey," not fully turnkey. |

### C2 — IMPORT OTHER SKILLS' WORK

| Field | Assessment |
|---|---|
| **Current state** | A **designed landing pad exists, but no importer.** `put(tasks[])` accepts `{title, body?, lane?, owner?}` arrays and runs create→add→stage→label per task ([board-manager.mjs:126-183](scripts/board-manager.mjs)); COMPOSABILITY.md documents the hand-off shape. But there is **no code** that discovers/parses `.planning/`, ROADMAP.md, PLAN.md, phases, or TodoWrite output — grep matched only doc prose, never logic. Import is entirely manual: a human or another skill must hand-construct the tasks array. |
| **Reuse** | `put()` + the COMPOSABILITY contract ([docs/COMPOSABILITY.md:24-39](docs/COMPOSABILITY.md)) are the integration target. `listItems`/`getIssue` ([board.mjs:219-322](scripts/board.mjs)) are the read primitives to diff existing cards against. **On the GSD side**, a real structured CLI exists — shell out to it, do not parse Markdown: `roadmap analyze`, `state json`, `verify phase-completeness`, `frontmatter get` (C:\Users\somed\.claude\get-shit-done\bin\gsd-tools.cjs). `cmdRoadmapAnalyze` computes `disk_status` deterministically from PLAN/SUMMARY **file counts** (roadmap.cjs ~248-281). The normalized lifecycle enum `discussing→planning→executing→verifying→completed (+paused)` lives in `normalizeStateStatus()` (state-document.generated.cjs ~65-90). `autonomous: true\|false` in PLAN.md frontmatter is a direct agent/human routing signal. **On the superpowers side**, TodoWrite is a closed JSON enum (`pending\|in_progress\|completed`) — the reliable live driver; the plan markdown (`### Task N`, `- [ ]` steps) seeds card identity/title/acceptance-criteria. |
| **Missing** | (a) A **GSD adapter** (shell to gsd-tools.cjs; map phase/plan → card, `disk_status`/state enum → lane, `autonomous` → routing label) and a **superpowers adapter** (TodoWrite JSON → lane; plan markdown → card identity). (b) An **idempotent external-id mirror**: `put()` always calls `createIssue` then `addIssueToBoard` ([board-manager.mjs:157-161](scripts/board-manager.mjs)), so re-importing the same plan **duplicates issues** — `addIssueToBoard` is upsert-idempotent at the item level but issue *creation* is not. Need a stable-key dedup (source plan/phase id stored in issue body or a state.json map) and a `reconcile` that updates existing cards. COMPOSABILITY rule 3 currently pushes dedup onto the caller. |
| **Mechanism** | Two artifact adapters → `put()`-shaped tasks. A `reconcile` step keyed on a stable external id that diffs against `listItems`/`getIssue` and updates instead of re-filing. |
| **Effort** | **L** — two distinct adapters + an idempotency/reconciliation layer with its own invariants. |
| **HARD CONSTRAINT (REFUTED-as-absolute)** | The claim that these artifacts are machine-readable enough to auto-generate cards **"without brittle prose parsing" is REFUTED as an absolute** (adversarial verdict: *partially-true*). It holds on the **happy path** (newest-GSD projects via gsd-tools.cjs + frontmatter; superpowers driven by TodoWrite's JSON enum). It **fails across all versions**: (a) older GSD STATE.md has **no frontmatter** and needs GSD's own regex fallback `stateExtractField()` (state-document.generated.cjs ~29-38) — version skew is the single biggest reliability risk; (b) GSD PLAN task *bodies* are regex-parsed XML-style markup (`<task>/<action>/<done>` via verify.cjs ~128-148) — a *second* in-version format; (c) superpowers plans have **no schema at all** — parsed by convention only, "workable but lossy." Also note: gsd-tools.cjs is marked **@deprecated** in favor of a `gsd-sdk query` surface (a cjs-sdk-bridge.cjs exists) — confirm the live entry point before wiring. **Plan accordingly:** drive lanes from gsd-tools.cjs/TodoWrite; treat frontmatter as truth; accept a *well-tested* brittle markdown fallback rather than pretend it is unnecessary. |

### C3 — SKILL→BOARD LIVE SYNC

| Field | Assessment |
|---|---|
| **Current state** | All write verbs exist; **nothing triggers them mid-session.** `put`/`move`/`route`/`reject`/`followup` exist ([board-manager.mjs:126-315](scripts/board-manager.mjs)) and `/board` exposes them, but `hooks.json` wires only SessionStart, PreToolUse(Bash), and Stop ([hooks/hooks.json:1-40](hooks/hooks.json)). Grep for `PostToolUse`/`UserPromptSubmit` returned no matches. Sync is operator-driven. |
| **Reuse** | The write verbs themselves. The PreToolUse allow-hook (`allow-board-script.mjs`) already removes the permission-prompt blocker, enabling unattended runs. The staged→approve gate keeps auto-writes HITL-safe. |
| **Missing** | A **PostToolUse hook** (matcher `TodoWrite` and/or `Bash`/`Edit`/`Write`) — or a skill-internal observer — that detects a work-state change during a turn and calls the appropriate verb automatically. |
| **Mechanism** | Add a PostToolUse hook that, on a TodoWrite/plan-file change, diffs against last-seen and calls `move`/`put`/`followup`, honoring the staged gate. |
| **Effort** | **M** — one new hook + a change-detection mapping; the verbs and the allow-hook already exist. |
| **HARD CONSTRAINT (PARTIALLY-TRUE)** | "Automatic mid-session sync" must be qualified (adversarial verdict). Hooks fire **only at event boundaries** (PostToolUse = after a tool completes), **not continuously**. Injected results are read by Claude on its **next model request**, not mid-turn ([load-board.mjs](hooks/SessionStart/) comment: context is read "on the next model request"). And hooks **cannot trigger new tool calls** — they can only inject `additionalContext`/`permissionDecision`/`updatedInput`; the model must choose to act on the next turn. So C3 is "sync at tool-completion boundaries," not "continuous live sync." This is the realistic ceiling and it is genuinely useful. |

### C4 — BOARD→SKILL LIVE SYNC

| Field | Assessment |
|---|---|
| **Current state** | **Strongest foundation, weakest delivery.** `diffItems(prev,next)` is **pure** and emits created/removed/moved/relabeled/state-changed/retitled events keyed on stable `itemId` — explicitly catching lane moves that Actions/notifications miss ([board.mjs:667-695](scripts/board.mjs)). `runWatch()` polls every interval (default 15s) with `--once` for CI ([board.mjs:704-724](scripts/board.mjs)). `state.mjs` persists last-seen to `.github-boards/state.json` with a pure `diff()` (state.mjs:25-87), consumed by `summary()` for "Since last time: N moved…". **But:** watch is wired to **no hook and no command** (exported at [board.mjs:855](scripts/board.mjs), invoked only inside board.mjs + tests). SessionStart injects a one-time summary; Stop nudges if state.json changed within 5 min. Board changes mid-session are detected only at the **next session start**, not pushed into the active session. |
| **Reuse** | `diffItems`, `runWatch`, `state.mjs` diff/persist, `summary()`. `getIssue()` ([board.mjs:296-322](scripts/board.mjs)) can fetch body+comments. `comment()` ([board.mjs:417-454](scripts/board.mjs)) carries identity-awareness (`enforced:false`) for the eventual re-trigger loop and is the natural "keep a record" primitive. |
| **Missing** | (a) A **launch path for watch** (background process or scheduled poll) plus a **channel** to signal the active skill mid-session — current SessionStart injection is one-shot only. (b) The entire **linked-document pull/act/record loop**: `diffItems` sees only structural fields and explicitly excludes body/comment edits ([board.mjs:660-666](scripts/board.mjs)); nothing parses an issue body for a linked-doc URL, fetches it, acts, or records. Grep for `linkedDoc`/`readLinked`/`extractLink` returned no matches. |
| **Mechanism** | See HARD CONSTRAINT — two paths. Local-first: poll at hook boundaries (SessionStart/Stop, or a background `/bg` loop writing `.github-boards/external-change.json` that the next hook boundary reads). True push: Claude Code **Channels**. Then, on a relevant change event, `getIssue` → parse body for linked-doc URL → fetch/read → act → `comment()` to record. |
| **Effort** | **L** — the watch-launch + signaling channel + the linked-doc loop are three new surfaces, and the true-push path depends on Channels + deferred identity work. |
| **HARD CONSTRAINT (the research was OUTDATED; corrected here)** | The research section "Investigation of live-sync capabilities" concluded real-time external push is **NOT possible today** — that was **accurate when written but is now FALSE as of June 2026** (adversarial verdict: *partially-true*). **Claude Code Channels** (released v2.1.80, 2026-03-20) provide true push of external webhook events — including GitHub Projects v2 — into a running session via an MCP server declaring `claude/channel` capability. **Critical qualifications:** (1) events arrive **only while the session is open** — changes while Claude is off are missed; (2) Channels are **research preview**, protocol may change; (3) the github-boards skill **does not implement Channels** — ROADMAP defers push to post-v1 ([ROADMAP.md:46-49](ROADMAP.md)); (4) webhook routing needs **external infra** (Hookdeck CLI or similar) to tunnel to a local channel server; (5) a true *teammate-driven* re-trigger still needs the deferred **PAT/App identity** (ADR-028; default `GITHUB_TOKEN` cannot touch Projects v2 — [ROADMAP.md:49](ROADMAP.md)), since `comment()` identity is `enforced:false` in 0.1. So: real-time C4 is **now technically reachable** via Channels, but is **net-new infrastructure**, preview-grade, and gated on the deferred identity work — not a quick win. The local-first polling path remains the safe default for the next increment. |

### C5 — TOOLING (skill-creator's role)

| Field | Assessment |
|---|---|
| **Current state** | skill-creator is available and supports **both** creating and improving skills. github-boards is a mature plugin with a SKILL.md, a /board command, and 115 tests. |
| **Reuse** | skill-creator's improvement loop (SKILL.md:292-323), **description optimization** for triggering accuracy (run_loop.py/run_eval.py/improve_description.py, 20-query should/should-not eval set), the evals→benchmark pipeline (evals.json/grading.json/benchmark.json, mean±stddev), the analyzer that flags non-discriminating/flaky assertions, and `package_skill.py`. Directly addresses the auto-invoke need (the desire for "a little bit pushy" descriptions). |
| **Missing** | Nothing in skill-creator — by design. |
| **Mechanism** | Use skill-creator for the SKILL.md/triggering/eval layer; use ordinary TDD for the engine. |
| **Effort** | **S** per iteration (skill-layer only). |
| **HARD CONSTRAINT (REFUTED)** | The claim that skill-creator can **implement the engineering** (gh/GraphQL bootstrap, cross-skill adapters, hook wiring) is **REFUTED** (adversarial verdict: *refuted*). A case-insensitive grep of the entire skill-creator directory for `graphql\|gh CLI\|hook\|PostToolUse\|adapter\|bootstrap\|engine\|.mjs` returned **zero** matches; all 9 scripts are eval/triggering/packaging tooling. skill-creator owns the **skill layer only**; the engine/adapter/hook runtime is ordinary engineering by the general agent (Bash/Edit/Write) under TDD. At most it can scaffold/validate the SKILL.md contract around new verbs/hooks and capture an *already-written* repeated helper as a bundled asset. See §4 for the explicit split. |

---

## 3. Recommended phased roadmap

Each phase is a shippable increment. The project's own **0.2 webhook/always-on deferral** ([ROADMAP.md:46-49](ROADMAP.md)) is respected: nothing here requires the server-side button, the always-on daemon, or Channels until Phase 5, which is explicitly optional/preview. **C1 goes first** — it is low-risk, fully API-reachable (minus the browser-only view step), and it unblocks every other capability because importers and sync have nothing to write to until a board provisions itself.

### Phase 0 — Live integration baseline (finish the known-pending work)
Close the project's own Phase 6 (docs/plans/2026-06-07-board-skill-build.md): integration tests + `doctor` green on a fresh machine. No new capability; establishes a trustworthy floor. **Effort: S–M.**

### Phase 1 — C1 SELF-BOOTSTRAP (unblocks everything)
Add `createProjectV2` / `createProjectV2Field` / `createProjectV2SingleSelectOption` / `gh label create` behind `stagedGuard()`; add a board.json **writer**; add a `bootstrap`/`init` verb (create → write-back). Convert `reshape()`'s checklist into an optional **apply** path. Leave the view group-by as a printed human step (hard constraint). **Effort: M. Risk: low.**

### Phase 2 — C2 IMPORT (one suite first, then the second)
Build the **GSD adapter** first (it has the real structured CLI — shell to gsd-tools.cjs / `gsd-sdk query`; map phase/plan→card, `disk_status`/state enum→lane, `autonomous`→routing label). Add the **idempotent external-id mirror** + `reconcile` *in this phase* (dedup is not optional — re-import duplicates issues). Then add the **superpowers adapter** (TodoWrite JSON→lane, plan markdown→card identity, with the well-tested brittle fallback). **Effort: L.** Honestly flag the version-skew/no-schema fallback as required, not avoidable.

### Phase 3 — C3 SKILL→BOARD sync at boundaries
Add a **PostToolUse hook** (TodoWrite + plan-file matchers) that diffs against last-seen and calls `move`/`put`/`followup` behind the staged gate. Ship it as "sync at tool-completion boundaries," with the model acting on injected context next turn — not "continuous." **Effort: M.**

### Phase 4 — C4 BOARD→SKILL, local-first (no new infra)
Wire `runWatch`/`diffItems` to a launch path: a `/bg` background poll writing `.github-boards/external-change.json`, read at the next SessionStart/Stop boundary and injected as `additionalContext`. Add the **linked-document loop**: on a relevant event, `getIssue`→parse body for a doc URL→fetch/read→act→`comment()` to record. This delivers most of C4's *intent* with zero deferred infra. **Effort: L.**

### Phase 5 — C4 true push (OPTIONAL, preview-grade, respects 0.2 deferral)
Only if warranted: implement **Channels** (MCP server declaring `claude/channel`) + the webhook tunnel (Hookdeck or similar) + the deferred **PAT/App identity** (ADR-028) so teammate-driven changes can re-fire automation. Gated behind the project's own post-v1 deferral and Channels' research-preview status. **Effort: L+ / unbounded.** Do not promise this as part of the core buildout.

### Throughout — C5 skill-layer (parallel, per increment)
After each phase that changes triggering surface, run skill-creator's description optimization + evals (see §4).

---

## 4. The skill-creator answer (explicit split)

skill-creator and ordinary engineering own **non-overlapping** layers. This split is verified, not aspirational (adversarial verdict on C5: skill-creator-implements-engineering is *refuted*).

**Skill layer — skill-creator owns this:**
- Authoring/editing **SKILL.md** prose and structure (progressive disclosure, "lack of surprise," imperative voice).
- The frontmatter **triggering description** — tuned for auto-invoke accuracy via the 20-query should/should-not eval set and the description-optimization loop (run_loop.py / run_eval.py / improve_description.py). This is the concrete tool for the "make descriptions a little pushy" goal and for new triggers like "use when GSD phases produce board-able work."
- **Evals + benchmarking**: evals.json cases, with-skill vs baseline runs, grading assertions, mean±stddev benchmarks, and the analyzer pass that flags non-discriminating or flaky assertions (e.g., board-state-dependent flakiness).
- Capturing an **already-written** repeated helper script as a bundled `scripts/` asset, and **packaging** via package_skill.py.

**Engineering layer — ordinary TDD against the 115-test suite owns this (NOT skill-creator):**
- C1 GraphQL/gh **bootstrap mutations** (`createProjectV2*`, `createLabel`) and the board.json writer.
- C2 **cross-skill adapters** (GSD CLI shell-out + superpowers TodoWrite/markdown parsing) and the idempotent-mirror/reconcile layer.
- C3/C4 **hook wiring** (PostToolUse, watch launch) and the linked-document pull/act/record loop.
- C4 Phase 5 **Channels MCP server**, webhook tunnel, and PAT/App identity.

**Operating loop:** for each phase — engineer the runtime under TDD (red→green→commit); then hand the changed triggering surface to skill-creator to re-optimize the description and re-run evals; iterate until quality gates pass. Constraints to remember: description optimization needs `claude -p` (works in Claude Code/Cowork, not Claude.ai), and blind comparison/analyzer need subagents.

---

## 5. Open questions / decisions for the brainstorming session (before any build)

1. **C1 scope of "from nothing":** Does bootstrap also create the **repo** (capabilities lists `createRepo`) or assume an existing repo? Org vs user project (`ownerType` affects the create mutation)?
2. **C1 view group-by:** Confirm we accept the browser-only manual step as a permanent part of "bootstrap complete," and how the checklist is surfaced (Stop nudge? README?).
3. **C2 work-unit granularity:** GSD **plan** (NN-YY) as the card vs **phase** (NN) as a coarse epic card — or both, with phases as a label/iteration? How are GSD's 5–6 lifecycle states reconciled against the 7-lane build board (Ideas/Researching/Spiking/Review/Building/Shipped/Rejected)? (Note: the GCA #23 lane vocab was read from STATE.md prose, **not** verified against the live board — confirm via gh/GraphQL first.)
4. **C2 stable-key strategy:** Where does the external id live — issue body marker, or a map in state.json? This decides how `reconcile` matches and how robust dedup is to title edits.
5. **C2 GSD entry point:** gsd-tools.cjs is **@deprecated** in favor of `gsd-sdk query` (cjs-sdk-bridge.cjs). Which surface do we bind to, and how do we defend against version skew (frontmatter vs prose STATE.md, must_haves YAML vs `<task>` markup)?
6. **C2 superpowers reconciliation:** TodoWrite items have **no stable IDs** across replacements (list resent each call). Key cards on content hash or plan Task number? How do we avoid duplicate cards as the list mutates?
7. **C2/C3 trigger mechanism:** PostToolUse hook on TodoWrite vs poll vs reconcile-at-Stop — which is preferred, given each has different latency and the "next model request" delay?
8. **C2 placeholder plans:** GCA uses decimal/alpha phase ids and many "TBD/OPEN" plans — confirm the generator **skips** non-actionable entries rather than filing empty cards. Where do spikes/sketches map (likely the Spiking lane)?
9. **C3 auto-write HITL:** When a hook auto-detects a change, does it stage-and-wait (preserving the approve gate) or auto-commit for low-risk moves? What is "low-risk"?
10. **C4 path choice:** Local-first polling (Phase 4) vs Channels true-push (Phase 5) — do we want push at all in this cycle, given it is research-preview, needs external tunneling infra, and is gated on the deferred PAT/App identity?
11. **C4 linked-document policy:** Which doc types do we follow (markdown URLs only? Drive? arbitrary?), what "act" means per doc, and what the record format is (a `comment()` back to the issue?).
12. **C4 identity:** When do we invest in ADR-028 PAT/App identity? Teammate-driven re-trigger is impossible without it, and `comment()` is `enforced:false` today.

---

## Honest feasibility flags (what the verification refuted or qualified)

- **C2 "machine-readable without brittle parsing" — REFUTED as an absolute.** True on the happy path only; a well-tested brittle fallback is **required**, not avoidable (version skew + no-schema superpowers plans).
- **C3/C4 hook "automatic" sync — PARTIALLY TRUE.** Boundary-driven, not continuous; injected context is read on the **next model request**; hooks **cannot trigger tool calls**.
- **C4 real-time external push — the original research is OUTDATED.** It is **now possible** via Channels (v2.1.80, 2026-03-20), but unimplemented here, research-preview, infra-dependent, session-only, and gated on deferred identity work. Do **not** overclaim it as a near-term deliverable.
- **C5 skill-creator implementing engineering — REFUTED.** skill-creator owns the skill/eval layer only; the engine/adapters/hooks are ordinary TDD.
