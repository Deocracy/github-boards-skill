# Composability — how other skills work with `github-boards`

This skill is built to be **called by other skills** (deep-research, planning, grant work, your own) as well as driven directly by a human. This doc is the stable contract for that.

## The principle

`github-boards` is the **one place board writes happen**. Other skills should not hand-roll `gh`/GraphQL board edits — they delegate to this skill so every write inherits the safety rules (staged preview, real-Issue cards, fail-closed Stage, owner routing, report-back). One skill, one source of truth for the board.

## Two ways to call it

1. **By name, in-session (recommended).** A skill instructs Claude: *"Use the github-boards skill to put these tasks on the board."* Claude loads this skill and runs the right verb. Cheapest path; shares the current context.
2. **By script (tight loops).** A skill calls the bundled contract directly:
   ```
   node "<skill-dir>/scripts/board-manager.mjs" put --json '<tasks>' --config <board.json>
   ```
   The script is the deterministic, testable contract — same behavior whichever way it's invoked.

> A future **MCP server** (deferred) will expose the same verbs as typed tools so *non-Claude* agents and CI can call them. The verb set below is designed to be that contract unchanged.

## The callable verbs

`put`, `queue`, `move`, `route`, `followup`, `reshape`, `summary` (see [SPEC-BOARD-MANAGER.md](SPEC-BOARD-MANAGER.md) for full signatures). The two a calling skill uses most:

- **`put(tasks[])`** — record work onto the board. Each task: `{ title, body?, lane?, owner? }` (`owner` = `agent` | `human`; defaults to `human` if a task plausibly needs a person). Returns the created card refs.
- **`summary()` / `queue(owner)`** — read board state back (e.g. a planning skill checking what's already filed before adding more).

### Task hand-off shape

When a research/planning skill produces work, it should pass tasks already tagged with owner intent, e.g.:

```jsonc
[
  { "title": "Draft Section 3 of the grant narrative", "owner": "agent",  "lane": "Drafting" },
  { "title": "Get the PI signature on the cover letter", "owner": "human", "lane": "Needs-info" },
  { "title": "Submit via Grants.gov portal",             "owner": "human", "lane": "Ready-to-submit" }
]
```

This is the grant example made concrete: Claude takes the 🤖 cards; the 🧍 cards land on the human's plate.

## The report-back protocol

Every mutating call returns a **structured result + a human sentence**:

```jsonc
{
  "committed": true,
  "created": ["#41", "#42", "#43"],
  "moved":   [{ "card": "#12", "to": "Review" }],
  "queues":  { "human": 2, "agent": 4 },
  "say": "✅ Filed 3 cards, moved #12 → Review. On your plate: 2 forms to submit. Claude's queue: 4 tasks."
}
```

The calling skill relays `say` to the user and can branch on the structured fields.

## Rules a caller must respect

1. **Writes are still previewed + approved** unless the caller is explicitly running in an approved/unattended context. A composing skill cannot silently bypass the HITL gate.
2. **Owner-tag your tasks.** If a task needs a person, mark it `human` — don't let Claude pick up paperwork it can't actually do.
3. **Read before bulk-adding.** Use `summary`/`queue` to avoid duplicate cards.
4. **Don't write the board any other way.** Route all board edits through this skill so the invariants and report-back hold.

## Notes for skill authors

- Triggering: this skill auto-fires on board-related language, but for reliable composition, **name it explicitly** ("use the github-boards skill…").
- It is vendor-neutral by design — the same instructions back a future `AGENTS.md`, so a skill that composes it today keeps working under other agents later.
