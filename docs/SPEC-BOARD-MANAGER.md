# SPEC — GitHub Boards Skill (standalone, self-contained)

**Status:** design (2026-06-07). **Runtime:** Claude Code (v1); agent-agnostic MCP path deferred.
**Origin:** extracted and adapted from the GCA project's `SPEC-BOARD-MANAGER` + 5-front architecture research (see [ROADMAP.md](../ROADMAP.md)).

---

## Decision

Ship **one self-contained, MIT, installable Claude Code skill** that reads and edits a GitHub Projects v2 board. It has two layers, both in this repo:

- **Engine** (`scripts/board.mjs`) — the low-level board adapter: `gh` CLI + GitHub GraphQL, exposing read (`resolveBoard`, `listItems`, `getIssue`, `getStageField`), make (`createIssue`, `addIssueToBoard`, `setLabels`, `comment`), move (`setStage`), plus `staged()` dry-run previews, `doctor`, and `capabilities()`. Ported MIT from GCA's hardened `board-connection`.
- **Conversational layer** (`scripts/board-manager.mjs` + `SKILL.md`) — natural-language UX, 🤖/🧍 owner routing, "what's on my plate" queues, the report-back loop, and the callable contract other skills use.

Bundling both is what makes the skill **installable anywhere and callable by any other skill** without a second dependency.

## Where it sits

```
  You / other skills ─► SKILL.md → board-manager.mjs ─► board.mjs (engine) ─► GitHub Projects v2 + Issues
                          NL + routing + queues          gh CLI + GraphQL,        (the board = source of truth)
                          + report-back                  staged() previews
```

- **Lanes are read from `board.json`** (config-as-data), never hardcoded. A `software` board and a `non-software`/grants board carry different columns with no code change.
- **The board is the source of truth.** Claude is stateless between sessions; a `SessionStart` hook re-hydrates board state, and a local `.github-boards/state.json` marks what was last seen (for "what changed").

## The contract (the verb set)

| Natural language | Verb | Engine composition |
|---|---|---|
| "Put this on the board" (1..n) | `put(tasks[])` | `createIssue` → `addIssueToBoard` → `setStage(initial)` → `setLabels(owner)` |
| "What's Claude working on?" | `queue(owner: agent)` | `listItems` + filter `agent:go` |
| "What do I need to do?" | `queue(owner: human)` | `listItems` + filter `needs-claude` |
| "Move card X to Review" | `move(card, lane)` | `setStage` |
| "This needs me" / "Hand to Claude" | `route(card, owner)` | `setLabels` (+ keep claimed + escalate on 🧍) |
| "Reject with learnings" | `move(card, reject)` | `setStage(Rejected…)` + `comment(learnings)` |
| "Claude found more work" | `followup(parent, child)` | `createIssue(sub-issue)` → board |
| "Set up / adjust lanes" | `reshape(preset)` | `createProjectV2Field` options + emit human UI checklist |
| "Show the board / what changed" | `summary(board)` | `listItems` + diff vs `.github-boards/state.json` |

**Report-back is part of every mutating verb** — after an approved write, state what changed and what's on each plate.

### Invariants

1. **Cards are real Issues** (never draft items).
2. **`Stage` is addressed by field ID, fail-closed** (never a guessed `Status` field).
3. **Lanes by the `Stage` single-select; owner by label** (`agent:go` / `needs-claude`) — not conflated.
4. **Every write is staged-previewable** and is previewed → approved → committed.
5. **Token + authoring identity are injected, never hardcoded** (auth via `gh`; never paste tokens).
6. **Owner ≠ author** — owner is *who should act*, distinct from who wrote the card.
7. **A 🧍 card stays claimed and escalates** (mention/assignment), never silently parked.
8. **Never attempt board view configuration** — `capabilities().viewConfig === false`; `reshape` emits a human checklist for the UI-only view step and fails loud if undone.
9. **Lanes are read from config**, never hardcoded.

## 🤖/🧍 routing

Marked by labels (`agent:go` / `needs-claude`); the two plates are two filtered views over one board (no bespoke UI). Optional preset-driven gate: a card becomes `agent:go` only when its issue-body acceptance-criteria checkboxes pass (off by default in v1).

## Config-driven lanes

