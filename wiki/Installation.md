# Installation

## Prerequisites

- **[Claude Code](https://code.claude.com)** — the runtime.
- **[GitHub CLI (`gh`)](https://cli.github.com)**, authenticated: `gh auth login`. You never paste a token into a file.
- A GitHub token with **`project`** and **`repo`** scopes (classic PAT, or fine-grained with *Projects: read & write* and *Issues: read & write*) — `gh auth login` can grant them. (`repo` is required because the skill files real GitHub Issues.)
- **Node.js 18+** on your PATH. *(Claude Code does not bundle Node.)*
- A **GitHub Project (v2)** board.

## Install (plugin)

```text
/plugin marketplace add deocracy/github-boards-skill
/plugin install github-boards@github-boards-skill
```

Pick a scope when prompted: `user` (all projects), `project` (shared via git), or `local` (this session).

## Install (manual)

The skill invokes `scripts/board-manager.mjs` and `scripts/board.mjs`; those scripts live at the **repo root**, not inside `skills/github-boards/`. Copying just `skills/github-boards/` leaves the scripts behind — nothing will run. You must keep the entire clone intact and register it as a local plugin:

```bash
# Clone anywhere — keep the whole repo (scripts/ must stay alongside skills/):
git clone https://github.com/deocracy/github-boards-skill ~/github-boards-skill

# Register the clone as a local marketplace and install from it:
claude plugin marketplace add ~/github-boards-skill
claude plugin install github-boards@github-boards-skill
```

Do NOT copy only `skills/github-boards/` into `~/.claude/skills/` — that strips the engine scripts.

## One-time board setup (human step)

No token can create or group a board *view* — that's browser-only. Once per board, in the GitHub UI:

1. Create a **Project (v2)**.
2. Add a **single-select** field `Stage` with your lane options.
3. Set the board **view** to **group by `Stage`**.

Run the skill's `doctor` afterwards — it prints this checklist and flags anything missing, then discovers the IDs for [Configuration](Configuration).

## Verify the install

From the cloned repo root (or from whichever directory the plugin registered):

```text
node scripts/board.mjs doctor
```

`doctor` checks your `gh` auth, Node version, project/field IDs, and prints the one-time human board-setup checklist. Fix anything it flags before running verbs.
