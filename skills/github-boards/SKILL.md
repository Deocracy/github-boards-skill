---
name: github-boards
version: 0.2.0
author: Deocracy Institute
description: "Manage a GitHub Projects v2 Kanban board in natural language. Use when the user wants to put tasks or issues on a board, see what they (the human) need to work on versus what the AI is working on, move cards between lanes, route work as agent-actionable or human-actionable, reject with learnings, summarize what changed on the board, promote mapped backlog onto the board, sync TODOs or other skills' plans onto the board, check or heal ledger drift, browse board history, or undo recent board changes. Also use when ANOTHER skill needs to record tasks onto the board after research or planning. Reads and edits the board via the gh CLI and GitHub GraphQL, always previewing changes before writing and reporting back. Trigger phrases: put this on the board, add to kanban, what's on my plate, what is Claude working on, move card, update the board, show board status, reject with learnings, promote the backlog, sync my TODOs onto the board, heal the ledger, what changed this week, what did the board look like before, undo what happened since."
allowed-tools: "Bash, Read, Write"
---

# GitHub Boards

Drive a GitHub Projects (v2) Kanban board for the user in plain language, and let other skills record work onto it. This instruction body is **vendor-neutral** (it must mirror to `AGENTS.md` with no rewrite) — all board logic lives in the bundled script, not in this prose.

> **STATUS:** the engine (`scripts/board.mjs`), the verb layer (`scripts/board-manager.mjs`), the ledger pipeline (sync → map → promote), reconcile, and snapshots are implemented and tested. Before first use, configure `board.json` — run `node "<skill-dir>/scripts/board.mjs" doctor` for the setup checklist.

## How to run it

All board operations go through the bundled Node script (never hand-built `gh`/GraphQL — the script carries the safety rules). Invoke it cross-platform with an absolute path:

```
node "<skill-dir>/scripts/board-manager.mjs" <verb> [args] --config <path-to/board.json>
```

If the board isn't configured yet, run `node "<skill-dir>/scripts/board.mjs" doctor` first — it checks `gh`/Node, finds the project/field IDs, and prints the one-time human board-setup checklist.

## The pipeline (which verb when)

```
sources (TODO.md, plans, other skills' artifacts)
  └─ sync scan / sync record ─► intent LEDGER ─► map prepare / map record ─► promote plan / promote apply ─► BOARD
                                                          maintenance loops:
                                                          reconcile scan/apply  (drift report → ledger-only healing)
                                                          snapshot …            (board memory + the permanent journal)
```

Direct verbs (`put`, `move`, `route`, …) act on the board immediately. The pipeline verbs batch work through the ledger so nothing is filed twice and every promotion is resumable.

## The verbs

