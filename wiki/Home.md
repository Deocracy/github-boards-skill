# GitHub Boards Skill — Wiki

Talk to your GitHub Projects (v2) Kanban board in plain language. Claude reads it, edits it (with your approval), routes 🤖 agent-work vs 🧍 human-work, and tells you what changed.

> These wiki pages are the friendly face of the project. The **canonical, versioned docs live in [`docs/`](../docs)** and are synced here. If they ever disagree, `docs/` wins.

## Start here

- **[Installation](Installation)** — prerequisites, install, and the one-time board setup.
- **[Configuration](Configuration)** — `board.json`, `doctor`, lane presets, `sources`, and `snapshots`.
- **[Usage](Usage)** — the things you can say, and what each does.
- **[Composability](Composability)** — how other skills call this one.
- **[Architecture](Architecture)** — how it's built (and why).
- **[Roadmap](Roadmap)** — what shipped in M1–M6 and what's next.

## In one breath

Two layers in one self-contained, MIT skill: a **board engine** (`gh` CLI + GraphQL, with a preview of every write) and a **conversational layer** (natural language, owner routing, "what's on my plate", report-back). Installs as a Claude Code plugin.

**Status: all six milestones shipped (M1–M6).** 423 tests — 419 passing, 4 operator-gated live skips. One operator live-E2E run remains before 1.0 — see [Roadmap](Roadmap).

## What it can do

- **Board operations** — `put`, `queue`, `move`, `route`, `reject`, `followup`, `reshape`, `summary`, `bootstrap`.
- **Ledger pipeline** — `sync scan/record` → `map prepare/record` → `promote plan/apply` — batch work from any source file through to real cards, dedup'd and resumable mid-batch.
- **Maintenance loops** — `reconcile scan/apply` heals drift between source files, the ledger, and the board (ledger-only writes; board mutations stay `promote`'s job).
- **Time-travel and undo** — `snapshot take/list/diff/log/invert` — pruned full-board save-points plus a never-pruned permanent event log; `snapshot invert` produces a mechanically-computed undo plan.
- **Hooks** — SessionStart injects a board digest (what changed since last look) and source-file change notes automatically; PostToolUse signals watched-file edits mid-session.
- **Drift gates** — deterministic `npm test` checks keep docs honest; the suite also includes a simulation world, seeded soak, and crash atlas.
