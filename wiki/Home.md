# GitHub Boards Skill — Wiki

Talk to your GitHub Projects (v2) Kanban board in plain language. Claude reads it, edits it (with your approval), routes 🤖 agent-work vs 🧍 human-work, and tells you what changed.

> These wiki pages are the friendly face of the project. The **canonical, versioned docs live in [`docs/`](../docs)** and are synced here. If they ever disagree, `docs/` wins.

## Start here

- **[Installation](Installation)** — prerequisites, install, and the one-time board setup.
- **[Configuration](Configuration)** — `board.json`, `doctor`, and lane presets (software vs grants).
- **[Usage](Usage)** — the things you can say, and what each does.
- **[Composability](Composability)** — how other skills call this one.
- **[Architecture](Architecture)** — how it's built (and why).
- **[Roadmap](Roadmap)** — what's in v1 and what's planned.

## In one breath

Two layers in one self-contained, MIT skill: a **board engine** (`gh` CLI + GraphQL, with a preview of every write) and a **conversational layer** (natural language, owner routing, "what's on my plate", report-back). Installs as a Claude Code plugin. Status: **pre-release / design-stage** — see [Roadmap](Roadmap).