| User intent | Verb | Notes |
|---|---|---|
| "Put this/these on the board" | `put` | Files real Issues → adds to board → sets starting lane + owner label |
| "What do I need to do?" | `queue human` | The 🧍 cards (`needs-claude`) |
| "What is Claude working on?" | `queue agent` | The 🤖 cards (`agent:go`) |
| "Move card X to Review" | `move` | Sets the `Stage` field |
| "This needs me" / "Hand to Claude" | `route` | Flips the owner label; on 🧍 keeps the card claimed and @-mentions the human |
| "Reject, keep the learnings" | `reject` | `reject <card#> "<learnings>"` — moves to *Rejected (learnings kept)* + records a note |
| "Claude found more work" | `followup` | Files a child/sub-issue back onto the board |
| "Set up / adjust the lanes" | `reshape` | Diffs the board's `Stage` options vs the preset and prints the do-it-yourself checklist (read-only) |
| "What changed / show the board" | `summary` | Diffs vs. last-seen state and reports |
| "Set up a board from this repo" | `bootstrap` | One-time provisioning: project, Stage field, labels — from the current repo |
| "Note this for the board later" | `ledger` | Show or append raw intent candidates (the pipeline's inbox) |
| "Figure out what goes on the board / map these" | `map` | Strongest-model mapper: raw candidates → validated card proposals (lane/owner/split/merge), surfacing ambiguity. See `references/mapper-contract.md`. Records to the ledger; never writes the board directly. |
| "Promote the backlog" | `promote` | `promote plan` (read-only buckets) → `promote apply` (ledger candidates → real cards; cid markers; idempotent + resume-safe) |
| "Sync my TODOs / record this skill's tasks" | `sync` | `sync scan` (read-only: what changed in watched files) → `sync record` (extracted items → ledger). Nothing touches the board until `promote`. |
| "Is the board out of sync? / heal the ledger" | `reconcile` | `reconcile scan` (drift report) → `reconcile apply` (gated healing — writes the LEDGER only, never the board) |
| "What did the board look like / board history" | `snapshot` | `snapshot take` (manual save-point) · `snapshot list` · `snapshot diff` (what changed between two points) · `snapshot log` (the permanent event journal). All read-only toward the board. |
| "Undo what happened since X" | `snapshot invert` | Computes the inverse plan (read-only); execute it via `move`/`route` after approval. See `references/undo-contract.md`. |

> **Mapping (M2):** to turn collected candidates into card proposals, run `map prepare` for the input packet, reason per `references/mapper-contract.md` (escalating to a stronger model when it says to), then `map record --proposals <file>`.

## Unprompted context (the hooks)

This plugin's hooks feed you board context without being asked:

- **Session start:** when `board.json` is configured, a board digest (what changed since the last look) is injected automatically — if a digest appeared, don't re-run `summary` to orient; it already ran.
- **While editing:** when a watched source file (`board.json` → `sources.watch`) changes, a one-line note appears once per file per session. That is the cue to OFFER `sync scan` — not to run the pipeline silently.

## The undo reflex

When the user asks to undo or roll back board changes ("undo what happened since this morning", "put it back how it was"):

1. Run `snapshot list` and pin an explicit anchor (a stamp or `~N`) — `latest` is usually the snapshot the session-start hook just took *after* the changes. Then `snapshot invert <anchor>` prints the inverse plan: `ops` (executable) and `manual` (never auto-executed).
2. Show both lists to the user; on approval execute `ops` one by one via `move`/`route`.
3. Report back what was restored and what remains manual. Full contract: `references/undo-contract.md`.

## Hard rules (do not violate)

1. **Preview before every write.** Run the verb in staged/preview mode first, show the user the exact diff (cards, lanes, labels), and only commit on explicit approval. Never write to the board silently.
2. **Report back.** After a committed change, state plainly what changed and what's on each plate, e.g. *"✅ Filed 3 cards, moved #12 → Review. On your plate: 2 forms to submit. Claude's queue: 4 tasks."*
3. **Owner ≠ author.** The 🤖/🧍 signal is *who should act* (`agent:go` / `needs-claude` labels), separate from who authored the card.
4. **A 🧍 card stays claimed and escalates** — never silently parked. Keep its owner and post a GitHub mention/assignment so the human queue is real.
5. **Never attempt board view configuration.** Layout / group-by is browser-only. `reshape` sets data (Stage options, fields) and prints a human checklist for the view; it never claims to set the view itself.
6. **Fail closed.** On missing/ambiguous config or inaccessible board, stop with a clear message — don't guess.

## Routing (🤖 vs 🧍)

Marked by labels already understood by the board: `agent:go` = Claude-actionable, `needs-claude` = human-actionable. `route` flips them; `queue <agent|human>` filters them. The two "plates" are just two filtered views over the one board.

## Configuration

`board.json` binds to a board via `projectId`, `stageFieldId`, the `stageOptions` (lane label → option-id) map, `preset` (lane-shape template), and `routing` labels (`agent`/`human`). Lanes are **read from config** — a software board and a grants board can have different columns with no code change. Optional blocks: `sources` (`watch` globs + per-skill profiles for `sync`) and `snapshots` (`keep`, default 50). `doctor` discovers the IDs.

## Being called by another skill

Other skills may invoke this one to record work: *"use the github-boards skill to put these tasks on the board."* When called this way: file the tasks via `put` (or, for batches that should dedup and resume, `ledger`/`sync record` → `map` → `promote`), still show the staged preview + get approval (unless the caller explicitly runs in an approved/unattended context), and return the report-back so the calling skill can relay it. See `docs/COMPOSABILITY.md` for the full contract.

## Memory

Before summarizing, read `.github-boards/state.json` (the last-seen board digest) to report *what changed*; update it after. Longer-range memory lives in `.github-boards/snapshots/` — pruned full board states plus `log.jsonl`, the append-only event journal that is never pruned; `snapshot diff` and `snapshot log` read them. The board is always the source of truth — the state files are delete-safe markers.
