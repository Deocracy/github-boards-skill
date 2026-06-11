# Composability

This skill is meant to be **called by other skills**, not just by a human. A research, planning, or grant skill can hand its output straight to the board.

## The principle

`github-boards` is the **one place board writes happen**. Other skills should not hand-roll `gh`/GraphQL board edits — they delegate here so every write inherits the safety rules (staged preview, real-Issue cards, fail-closed Stage, owner routing, report-back).

## How another skill calls it

- **By name (recommended):** *"Use the github-boards skill to put these tasks on the board."*
- **By script (tight loops):** `node "<skill-dir>/scripts/board-manager.mjs" put --json '<tasks>' --config <board.json>`

## Callable verbs

`put`, `queue`, `move`, `route`, `followup`, `reshape`, `summary`. The two a calling skill uses most:

- **`put(tasks[])`** — record work onto the board immediately. Each task: `{ title, body?, lane?, owner? }` (`owner` = `agent` | `human`; defaults to `human` if a task plausibly needs a person). Returns the created card refs.
- **`summary()` / `queue(owner)`** — read board state back (e.g. a planning skill checking what's already filed before adding more).

## Batch path (dedup-safe, resumable)

For batches that should dedup and survive partial failure, use the pipeline instead of `put` directly:

```
ledger add / sync record  →  map prepare / map record  →  promote plan / promote apply
```

Each item gets a `cid` marker; `promote apply` is idempotent so re-running after a mid-batch crash won't double-file cards.

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

```json
{
  "committed": true,
  "created": ["#41", "#42", "#43"],
  "moved":   [{ "card": "#12", "to": "Review" }],
  "queues":  { "human": 2, "agent": 4 },
  "say": "✅ Filed 3 cards, moved #12 → Review. On your plate: 2 forms to submit. Claude's queue: 4 tasks."
}
```

## Rules a caller must respect

- Always show the **staged preview** to the user and wait for approval before passing the `--commit` flag (unless running in an explicitly approved/unattended context).
- Relay the `say` field back to the user verbatim.
- Never hand-roll GraphQL board edits — delegate everything through this skill.

Full contract: [`docs/COMPOSABILITY.md`](../docs/COMPOSABILITY.md).

> A future **MCP server** (deferred) will expose the same verbs to non-Claude agents (Codex, Cursor, CI) — see [Roadmap](Roadmap).
