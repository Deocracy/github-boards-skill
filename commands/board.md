---
description: Drive your GitHub Projects board in natural language — see your queue vs. Claude's, put/move/route/reject cards, and report what changed. With no args, shows a summary.
argument-hint: "[verb] [args...]  (e.g. summary | queue human | put \"Fix login\" | move 41 Building)"
---

Run the board verb layer with the user's arguments. Default to `summary` when no verb is given.

Execute this Bash command (the board script lives at the plugin root; `CLAUDE_PLUGIN_ROOT` resolves after install, and falls back to `.` when run from the repo):

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/scripts/board-manager.mjs" ${ARGUMENTS:-summary}
```

Here `$ARGUMENTS` is the full argument string the user typed after `/board`. If it is empty, the script is invoked with `summary`.

Then relay the script's first stdout line (the human-readable `say`) back to the user verbatim. The verbs available are: `summary`, `queue <agent|human>`, `put "<title>" [owner] [lane]`, `move <card#> <lane>`, `reject <card#> "<learnings>"`, `route <card#> <agent|human>`, `followup <parent#> "<title>" [owner]`, `reshape <preset>`. Add `--staged` to preview any write without committing.

If the script exits non-zero (e.g. no `board.json` configured, or `gh` not authenticated), report the error line plainly and suggest the user copy `board.example.json` to `board.json` and run `gh auth login` — do not retry blindly.
