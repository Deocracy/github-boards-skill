# Official plugin-directory submission — paste-ready package

**Form:** https://clau.de/plugin-directory-submission (operator files this)
**PRECONDITIONS (in order):** ① the live E2E has passed once (docs/LIVE-RUNBOOK.md) ② the storefront branch is merged & released (v0.2.0) ③ README status line updated.

## Form fields

- **Plugin name:** github-boards
- **Marketplace repo:** https://github.com/Deocracy/github-boards-skill
- **Install:** `/plugin marketplace add deocracy/github-boards-skill` → `/plugin install github-boards@github-boards-skill`
- **One-paragraph description:**
  > Drive a real GitHub Projects v2 Kanban board by conversation: file, move, route, and reject cards; see your queue vs the agent's; batch work through a dedup'd sync → map → promote pipeline; heal drift; and undo via board snapshots with a permanent change journal. Every write is staged-previewed and requires explicit approval — the board is never written silently.
- **Category:** productivity / project management
- **What it accesses:** the user's own `gh` CLI session (GitHub Issues + Projects v2, `project` + `repo` scopes). No bundled credentials, no third-party services, no telemetry.
- **Security posture:** every write previewed + approved; fail-closed on ambiguous config; local state is plain JSON under `.github-boards/`; hooks are read-only toward GitHub; live/integration tests are operator-gated behind `GBS_LIVE=1` and never run automatically; SECURITY.md documents reporting.
- **Quality evidence:** 426 deterministic tests (422 pass, 4 operator-gated skips) including a multi-session simulation harness with crash-recovery scenarios and a seeded soak; docs are drift-gated (CLI help ↔ SKILL.md ↔ AGENTS.md ↔ README enforced by tests); MIT.
- **Assets:** README demo `assets/demo.svg`; social card `assets/social-preview.png`.

## Resubmission log

| Date | Outcome | Review feedback | Fix commits |
|---|---|---|---|
| _(file after first submission)_ | | | |
