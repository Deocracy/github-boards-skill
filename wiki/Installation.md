# Installation

## Prerequisites

- **[Claude Code](https://code.claude.com)** — the runtime.
- **[GitHub CLI (`gh`)](https://cli.github.com)**, authenticated: `gh auth login`. You never paste a token into a file.
- A GitHub token with **`project`** scope (classic PAT, or fine-grained with *Projects: read & write*) — `gh auth login` can grant it.
- **Node.js 18+** on your PATH. *(Claude Code does not bundle Node.)*
- A **GitHub Project (v2)** board.

## Install (plugin)

```
/plugin marketplace add deocracy/github-boards-skill
/plugin install github-boards@github-boards-skill
```

Pick a scope when prompted: `user` (all projects), `project` (shared via git), or `local` (this session).

## Install (manual)

Clone the repo and copy `skills/github-boards/` into `~/.claude/skills/`.

## One-time board setup (human step)

No token can create or group a board *view* — that's browser-only. Once per board, in the GitHub UI:

1. Create a **Project (v2)**.
2. Add a **single-select** field `Stage` with your lane options.
3. Set the board **view** to **group by `Stage`**.

Run the skill's `doctor` afterwards — it prints this checklist and flags anything missing, then discovers the IDs for [Configuration](Configuration).

> Final org/repo slug is TBD before first publish — see [Roadmap](Roadmap).
