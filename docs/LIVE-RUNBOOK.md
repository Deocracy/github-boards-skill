# Live E2E Runbook

The live test suite creates and deletes **real GitHub resources**. It is
operator-only — never run in CI, automated pipelines, or agentic sessions.

---

## The standing rule

`GBS_LIVE=1` is set by a **human at a terminal**, never in CI, never in
automated or agent-driven sessions. All four live tests skip without it; each
skip message points here.

---

## Prerequisites

1. **`gh` CLI authenticated** with `project` and `repo` scopes:
   ```
   gh auth status
   gh auth refresh -s project,repo   # if scopes are missing
   ```
2. **Run from inside a git repo with a GitHub remote.** The bootstrap step
   calls `detectRepo` to discover your org/user and repository, exactly as
   `tests/live-bootstrap.test.mjs` does — no env var override is needed;
   the current working directory's remote is used.
3. **Node ≥ 18** (ESM support required).
4. **Run from the repo root** so relative imports resolve correctly.

> No `GBS_LIVE_REPO` or `board.json` is pre-required. The suite bootstraps a
> throwaway Projects v2 board and tears it down in the `finally` block.

---

## Running

**Bash / Git Bash:**
```bash
GBS_LIVE=1 node --test tests/live-e2e.test.mjs        # just the full-story E2E
GBS_LIVE=1 node --test tests/live-bootstrap.test.mjs  # bootstrap smoke only
GBS_LIVE=1 node --test tests/live-promote.test.mjs    # promote smoke only
GBS_LIVE=1 npm test                                   # whole suite (all 4 live tests)
```

**PowerShell:**
```powershell
$env:GBS_LIVE='1'; node --test tests/live-e2e.test.mjs; Remove-Item Env:GBS_LIVE
```

**Dry-run (skip verification — must show 1 skipped):**
```bash
node --test tests/live-e2e.test.mjs
```

---

## What the E2E test creates

| Resource | Name / pattern | Where |
|---|---|---|
| Projects v2 board | `gbs-e2e-<PID>` | Your GitHub org/user |
| GitHub Issue | "E2E smoke card" | The repo detected from your CWD |
| Local state | Temp dir under OS tmpdir | Auto-removed by the OS |

The bootstrap, promote, and E2E tests each create their own throwaway board
with distinct name patterns (`gbs-smoke-<PID>`, `gbs-promote-smoke-<PID>`,
`gbs-e2e-<PID>`).

---

## Expected output

All assertions pass; the teardown block confirms the board is deleted. Total
runtime is typically 1–3 minutes (GraphQL round-trips to GitHub).

The final suite line should read:
```
# tests 426
# pass 426
# fail 0
# skipped 0
```
(with `GBS_LIVE=1`; the four live tests no longer skip)

---

## Teardown verification

Each test tears down in a `finally` block using:
```graphql
mutation($id: ID!) {
  deleteProjectV2(input: { projectId: $id }) { clientMutationId }
}
```

After a run, confirm:
- The board (`gbs-e2e-<PID>`) no longer appears in your GitHub Projects list.
- The "E2E smoke card" Issue is visible in the repo's Issues list (it is
  **not** auto-closed — close it manually if desired).

---

## Manual cleanup after a teardown failure

If the `finally` block fails, the test prints:
```
LIVE E2E TEARDOWN FAILED — clean up by hand: {"projectId":"PVT_...", ...}
  Project URL: https://github.com/orgs/.../projects/N
  Issues to close: [42]
```

Delete resources by hand:
```bash
gh project delete <NUMBER> --owner <ORG_OR_USER>
gh issue close <NUMBER> --repo <OWNER/REPO>
```

Leftover boards from failed runs are searchable by the `gbs-e2e-` title prefix.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `gh: Not logged in` | `gh` not authed | `gh auth login` |
| `missing project scope` | Token lacks scope | `gh auth refresh -s project,repo` |
| `detectRepo: not a git repo` | CWD is not a git repo | Run from the repo root |
| Bootstrap asserts `projectId` doesn't start with `PVT_` | GQL rate-limit or permission | Wait and retry; check org settings allow Projects v2 creation |
| Teardown fails with `404` | Project already deleted | Safe to ignore; no action needed |
