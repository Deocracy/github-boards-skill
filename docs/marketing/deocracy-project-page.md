> **Operator note:** publish this page only after the feat/m7-adoption branch merges to main — the demo image hotlinks raw.githubusercontent.com/main and will 404 or show stale content until then.

# GitHub Boards — a Deocracy Institute open-source project

*Drive your project board by conversation.*

Tell your coding agent *"put these on the board"*, *"what's on my plate?"*, *"undo what happened since this morning"* — and it manages a real GitHub Projects board for you: previewing every change, writing only with your approval, and reporting back in plain language.

![Demo](https://raw.githubusercontent.com/Deocracy/github-boards-skill/main/assets/demo.svg)

## Why we built it

Deocracy runs on boards — software boards and grant-paperwork boards alike. Most board work isn't typing cards into a UI; it's deciding what belongs there, who should act (the human or the AI), and noticing what changed. We built GitHub Boards so an AI assistant can do the mechanical part safely: it routes every task as agent-actionable 🤖 or human-actionable 🧍, never writes without showing you first, and keeps a permanent journal so any change can be understood — and undone.

## What makes it trustworthy

- **Staged preview before every write** — the board is never edited silently.
- **Fail-closed** — ambiguous config stops the tool instead of guessing.
- **Time-travel** — board snapshots, a never-pruned change journal, computed undo plans.
- **Open** — MIT-licensed, zero runtime dependencies, fully tested, works with Claude Code today and any AGENTS.md-reading agent.

## Get it

```
/plugin marketplace add deocracy/github-boards-skill
/plugin install github-boards@github-boards-skill
```

Repository: https://github.com/Deocracy/github-boards-skill · License: MIT
