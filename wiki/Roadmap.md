# Roadmap

Status: **pre-release / design-stage.** The design is locked; the executable script is being built. Canonical plan: [`ROADMAP.md`](../ROADMAP.md).

## v1 (the publishable core)

- The bundled engine (`board.mjs`) + verb layer (`board-manager.mjs`): `put`, `queue`, `move`, `route`, `followup`, `reshape`, `summary`.
- `SKILL.md` (started) · `/board` command · hooks (SessionStart / Stop / PreToolUse) · `board.json` + `doctor`.
- Tests (test-first) · complete README + wiki · first publish.

## New features in design

1. **Last-seen memory** — `.github-boards/state.json` so the skill can tell you *what changed* since last time (board stays the source of truth).
2. **Composability protocol** — a stable way for other skills to call this one ([Composability](Composability)).
3. **Wiki** — these pages, synced from `docs/`.

## Deferred (not v1)

- **MCP server** + `AGENTS.md` → agent-agnostic (Codex, Cursor, CI).
- **Server-side "button"** (GitHub Action) and **always-on** (Agent SDK / scheduled headless).
- **Multi-board coordination.**

## Before first publish

Final GitHub org/repo slug · memory storage choice (local-only vs committed marker) · grants lane preset shape · whether `reshape` is in v1.
