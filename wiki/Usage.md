# Usage

Talk to Claude once the skill is installed and `board.json` is set, or use the `/board` slash command. A few verbs (`queue`, `summary`, `bootstrap`, `snapshot list`) work before `board.json` is configured — everything else needs it.

## Direct board operations

| Say this | Verb | What happens |
| --- | --- | --- |
| "Put these tasks on the board" | `put` | Files real Issues → board → starting lane + owner, after a staged preview |
| "What do I need to work on?" | `queue human` | Lists your 🧍 human-actionable cards (`needs-claude`) |
| "What is Claude working on?" | `queue agent` | Lists the 🤖 agent-actionable cards (`agent:go`) |
| "Move the API card to Review" | `move` | Sets the `Stage` field to that lane |
| "This one needs me" / "Hand it to Claude" | `route` | Flips the owner label; keeps a 🧍 card claimed and pings you |
| "Reject this, keep the learnings" | `reject` | → *Rejected (learnings kept)* lane with a recorded note |
| "Claude found more work" | `followup` | Files a child/sub-issue linked to its parent |
| "What changed since last time?" | `summary` | Diffs the board against `.github-boards/state.json` (last-seen) |
| "Set up / adjust the lanes" | `reshape` | Diffs board `Stage` options vs the preset; prints the do-it-yourself checklist (read-only) |
| "Set up a board from this repo" | `bootstrap` | One-time provisioning: project, Stage field, labels — from the current repo |

## The ledger pipeline

Use this when work comes from source files, another skill's output, or when you want dedup and resumability:

| Say this | Verb | What happens |
| --- | --- | --- |
| "Note this for the board later" | `ledger` | Show or append raw intent candidates (the pipeline's inbox) |
| "Sync my TODOs / record this skill's tasks" | `sync scan` | Read-only: what changed in watched source files |
| | `sync record --extracted <file>` | Records the LLM's extracted work items into the ledger |
| "Figure out what goes on the board" | `map prepare` | Builds the mapper input packet |
| | `map record --proposals <file>` | Validates and records the mapper's proposals into the ledger |
| "Promote the backlog" | `promote plan` | Read-only: classifies ledger candidates into promotion buckets |
| | `promote apply` | Promotes confident/decided candidates to real cards (idempotent, `cid`-resumable) |

Add `--staged` to any write verb to preview changes without committing them.

## Maintenance loops

| Say this | Verb | What happens |
| --- | --- | --- |
| "Is the board out of sync? / heal the ledger" | `reconcile scan` | Drift report: ledger vs board vs source files (read-only) |
| | `reconcile apply` | Heals the ledger only — board mutations stay `promote`'s job |

## Time-travel and undo

| Say this | Verb | What happens |
| --- | --- | --- |
| "Save a board snapshot" | `snapshot take ["label"]` | Manual save-point (dedup'd) |
| "Show saved snapshots" | `snapshot list` | All save-points, newest first |
| "What changed between X and Y?" | `snapshot diff [ref] [ref2]` | Diff between two points (defaults: latest vs live board) |
| "Show board history" | `snapshot log [N]` | The permanent event journal (never pruned; default last 20) |
| "What did the board look like before X?" | `snapshot diff <ref>` | Same as above, scoped to an anchor |
| "Undo what happened since this morning" | `snapshot invert [ref]` | Computes the inverse operation plan (read-only); execute `ops` via `move`/`route` after approval |

**Undo flow:** run `snapshot list` to pin an anchor, then `snapshot invert <anchor>` to get the plan. Approve it, then execute the `ops` list one by one. Full contract: [`references/undo-contract.md`](../references/undo-contract.md).

## The two rules that always hold

1. **Preview first.** Every change is shown to you and needs your OK before it's written. Use `--staged` to force preview mode on any verb.
2. **Report back.** After a change: *"✅ Filed 3 cards, moved #12 → Review. On your plate: 2 forms to submit. Claude's queue: 4 tasks."*

Full verb reference: [`docs/SPEC-BOARD-MANAGER.md`](../docs/SPEC-BOARD-MANAGER.md).
