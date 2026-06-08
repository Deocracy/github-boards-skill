# GitHub Boards Skill

> Talk to your GitHub Projects (v2) Kanban board in plain language — *"put this on the board"*, *"what's on my plate?"*, *"what is Claude working on?"* — and have Claude read it, edit it (with your approval), and tell you what changed.

**A standalone, self-contained, MIT-licensed [Claude Code](https://code.claude.com) skill.** It reads and edits a GitHub Projects v2 board, routes work as 🤖 agent-actionable vs 🧍 human-actionable, previews every change before writing, and reports back. It is **composable**: any other skill (deep-research, grant work, your own) can call it to drop tasks onto the board.

> **Status: v0.1 built, pre-publish.** The full skill is implemented and tested (115 tests). Final live-board integration and the first publish are the remaining steps — see [ROADMAP](ROADMAP.md).

---

## What it does

| You say… | It does |
|---|---|
| "Put these three tasks on the board" | Files real Issues, adds them to the board, sets the starting lane + owner — after showing you a preview |
| "What do I need to work on?" | Lists the 🧍 human-actionable cards (your plate) |
| "What is Claude working on?" | Lists the 🤖 agent-actionable cards |
| "Move the API card to Review" | Moves the card to that lane |
| "This one needs me" / "Hand it to Claude" | Re-routes the card's owner and keeps it claimed |
| "Reject this, but keep the learnings" | Moves it to the *Rejected (learnings kept)* lane with a note |
| "What changed since last time?" | Diffs the board against the last time you looked |

**Every change is previewed and needs your OK before it's written.** Nothing happens to your board silently.

## Why this exists

GitHub Projects can be driven by an agent, but the raw API has sharp edges (it's easy to create the wrong kind of card or write the wrong field) and no notion of *"can the AI do this, or do I have to?"*. This skill is a thin, safe, conversational layer that encodes those rules once and makes the board easy to drive by voice — for software work **and** non-software work (e.g. grant paperwork, where most cards are human-actionable).

## How it works (two layers, one repo)

```
  You / other skills  ─►  github-boards skill  ─►  bundled board engine (gh CLI + GraphQL)  ─►  GitHub Projects v2
                            (natural language,        (read / make / move, with a
                             owner routing,            staged preview of every write)
                             "what's on my plate",
                             report-back)
```

Both layers ship in **this** repo, so it installs and runs without any other project.

## Prerequisites

- **[Claude Code](https://code.claude.com)** — the runtime.
- **[GitHub CLI (`gh`)](https://cli.github.com)**, authenticated: run `gh auth login` once. The skill uses your stored credentials — **you never paste a token into a config file.**
- A GitHub token with **`project`** scope (a classic PAT, or a fine-grained PAT with *Projects: read & write*). `gh auth login` can grant this.
- **Node.js 18+** on your PATH. *(Claude Code does not bundle Node; the engine is a Node script.)*
- A **GitHub Project (v2)** board — see *One-time board setup* below.

## Install

**Recommended — as a Claude Code plugin:**

```
/plugin marketplace add deocracy/github-boards-skill
/plugin install github-boards@github-boards-skill
```

*(Choose a scope when prompted: `user` = all your projects, `project` = shared via version control, `local` = this session.)*

**Manual fallback:**

```
git clone https://github.com/deocracy/github-boards-skill ~/.claude/skills-src/github-boards-skill
# then copy skills/github-boards/ into ~/.claude/skills/
```

> These install commands work once the repo is published at `deocracy/github-boards-skill` — see Status above.

## One-time board setup (the human step)

GitHub does **not** let any token create or group a board *view* — that's browser-only. So once per board, you (a human) do this in the GitHub UI:

1. Create a **Project (v2)**.
2. Add a **single-select field** named `Stage` with your lane options (e.g. *Ideas, Researching, Building, Review, Shipped, Rejected (learnings kept)* — or your own; see *Configuration*).
3. Set the board **view** to **group by `Stage`**.

The skill's `doctor` command prints this checklist and tells you exactly what's missing. After that, the skill handles everything data-shaped (filing cards, moving lanes, routing, commenting).

## Configuration

A `board.json` file binds the skill to your board:

```jsonc
{
  "owner":         "deocracy",            // repo/project owner login (org or user)
  "ownerType":     "organization",        // "organization" or "user"
  "projectNumber": 23,                    // the project number (from the URL)
  "projectId":     "PVT_…",              // Project v2 node id (found by doctor)
  "repo":          "deocracy/your-repo",  // owner/repo slug
  "stageFieldId":  "PVTSSF_…",           // the Stage single-select field id
  "stageOptions":  { "Ideas": "…optionId", "Building": "…optionId" },  // lane label → option id
  "preset":        "build",               // or "grants" — the lane-shape template
  "routing":       { "agent": "agent:go", "human": "needs-claude" }    // 🤖/🧍 labels (optional; these are the defaults)
}
```

Run `doctor` to discover these IDs for you. Lanes are **read from config**, so a *software* board and a *grants* board can have different columns without any code change.

## Usage

Just talk to Claude once the skill is installed and `board.json` is set. Or use the `/board` slash command in-session. Example phrases are in the table at the top; full verb reference in [docs/](docs/) and the [wiki](../../wiki).

## Composability — calling it from other skills

This skill is designed to be **invoked by other skills**. Any skill can say *"use the github-boards skill to put these tasks on the board"* and it will file + preview + report back. See [docs/COMPOSABILITY.md](docs/COMPOSABILITY.md) for the callable contract and the report-back protocol.

## Memory

The skill keeps a small, delete-safe `.github-boards/state.json` (git-ignored) recording what the board looked like last time, so it can tell you *what changed* since you were last here. **The board itself is always the source of truth**; the state file is just a "where I left off" marker.

## Known limitations (v1)

- **Staged previews:** in staged mode nothing is written to the board, but a fully *offline* preview of a multi-step write is not possible — the engine performs validation reads before the write guard. Previews are accurate about intent.
- **`reshape`:** produces a diff + a human checklist of the lanes to add/rename in the GitHub UI; it does not auto-modify the board's Stage options (GitHub API limitation). The board *view* grouping (group-by Stage) is UI-only regardless — no API can set it.
- **Hooks:** SessionStart context injection, `$ARGUMENTS` expansion, and the PreToolUse auto-allow are verified against a live session in integration. On some setups, plugin SessionStart context injection may not surface (a documented upstream issue) — the skill still works fully via the `/board` command and direct calls.

## Agnosticism

v1 targets **Claude Code**. The board rules live in one vendor-neutral instruction body, and the verb contract is built so an **MCP server** (for Codex / Cursor / CI / other agents) is a thin add-on later — see the [ROADMAP](ROADMAP.md).

## License

[MIT](LICENSE) © Deocracy Institute.
