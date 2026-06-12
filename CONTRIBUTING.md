# Contributing

Thanks for considering it. This repo is small on purpose — one Node engine, one verb layer, zero runtime dependencies.

## Dev setup

```bash
git clone https://github.com/Deocracy/github-boards-skill
cd github-boards-skill
npm test        # 420+ deterministic tests, a few seconds, no network
```

Node ≥18. There is no build step.

## The rules that keep this repo safe

1. **`npm test` must pass** — run specific files with `node --test tests/<file>` (never `node --test tests/` bare — it breaks module resolution on this layout).
2. **Never set `GBS_LIVE=1` or `GBS_EVAL=1` in automated runs.** `GBS_LIVE=1` creates real GitHub resources (operator-only; see [docs/LIVE-RUNBOOK.md](docs/LIVE-RUNBOOK.md)); `GBS_EVAL=1` makes real model calls. CI and agents must never set either.
3. **Docs are drift-gated.** `tests/skill-evals.test.mjs` asserts the CLI's `--help`, `SKILL.md`, `AGENTS.md`, `commands/board.md`, and `README.md` agree. If you change a verb, the same PR updates the prose, the say-table, and (if output changed) regenerates the demo: `node scripts/make-demo-svg.mjs` after re-capturing the transcript.
4. **Every board write must be staged-previewable and fail closed.** New verbs follow the `{result, say}` + `--staged` conventions you'll see throughout `scripts/board-manager.mjs`.
5. **Simulation before live.** New behavior gets deterministic tests (see `tests/helpers/sim-world.mjs` for the multi-session harness). The live suite is for operators, not CI.

## Releases

Version bumps in `.claude-plugin/plugin.json` + `marketplace.json` together; directory listings get re-checked on every bump.
