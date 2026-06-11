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

- [x] `scripts/board.mjs` — the bundled engine (read / make / move, `staged()` preview, `doctor`, `capabilities`).
- [x] `scripts/board-manager.mjs` — the callable verb contract: `put`, `queue`, `move`, `route`, `followup`, `reshape`, `summary`, `ledger`, `map`, `promote`, `sync`, `reconcile`, `snapshot`.
- [x] `skills/github-boards/SKILL.md` — the canonical vendor-neutral instruction body (full pipeline + undo + hooks).
- [x] `commands/board.md` — the `/board` slash command.
- [x] `hooks/` — SessionStart (board digest + source-change notes), PostToolUse (real-time file-watch trigger), PreToolUse (pre-allow the script so it never hangs).
- [x] `board.json` schema + `doctor`-assisted discovery of IDs.
- [x] 423 tests (419 passing, 4 operator-gated live skips) — deterministic drift gates keep docs honest.
- [ ] Operator live-E2E run (`GBS_LIVE=1`) — see [docs/LIVE-RUNBOOK.md](docs/LIVE-RUNBOOK.md).
- [ ] First marketplace publish (`deocracy/github-boards-skill`).

## Shipped milestones (2026-06-08 → 2026-06-11)

| Milestone | Shipped | One-liner | Spec |
|---|---|---|---|
| M1 Foundation | 2026-06-08 | Intent ledger + `bootstrap` verb — provision a board from zero and start tracking candidates immediately | [spec](docs/superpowers/specs/2026-06-08-m1-foundation-design.md) |
| M2 Brain / Mapper | 2026-06-09 | Strongest-model mapper turns raw candidates into well-shaped card proposals (lane, owner, split/merge, ambiguity surfaced) — enriches the ledger, never writes the board | [spec](docs/superpowers/specs/2026-06-09-m2-brain-design.md) |
| M3a Promotion | 2026-06-09 | `promote plan` / `promote apply` — approval-gated, idempotent promotion of ledger candidates to real GitHub Issues; cid markers make every mid-batch failure resumable | [spec](docs/superpowers/specs/2026-06-09-m3a-promotion-design.md) |
| M3b Source Adapters | 2026-06-09 | `sync scan` / `sync record` — profile-driven discovery of TODOs and plan files from any skill; LLM-native extraction, no format parsers in code | [spec](docs/superpowers/specs/2026-06-09-m3b-sources-design.md) |
| M3c Real-Time Triggering | 2026-06-10 | PostToolUse hook surfaces watched-file changes to Claude mid-session the moment they're written — stateless signal, no queue | [spec](docs/superpowers/specs/2026-06-10-m3c-realtime-design.md) |
| M4a Reconcile | 2026-06-10 | `reconcile scan` / `reconcile apply` — classifies drift across source files, ledger, and board; heals the ledger only (board mutations stay `promote`'s job) | [spec](docs/superpowers/specs/2026-06-10-m4a-reconcile-design.md) |
| M4b Time-Travel | 2026-06-10 | `snapshot` family — pruned full-board save-points + a never-pruned event log; `snapshot invert` produces a mechanically-computed undo plan | [spec](docs/superpowers/specs/2026-06-10-m4b-timetravel-design.md) |
| M5 Skill Layer | 2026-06-11 | SKILL.md + AGENTS.md rewritten to the full pipeline; `references/undo-contract.md`; deterministic prose drift gates wired into `npm test` | [spec](docs/superpowers/specs/2026-06-11-m5-skill-layer-design.md) |
| M6 Verification | 2026-06-11 | Simulation world (multi-session lifecycle scenarios) + seeded soak + crash atlas covering every multi-write gap; one gated live-E2E + runbook | [spec](docs/superpowers/specs/2026-06-11-m6-verification-design.md) |

## New features to design & build (requested 2026-06-07)

1. **Last-seen memory / change detection.** Shipped as M1 (`state.json`) + M4b (snapshots + event log). **Decided (2026-06-07):** local `.github-boards/state.json` **plus an opt-in committed `last-sync.json`** for team hand-offs across machines (off by default).
2. **Composability protocol.** Shipped — see [docs/COMPOSABILITY.md](docs/COMPOSABILITY.md).
3. **Wiki.** Friendly published docs synced from `docs/` (canonical). Pages scaffolded under `wiki/` — deferred until post-publish.

## Next

- **Operator live-E2E run** (`GBS_LIVE=1`) — full bootstrap → promote → move → reconcile → snapshot/invert → teardown pass against a real board; see [docs/LIVE-RUNBOOK.md](docs/LIVE-RUNBOOK.md).
- **`GBS_EVAL=1` tuning run** — operator-gated LLM scenario harness grading verb selection against fixtures.
- **First marketplace publish** at `deocracy/github-boards-skill`.
- **MCP server** + per-agent adapters — thin wrapper so Codex, Cursor, and CI can use the same verb contract without Claude Code.
- **Snapshot restore on demand** — `snapshot restore <ref>` executing the invert plan non-interactively (currently read-only; requires operator approval loop design).
- **Multi-board coordination** — point at more than one board at a time (v1 is single-board by design).

## Deferred (post-v1)

- **Server-side "button"** (GitHub Action on issue-comment/label/`workflow_dispatch`) and **always-on** (Agent SDK / scheduled headless `claude -p`). These need a PAT/App-authored identity (GitHub's default `GITHUB_TOKEN` cannot touch Projects v2).
- **Wiki** scaffolding under `wiki/` (deferred until post-publish).

## References

- Design spec: [docs/SPEC-BOARD-MANAGER.md](docs/SPEC-BOARD-MANAGER.md)
- Composability: [docs/COMPOSABILITY.md](docs/COMPOSABILITY.md)
- Architecture research (carried from GCA): the 5-front research + decision matrix.
