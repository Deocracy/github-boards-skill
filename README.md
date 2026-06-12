# GitHub Boards — drive your project board by conversation

**Your coding agent can run your real GitHub Projects board.** Tell it *"put these on the board"*, *"what's on my plate?"*, *"undo what happened since this morning"* — it previews every change, writes only with your OK, and reports back.

[![MIT license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-blueviolet)](https://code.claude.com) [![works via AGENTS.md](https://img.shields.io/badge/other%20agents-AGENTS.md-blue)](AGENTS.md) [![Node ≥18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)

![Demo: filing two cards by conversation, with a staged preview and report-back](assets/demo.svg)

<details><summary>Demo as text</summary>

> **You:** put these on the board: fix the login redirect bug (for Claude), renew the grant paperwork (for me)
> **Agent:** Running it staged first — nothing is written yet:
> `Would file 2 card(s): 'Fix login redirect bug' → Ideas (agent); 'Renew grant paperwork' → Ideas (human). On your plate: 1 card(s). Claude's queue: 1 card(s).`
> **Agent:** Look right? (y/n)
> **You:** y
> ✅ `Filed 2 card(s). On your plate: 1 card(s). Claude's queue: 1 card(s).`
> **You:** what's on my plate?
> ✅ `On your plate: 1 card(s). #8 Renew grant paperwork`

</details>

## Install

```
/plugin marketplace add deocracy/github-boards-skill
/plugin install github-boards@github-boards-skill
```

Already have [`gh`](https://cli.github.com) authenticated and Node 18+? You're done — say *"set up a board for this repo"* and the skill walks you through the rest (or see [Prerequisites](#prerequisites)).

**Manual fallback:**

```
git clone https://github.com/deocracy/github-boards-skill ~/.claude/skills-src/github-boards-skill
# then copy skills/github-boards/ into ~/.claude/skills/
```

## What you can say

| You say… | What happens |
|---|---|
| "Put these three tasks on the board" | Files real Issues onto the board (`put`) — after a staged preview you approve |
| "What's on my plate?" / "What is Claude working on?" | Your 🧍 queue vs the 🤖 agent queue (`queue human` / `queue agent`) |
| "Move the API card to Review" / "This one needs me" | Lane moves (`move`) and owner re-routing (`route`) |
| "Reject this, keep the learnings" | Terminal lane + a recorded note (`reject`) |
| "Sync my TODOs onto the board" | Watched files → extraction → ledger (`sync scan` / `sync record`) — nothing touches the board yet |
| "Figure out what belongs on the board" / "Promote the backlog" | The mapper proposes cards (`map`), then `promote` files them — idempotent and resume-safe |
| "What changed this week?" / "Is the board out of sync?" | `summary` diffs since last look; `reconcile` heals ledger drift (never the board) |
| "What did the board look like before the cleanup?" / "Undo what happened since X" | `snapshot` history, diffs, and a computed undo plan (`snapshot invert`) you approve op by op |

Power-user extras: `followup` (file child cards), `reshape` (lane presets), `bootstrap` (provision a board from the current repo), `ledger` (the pipeline's inbox), and `--staged` on any write to preview without committing. Full verb reference: [wiki Usage](wiki/Usage.md).

## Why it's safe to point at your real board

- **Every write is previewed first.** The skill runs verbs staged, shows you the exact cards/lanes/labels, and commits only on your explicit OK. Never a silent write to the board.
- **Fail-closed.** Missing config, ambiguous board, inaccessible project → it stops and says so. It never guesses.
- **Owner-routing is explicit.** 🤖 `agent:go` vs 🧍 `needs-claude` labels say *who should act* — your queue stays real, and human-routed cards escalate with a mention instead of silently parking.
- **History with an undo.** Every session snapshots the board; a permanent journal records what changed; *"undo since X"* computes the exact inverse plan and replays it through the same approval-gated verbs.
- **Your credentials stay yours.** It drives the [`gh` CLI](https://cli.github.com) you already authenticated — no tokens in config files.

## The pipeline (for batch work)

```
TODO.md / plans / other skills' artifacts
   └─ sync ─► intent ledger ─► map (LLM proposes, code validates) ─► promote ─► board
                                      maintenance: reconcile (ledger healing) · snapshots (memory + undo)
```

Direct verbs act immediately; the pipeline batches work through a ledger so nothing files twice and every promotion resumes after a crash. Hooks keep you oriented: a board digest at session start, a one-line note when a watched file changes.

## Works with other agents

The skill's instruction body is vendor-neutral and mirrored to [`AGENTS.md`](AGENTS.md) — agents that read the AGENTS.md convention (Codex, Cursor, and friends) get the same contract. All board logic lives in the bundled scripts, not in any vendor's prompt format.

## Calling it from other skills

Any skill can record work onto the board — *"use the github-boards skill to put these tasks on the board"* — and gets the same staged-preview contract plus a report-back to relay. Contract: [docs/COMPOSABILITY.md](docs/COMPOSABILITY.md).

## Prerequisites

- **[Claude Code](https://code.claude.com)** — the runtime.
- **[GitHub CLI (`gh`)](https://cli.github.com)**, authenticated: run `gh auth login` once. The skill uses your stored credentials — **you never paste a token into a config file.**
- A GitHub token with **`project`** scope (a classic PAT, or a fine-grained PAT with *Projects: read & write*). `gh auth login` can grant this.
- **Node.js 18+** on your PATH. *(Claude Code does not bundle Node; the engine is a Node script.)*
- A **GitHub Project (v2)** board — see *One-time board setup* below.

## One-time board setup (the human step)

GitHub does **not** let any token create or group a board *view* — that's browser-only. So once per board, you (a human) do this in the GitHub UI:

1. Create a **Project (v2)**.
2. Add a **single-select field** named `Stage` with your lane options (e.g. *Ideas, Researching, Building, Review, Shipped, Rejected (learnings kept)* — or your own; see *Configuration*).
3. Set the board **view** to **group by `Stage`**.

The skill's `doctor` command prints this checklist and tells you exactly what's missing. After that, the skill handles everything data-shaped (filing cards, moving lanes, routing, commenting).

## Project status

Actively maintained and fully tested (the whole pipeline runs under a deterministic simulation harness — crash recovery, multi-session lifecycles, a seeded soak). One live-hardening pass against a real board remains before 1.0 — see the [runbook](docs/LIVE-RUNBOOK.md) and [ROADMAP](ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE).
