# Security

## What this skill can touch

- It drives the **`gh` CLI you already authenticated** — GitHub Issues and Projects v2 boards reachable by your token (`project` + `repo` scopes). No tokens are stored in any config file in this repo.
- Local state lives in `.github-boards/` in your working directory (ledger, snapshots, last-seen state) — plain JSON, gitignored by default.
- Every board write is staged-previewed and requires explicit approval; the engine fails closed on missing or ambiguous configuration.
- The hooks are read-only toward GitHub: the session-start hook reads the board to build a digest; the file-watch hook only reads local files.

## Test-tier isolation

`npm test` makes zero network calls. Live tests are skipped unless an operator sets `GBS_LIVE=1` at a terminal; the LLM eval harness is skipped unless `GBS_EVAL=1`. Neither must ever be set by automation.

## Reporting

Found a vulnerability (e.g., a path where a write could land without a preview, or an injection through issue titles/bodies)? Open a GitHub Security Advisory on this repo, or email christopher@deocracy.org. Please don't open public issues for exploitable problems.
