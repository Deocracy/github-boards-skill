# Architecture

Two layers, both in this one self-contained repo:

```
  You / other skills ─► SKILL.md → board-manager.mjs ─► board.mjs (engine) ─► GitHub Projects v2 + Issues
                          NL + routing + queues          gh CLI + GraphQL,        (the board = source of truth)
                          + report-back                  staged() previews
```

- **Engine** (`scripts/board.mjs`): read / make / move via `gh` + GraphQL, with a **preview of every write**, a `doctor` preflight, and a `capabilities()` probe. Carries the safety invariants.
- **Conversational layer** (`SKILL.md` + `scripts/board-manager.mjs`): natural language, 🤖/🧍 routing (labels), "what's on my plate" queues, and report-back.

## Why it's built this way

- **Self-contained** so it installs anywhere and any skill can call it without a second dependency.
- **Lanes from config** so software and grants boards differ with no code change.
- **The board is the source of truth** — Claude is stateless between sessions; a `SessionStart` hook re-hydrates it and a local `.github-boards/state.json` tracks "what changed."
- **Vendor-neutral instruction body** so a future `AGENTS.md` / MCP server makes it agent-agnostic with a thin flip, not a rewrite.

The hard limits worth knowing: the board **view/layout is browser-only** (a one-time human step), and GitHub's default `GITHUB_TOKEN` **can't touch Projects v2** (so any future unattended loop needs a PAT/App token).

Full design + invariants + the research behind it: [`docs/SPEC-BOARD-MANAGER.md`](../docs/SPEC-BOARD-MANAGER.md).
