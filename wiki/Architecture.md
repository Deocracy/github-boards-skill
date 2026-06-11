# Architecture

Two layers, both in this one self-contained repo:

```
  You / other skills ─► SKILL.md → board-manager.mjs ─► board.mjs (engine) ─► GitHub Projects v2 + Issues
                          NL + routing + queues          gh CLI + GraphQL,        (the board = source of truth)
                          + report-back                  staged() previews
```

- **Engine** (`scripts/board.mjs`): read / make / move via `gh` + GraphQL, with a **preview of every write**, a `doctor` preflight, and a `capabilities()` probe. Carries the safety invariants.
- **Conversational layer** (`SKILL.md` + `scripts/board-manager.mjs`): natural language, 🤖/🧍 routing (labels), "what's on my plate" queues, and report-back.

## The ledger pipeline

Work flows through three stages before it ever touches the board:

```
sources (TODO.md, plans, other skills' artifacts)
  └─ sync scan / sync record ─► intent LEDGER ─► map prepare / map record ─► promote plan / promote apply ─► BOARD
                                                          maintenance loops:
                                                          reconcile scan/apply  (drift report → ledger-only healing)
                                                          snapshot …            (board memory + the permanent journal)
```

- **`sync`** — profile-driven discovery of TODOs and plan files; LLM-native extraction (no format parsers in code) records items into the ledger.
- **`map`** — the strongest-model mapper classifies candidates into card proposals (lane, owner, split/merge, ambiguity surfaced); records proposals back to the ledger. Never writes the board.
- **`promote`** — `promote plan` shows approval buckets; `promote apply` creates real Issues, adds them to the board, and stamps each with a `cid` marker so any mid-batch failure is resumable.

Direct verbs (`put`, `move`, `route`, …) act on the board immediately and bypass the pipeline.

## Maintenance loops

- **`reconcile scan/apply`** — classifies drift across source files, ledger, and board; **heals the ledger only** (board mutations always stay `promote`'s job).
- **`snapshot` family** — pruned full-board save-points stored in `.github-boards/snapshots/`, plus a **never-pruned** `log.jsonl` event journal. `snapshot invert` computes the mechanically-derived undo plan (`ops` = executable via `move`/`route`; `manual` = never auto-executed).

## Hooks

- **SessionStart** — when `board.json` is configured, injects a board digest (what changed since the last look) and notes for any watched source files that changed since the previous session.
- **PostToolUse** — signals mid-session the moment a watched source file is written; the cue to offer `sync scan`, not to run the pipeline silently.
- **PreToolUse** — pre-allows the script so the `board-manager.mjs` invocation never triggers an interactive permission prompt.

## Verification layer (M6)

The test suite includes a **simulation world** (multi-session lifecycle scenarios that exercise the full pipeline end-to-end without a live board), a **seeded soak** that checks invariants after random op sequences, and a **crash atlas** covering every multi-write gap. One operator-gated live-E2E run (`GBS_LIVE=1`) completes the picture — see [`docs/LIVE-RUNBOOK.md`](../docs/LIVE-RUNBOOK.md). Deterministic drift gates in `npm test` keep the docs honest: if a CLI verb is added or removed, a failing test tells you the docs are stale.

## Why it's built this way

- **Self-contained** so it installs anywhere and any skill can call it without a second dependency.
- **Lanes from config** so software and grants boards differ with no code change.
- **The board is the source of truth** — Claude is stateless between sessions; a `SessionStart` hook re-hydrates it and a local `.github-boards/state.json` tracks "what changed."
- **Vendor-neutral instruction body** so a future `AGENTS.md` / MCP server makes it agent-agnostic with a thin flip, not a rewrite.

The hard limits worth knowing: the board **view/layout is browser-only** (a one-time human step), and GitHub's default `GITHUB_TOKEN` **can't touch Projects v2** (so any future unattended loop needs a PAT/App token).

Full design + invariants + the research behind it: [`docs/SPEC-BOARD-MANAGER.md`](../docs/SPEC-BOARD-MANAGER.md).
