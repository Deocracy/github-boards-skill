# Usage

Talk to Claude once the skill is installed and `board.json` is set, or use the `/board` slash command.

| Say this | What happens |
|---|---|
| "Put these tasks on the board" | Files real Issues → board → starting lane + owner, after a preview |
| "What do I need to work on?" | Lists your 🧍 human-actionable cards |
| "What is Claude working on?" | Lists the 🤖 agent-actionable cards |
| "Move the API card to Review" | Moves it to that lane |
| "This one needs me" / "Hand it to Claude" | Re-routes the owner; keeps a 🧍 card claimed and pings you |
| "Reject this, keep the learnings" | → *Rejected (learnings kept)* with a note |
| "Claude found more work" | Files a follow-up sub-issue onto the board |
| "What changed since last time?" | Diffs the board against your last visit |
| "Set up / adjust the lanes" | Sets the `Stage` options + prints the view checklist |

## The two rules that always hold

1. **Preview first.** Every change is shown to you and needs your OK before it's written.
2. **Report back.** After a change: *"✅ Filed 3 cards, moved #12 → Review. On your plate: 2 forms to submit. Claude's queue: 4 tasks."*

Full verb reference: [`docs/SPEC-BOARD-MANAGER.md`](../docs/SPEC-BOARD-MANAGER.md).
