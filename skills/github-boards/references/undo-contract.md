# The Undo Contract

How to undo board changes conversationally. The snapshot store is read-only toward the board; **all undo writes go through the existing approval-gated verbs** (`move`, `route`). There is no batch restore.

## When to trigger

The user asks to undo, roll back, revert, or "put the board back how it was" — optionally anchored to a point ("since this morning", "before the cleanup"). Resolve the anchor to a snapshot ref: `latest`, `~N` (1-based age), or an ISO date/time prefix (`2026-06-10`, `2026-06-10T09`). `snapshot list` shows what exists.

## The four steps

1. **Compute:** `node "<skill-dir>/scripts/board-manager.mjs" snapshot invert <ref> --config <path>` (add `<ref2>` to undo between two stored points; omitted = vs the live board). Output: `say` + JSON `{ops, manual}`.
2. **Preview:** show the user BOTH lists —
   - `ops`: each `{op:'move', issueNumber, to}` ("move #N back to <lane>") and `{op:'route', issueNumber, to}` ("route #N back to agent/human").
   - `manual`: items the verbs cannot restore, each with its `reason` (added cards are never auto-deleted; removed cards are never recreated; retitles and non-owner label changes have no verb).
3. **Execute on approval:** run each op via the normal verbs, in the listed order (moves first, then reroutes):
   - `move <issueNumber> <to>` · `route <issueNumber> <to>`
   - The user may approve a subset — execute only what they approved. `--staged` previews any single op.
4. **Report back:** what was restored, what was skipped, what remains manual.

## Invariants

- Never execute without showing the plan first (hard rule 1 applies to every op).
- Never act on `manual` items — surface them; the human decides.
- An empty `ops` with non-empty `manual` is a valid outcome: say so plainly and stop.
- `snapshot invert` itself never writes; if anything in the flow fails mid-way, re-running `snapshot invert` recomputes the remaining delta safely (already-restored cards drop out of the diff).
