---
name: github-boards
description: "Manage a GitHub Projects v2 Kanban board in natural language. Use when the user wants to put tasks or issues on a board, see what they (the human) need to work on versus what the AI is working on, move cards between lanes, route work as agent-actionable or human-actionable, reject with learnings, or summarize what changed on the board. Also use when ANOTHER skill needs to record tasks onto the board after research or planning. Reads and edits the board via the gh CLI and GitHub GraphQL, always previewing changes before writing and reporting back. Trigger phrases: put this on the board, add to kanban, what's on my plate, what is Claude working on, move card, update the board, show board status, reject with learnings."
allowed-tools: "Bash, Read, Write"
---

# GitHub Boards

Drive a GitHub Projects (v2) Kanban board for the user in plain language, and let other skills record work onto it. This instruction body is **vendor-neutral** (it must mirror to `AGENTS.md` with no rewrite) — all board logic lives in the bundled script, not in this prose.

> **IMPLEMENTATION STATUS (pre-release):** the executable engine (`scripts/board.mjs`) and verb layer (`scripts/board-manager.mjs`) are being built per `docs/SPEC-BOARD-MANAGER.md` and `ROADMAP.md`. Until then, follow these rules but expect the script commands below to be wired up during the build.

## How to run it

All board operations go through the bundled Node script (never hand-built `gh`/GraphQL — the script carries the safety rules). Invoke it cross-platform with an absolute path:

```
node "<skill-dir>/scripts/board-manager.mjs" <verb> [args] --config <path-to/board.json>
```

If the board isn't configured yet, run `node "<skill-dir>/scripts/board.mjs" doctor` first — it checks `gh`/Node, finds the project/field IDs, and prints the one-time human board-setup checklist.

## The verbs

| User intent | Verb | Notes |
|---|---|---|
| "Put this/these on the board" | `put` | Files real Issues → adds to board → sets starting lane + owner label |
| "What do I need to do?" | `queue --owner human` | The 🧍 cards (`needs-claude`) |
| "What is Claude working on?" | `queue --owner agent` | The 🤖 cards (`agent:go`) |
| "Move card X to Review" | `move` | Sets the `Stage` field |
| "This needs me" / "Hand to Claude" | `route` | Flips the owner label; on 🧍 keeps the card claimed and @-mentions the human |
| "Reject, keep the learnings" | `move … --reject` | Moves to *Rejected (learnings kept)* + records a note |
| "Claude found more work" | `followup` | Files a child/sub-issue back onto the board |
| "Set up / adjust the lanes" | `reshape` | Sets `Stage` options to the preset's columns + prints the UI-only view checklist |
| "What changed / show the board" | `summary` | Diffs vs. last-seen state and reports |

## Hard rules (do not violate)

1. **Preview before every write.** Run the verb in staged/preview mode first, show the user the exact diff (cards, lanes, labels), and only commit on explicit approval. Never write to the board silently.
2. **Report back.** After a committed change, state plainly what changed and what's on each plate, e.g. *"✅ Filed 3 cards, moved #12 → Review. On your plate: 2 forms to submit. Claude's queue: 4 tasks."*
3. **Owner ≠ author.** The 🤖/🧍 signal is *who should act* (`agent:go` / `needs-claude` labels), separate from who authored the card.
4. **A 🧍 card stays claimed and escalates** — never silently parked. Keep its owner and post a GitHub mention/assignment so the human queue is real.
5. **Never attempt board view configuration.** Layout / group-by is browser-only. `reshape` sets data (Stage options, fields) and prints a human checklist for the view; it never claims to set the view itself.
6. **Fail closed.** On missing/ambiguous config or inaccessible board, stop with a clear message — don't guess.

## Routing (🤖 vs 🧍)

Marked by labels already understood by the board: `agent:go` = Claude-actionable, `needs-claude` = human-actionable. `route` flips them; `queue --owner …` filters them. The two "plates" are just two filtered views over the one board.

## Configuration

`board.json` binds to a board via `projectId`, `stageFieldId`, the `stageOptions` (lane label → option-id) map, `preset` (lane-shape template), and `routing` labels (`agent`/`human`). Lanes are **read from config** — a software board and a grants board can have different columns with no code change. `doctor` discovers the IDs.

## Being called by another skill

Other skills may invoke this one to record work: *"use the github-boards skill to put these tasks on the board."* When called this way: file the tasks via `put`, still show the staged preview + get approval (unless the caller explicitly runs in an approved/unattended context), and return the report-back so the calling skill can relay it. See `docs/COMPOSABILITY.md` for the full contract.

## Memory

Before summarizing, read `.github-boards/state.json` (the last-seen board digest) to report *what changed*; update it after. The board is always the source of truth — the state file is a delete-safe marker.
