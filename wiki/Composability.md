# Composability

This skill is meant to be **called by other skills**, not just by a human. A research or planning skill can hand its output straight to the board.

## How another skill calls it

- **By name (recommended):** *"Use the github-boards skill to put these tasks on the board."*
- **By script (tight loops):** `node "<skill-dir>/scripts/board-manager.mjs" put --json '<tasks>' --config <board.json>`

## Hand off tasks already tagged 🤖/🧍

```jsonc
[
  { "title": "Draft Section 3 of the grant narrative", "owner": "agent",  "lane": "Drafting" },
  { "title": "Get the PI signature",                    "owner": "human", "lane": "Needs-info" },
  { "title": "Submit via the portal",                   "owner": "human", "lane": "Ready-to-submit" }
]
```

Claude takes the 🤖 cards; the 🧍 cards land on the human's plate.

## What you get back

A structured result plus a sentence to relay: created cards, moves, queue counts, and a `say` line like *"✅ Filed 3 cards… On your plate: 2 forms to submit."*

Full contract: [`docs/COMPOSABILITY.md`](../docs/COMPOSABILITY.md).

> A future **MCP server** (deferred) will expose the same verbs to non-Claude agents (Codex, Cursor, CI) — see [Roadmap](Roadmap).
