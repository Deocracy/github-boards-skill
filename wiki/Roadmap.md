# Roadmap

**Status: all six milestones shipped.** One operator live-E2E run remains before 1.0. Canonical plan: [`ROADMAP.md`](../ROADMAP.md).

## Shipped milestones

| Milestone | Shipped | One-liner |
| --- | --- | --- |
| M1 Foundation | 2026-06-08 | Intent ledger + `bootstrap` — provision a board from zero and start tracking candidates immediately |
| M2 Brain / Mapper | 2026-06-09 | Strongest-model mapper turns raw candidates into well-shaped card proposals (lane, owner, split/merge, ambiguity surfaced) — enriches the ledger, never writes the board |
| M3a Promotion | 2026-06-09 | `promote plan` / `promote apply` — approval-gated, idempotent promotion of ledger candidates to real GitHub Issues; `cid` markers make every mid-batch failure resumable |
| M3b Source Adapters | 2026-06-09 | `sync scan` / `sync record` — profile-driven discovery of TODOs and plan files from any skill; LLM-native extraction, no format parsers in code |
| M3c Real-Time Triggering | 2026-06-10 | PostToolUse hook surfaces watched-file changes to Claude mid-session the moment they're written — stateless signal, no queue |
| M4a Reconcile | 2026-06-10 | `reconcile scan` / `reconcile apply` — classifies drift across source files, ledger, and board; heals the ledger only (board mutations stay `promote`'s job) |
| M4b Time-Travel | 2026-06-10 | `snapshot` family — pruned full-board save-points + a never-pruned event log; `snapshot invert` produces a mechanically-computed undo plan |
| M5 Skill Layer | 2026-06-11 | SKILL.md + AGENTS.md rewritten to the full pipeline; `references/undo-contract.md`; deterministic prose drift gates wired into `npm test` |
| M6 Verification | 2026-06-11 | Simulation world (multi-session lifecycle scenarios) + seeded soak + crash atlas covering every multi-write gap; one gated live-E2E + runbook |

## v1 checklist (the publishable core)

- [x] `scripts/board.mjs` — the bundled engine (`staged()` preview, `doctor`, `capabilities`).
- [x] `scripts/board-manager.mjs` — the callable verb contract: `put`, `queue`, `move`, `route`, `followup`, `reshape`, `summary`, `ledger`, `map`, `promote`, `sync`, `reconcile`, `snapshot`.
- [x] `skills/github-boards/SKILL.md` — the canonical vendor-neutral instruction body (full pipeline + undo + hooks).
- [x] `commands/board.md` — the `/board` slash command.
- [x] `hooks/` — SessionStart (board digest + source-change notes), PostToolUse (real-time file-watch trigger), PreToolUse (pre-allow the script).
- [x] `board.json` schema + `doctor`-assisted discovery of IDs.
- [x] 423 tests (419 passing, 4 operator-gated live skips) — deterministic drift gates keep docs honest.
- [ ] Operator live-E2E run (`GBS_LIVE=1`) — see [`docs/LIVE-RUNBOOK.md`](../docs/LIVE-RUNBOOK.md).
- [ ] First marketplace publish (`deocracy/github-boards-skill`).

## Next

- **Operator live-E2E run** — full bootstrap → promote → move → reconcile → snapshot/invert → teardown against a real board.
- **`GBS_EVAL=1` tuning run** — operator-gated LLM scenario harness grading verb selection against fixtures.
- **First marketplace publish** at `deocracy/github-boards-skill`.
- **MCP server** + per-agent adapters — thin wrapper so Codex, Cursor, and CI can use the same verb contract without Claude Code.
- **Snapshot restore on demand** — `snapshot restore <ref>` executing the invert plan non-interactively (currently read-only; requires operator approval loop design).
- **Multi-board coordination** — single-board by design in v1.

## Deferred (post-v1)

- **Server-side "button"** (GitHub Action) and **always-on** (Agent SDK / scheduled headless).
- **Multi-board coordination.**
