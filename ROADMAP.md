# Roadmap & Direction — GitHub Boards Skill

This file records **why this repo exists, what's in v1, and what's planned** — so the direction survives across sessions and contributors.

## Direction change (2026-06-07)

This skill began life inside the larger **GCA / Giga Chad Agile** project (a selectively-activated set of Claude Code skills for running agile work on GitHub). We deliberately **scaled back and extracted** the most useful, universal piece — the conversational board driver — into **this standalone, publishable, MIT repo**.

**What changed and why:**
- **Standalone, not monorepo.** Instead of shipping inside the Deocracy/GCA product repo (GCA's ADR-012 repo-split), the board skill is its own installable thing. *Supersedes ADR-012 for this skill.* Simpler to publish, ship to other computers, and reason about.
- **Self-contained.** This repo bundles **both** the board engine (gh CLI + GraphQL plumbing, ported MIT from GCA's `board-connection`) **and** the conversational layer, so it installs and runs without GCA — which is what makes it callable by *any* other skill on *any* machine.
- **Agnostic-ready.** Built so a future MCP server makes it usable by non-Claude agents (Codex, Cursor, CI) with a thin flip, not a rewrite.

The full architecture decision (with the 5-front research that backs it) lives in [docs/SPEC-BOARD-MANAGER.md](docs/SPEC-BOARD-MANAGER.md).

## Locked design decisions

| Decision | Choice |
|---|---|
| Architecture | Thin conversational layer over a bundled board engine (both in this repo) |
| 🤖/🧍 routing signal | Reuse labels (`agent:go` / `needs-claude`) — no new schema |
| Board shape | **Config-driven lanes**, read from `board.json`; point at any board (build + grants presets) |
| Composability (v1) | The skill + `/board` command; verb set authored as the callable contract |
| Composability (later) | Optional **MCP server** wrapping the same verbs → agent-agnostic |
| Local-first automation (v1) | NL ask · `/board` command · SessionStart/Stop hooks · PreToolUse allow-hook |
| Packaging | Claude Code **plugin** distributed via a one-repo **marketplace** |
| HITL | Every write is **staged-previewed**, then approved, then committed |

## v1 — the publishable core

- [ ] `scripts/board.mjs` — the bundled engine (read / make / move, `staged()` preview, `doctor`, `capabilities`).
- [ ] `scripts/board-manager.mjs` — the callable verb contract: `put`, `queue`, `move`, `route`, `followup`, `reshape`, `summary`.
- [ ] `skills/github-boards/SKILL.md` — the canonical vendor-neutral instruction body (started).
- [ ] `commands/board.md` — the `/board` slash command.
- [ ] `hooks/` — SessionStart (load board + "what changed"), Stop (report-back), PreToolUse (pre-allow the script so it never hangs).
- [ ] `board.json` schema + `doctor`-assisted discovery of IDs.
- [ ] Tests (test-first) against a live dogfood board.
- [ ] README + wiki complete; first publish.

## New features to design & build (requested 2026-06-07)

1. **Last-seen memory / change detection.** `.github-boards/state.json` (git-ignored) stores the last-seen board digest (card → lane/labels/owner) + cursor + timestamp. On session start, diff live-vs-last-seen → *"Since last time: 3 moved, 2 new, 1 rejected."* Board stays source of truth; state file is a delete-safe marker. Generalizes the engine's `watch` poll-and-diff into persisted cross-session memory. **Decided (2026-06-07):** local `.github-boards/state.json` **plus an opt-in committed `last-sync.json`** for team hand-offs across machines (off by default).
2. **Composability protocol.** A documented, stable way for other skills to call this one and read the report-back — see [docs/COMPOSABILITY.md](docs/COMPOSABILITY.md).
3. **Wiki.** Friendly published docs synced from `docs/` (canonical). Pages scaffolded under `wiki/`.

## Deferred (not v1)

- **MCP server** + `AGENTS.md` + per-agent adapters (the agent-agnostic path).
- **Server-side "button"** (GitHub Action on issue-comment/label/`workflow_dispatch`) and **always-on** (Agent SDK / scheduled headless `claude -p`). These need a PAT/App-authored identity (GitHub's default `GITHUB_TOKEN` cannot touch Projects v2).
- **Multi-board coordination** (several boards at once). v1 points at one board at a time.

## Open items before first publish

- Final GitHub **org/repo slug** (`deocracy/github-boards-skill`?) — used in install commands, `plugin.json`, `marketplace.json`.
- Confirm the **memory** storage choice (local-only vs optional committed marker).
- Confirm the **grants/paperwork lane preset** shape with a real grant workflow.
- Decide whether `reshape` (agent sets the `Stage` options to match a preset) is in v1 or deferred.

## References

- Design spec: [docs/SPEC-BOARD-MANAGER.md](docs/SPEC-BOARD-MANAGER.md)
- Composability: [docs/COMPOSABILITY.md](docs/COMPOSABILITY.md)
- Architecture research (carried from GCA): the 5-front research + decision matrix.