**Presets are project-agnostic lane-shape templates** stored as data in `presets/` (e.g. `presets/build.json`, `presets/grants.json`); a board's `board.json` references one by name (`"preset": "grants"`) or defines lanes inline. New domain → new preset file (data, no code). `board.json`: `{ owner, ownerType, projectNumber, projectId, repo, stageFieldId, stageOptions{label→optionId}, preset, routing{agent,human} }`. Ship two example presets — **build** (Ideas→Researching→Building→Review→Shipped→Rejected) and **grants/paperwork** (`kind: non-software`: Intake→Drafting→Needs-info→Ready-to-submit→Submitted→Awaiting-decision→Awarded/Rejected). `doctor` binds preset lane names → live option IDs. `reshape` (in v1) applies the agent-doable part (set `Stage` options to match the preset) + prints the UI-only view checklist.

## Local-first loop (v1 = no server)

1. **NL ask** → verb → staged preview → approve → commit → report-back.
2. **`/board` slash command** — the in-session button.
3. **`SessionStart` hook** loads the board + "what changed since last time"; **`Stop` hook** re-emits next-actions.
4. **`PreToolUse` allow-hook** pre-allows exactly the bundled script so slash/unattended runs don't hang on permission prompts (also the kill-switch boundary).

## Governance / HITL

Every write previews → approves → commits (the HITL gate). Triage (set lane/label/owner) is low-risk; consequential acts (access, spend, external comms) require explicit human approval. Reject-with-learnings is a first-class `move(card, reject)` to a permanent lane with a recorded note.

## Memory (last-seen / change detection)

`.github-boards/state.json` (git-ignored): last-seen digest (card → lane/labels/owner) + cursor + timestamp. On session start / `summary`, diff live-vs-last-seen → report changes, then update. Delete-safe; the board is authoritative. Plus an **opt-in committed `last-sync.json`** for team hand-offs across machines (off by default, enabled per board).

## Agnosticism (deferred MCP path)

- Board rules live in one **vendor-neutral instruction body** (`SKILL.md`), mirror-able to `AGENTS.md` with no rewrite.
- All board ops go through the script (no board logic in Claude-only constructs); only "Claude runs the script" is Claude-specific.
- Board credential ≠ agent credential.
- **Deferred:** wrap the verb set as an **optional MCP server** so Codex/Cursor/CI can emit work — a thin flip because the verb set is the contract. *Build v1 to not preclude it; do not build it yet.*

## Components

```
github-boards-skill/
├── .claude-plugin/{plugin.json, marketplace.json}
├── skills/github-boards/SKILL.md      # canonical vendor-neutral instruction body
├── scripts/{board.mjs, board-manager.mjs}
├── commands/board.md                  # /board slash command
├── hooks/{SessionStart,Stop,PreToolUse}/…
├── board.json                         # binding + active preset (per user)
├── docs/{SPEC-BOARD-MANAGER.md, COMPOSABILITY.md}
├── wiki/…                             # friendly docs, synced from docs/
├── tests/…                            # test-first
└── README.md, ROADMAP.md, LICENSE, package.json, .gitignore
```

## Testing

Test-first. Unit: each verb against a mock engine — assert composed calls + staged-before-write ordering + label filtering + 🧍 escalation + `reshape` never touches view config. Integration: happy paths against a live dogfood board. Agnosticism guard: instruction body contains no Claude-only constructs.

## Out of scope (v1)

MCP server / `AGENTS.md` / per-agent adapters · the server-side "button" + always-on (Agent SDK / scheduled headless) · multi-board coordination.

## Rejected — with learnings

- **From-scratch inline `gh` rebuild** — rejected: re-creates draft-card and Stage/Status mis-write defects, no `doctor`/`staged` safety net. "Fewer files" ≠ simpler.
- **Depending on a separate engine skill** — rejected for the standalone: a caller would need two installs; self-contained makes it callable anywhere.
- **Dedicated Owner field (v1)** — deferred: labels already exist and are returned by `listItems`; reuse before adding schema.
- **MCP server in v1** — deferred: nothing gained while Claude Code is the only driver; build the verb set as the contract so the MCP is a later flip.

## Resolved (2026-06-07)

- Org/repo slug = `deocracy/github-boards-skill`.
- Memory = local `.github-boards/state.json` + opt-in committed `last-sync.json`.
- Lane formats = **project-agnostic presets** in `presets/`, referenced per board via `board.json`.
- `reshape` = **in v1** (data layer: sets `Stage` options to match a preset).
