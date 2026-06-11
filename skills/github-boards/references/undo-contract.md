# The Undo Contract

How to undo board changes conversationally. The snapshot store is read-only toward the board; **all undo writes go through the existing approval-gated verbs** (`move`, `route`). There is no batch restore.

## When to trigger

The user asks to undo, roll back, revert, or "put the board back how it was" — optionally anchored to a point ("since this morning", "before the cleanup"). Resolve the anchor to a snapshot ref: `latest`, `~N` (1-based age), or an ISO date/time prefix (`2026-06-10`, `2026-06-10T09`). `snapshot list` shows what exists. Pin an explicit anchor (stamp or `~N`) rather than relying on `latest`: the session-start hook's `summary` auto-snapshots the current board, so the newest snapshot usually reflects the changes you're trying to undo. `snapshot invert` defaults to `latest` when no ref is given — fine for quick same-session undo, wrong across sessions.

## The four steps

1. **Compute:** `node "<skill-dir>/scripts/board-manager.mjs" snapshot invert <ref> --config <path>` (add `<ref2>` to undo between two stored points; omitted = vs the live board). Output: `say` + JSON `{ops, manual}`.
2. **Preview:** show the user BOTH lists —
   - `ops`: each `{op:'move', issueNumber, to}` ("move #N back to <lane>") and `{op:'route', issueNumber, to}` ("route #N back to agent/human").
   - `manual`: items the verbs cannot restore, each with its `reason` (added cards are never auto-deleted; removed cards are never recreated; retitles have no verb; and any label change that isn't a pure owner flip — including an owner flip bundled with other label changes — goes manual (the per-item reason names the exact labels)).
3. **Execute on approval:** run each op via the normal verbs, in the listed order (moves first, then reroutes):
   - `move <issueNumber> <to>` · `route <issueNumber> <to>`
   - The user may approve a subset — execute only what they approved. `--staged` previews any single op.
   - Routing a card back to `human` posts the standard escalation comment (the card re-enters the human queue loudly) — include that in the preview so the user expects it.
4. **Report back:** what was restored, what was skipped, what remains manual.

## Invariants

- Never execute without showing the plan first (hard rule 1 applies to every op).
- Never act on `manual` items — surface them; the human decides.
- An empty `ops` with non-empty `manual` is a valid outcome: say so plainly and stop.
- `snapshot invert` itself never writes; when diffing against the live board (no `<ref2>`), re-running `snapshot invert <anchor>` after a partial execution recomputes the remaining delta safely — already-restored cards drop out. With two stored refs the plan is static: re-running re-proposes every op, so track partial execution yourself (and note a repeated `route … human` posts a duplicate escalation comment).
