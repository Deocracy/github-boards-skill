# Community-Directory Submission Kit

**Canonical short blurb (keep identical everywhere):**
> Conversational GitHub Projects v2 board for coding agents: file/move/route cards by talking, staged preview before every write, agent-vs-human queues, pipeline batching with dedup, drift healing, and snapshot-based undo. MIT, zero runtime deps, vendor-neutral via AGENTS.md.

Install commands (identical in every entry):
```
/plugin marketplace add deocracy/github-boards-skill
/plugin install github-boards@github-boards-skill
```

Repo: https://github.com/Deocracy/github-boards-skill

---

## 1. netresearch/claude-code-marketplace → agentskills.io

**Mechanism:** PR against `netresearch/claude-code-marketplace` — add one JSON object to `.claude-plugin/marketplace.json`. No CONTRIBUTING.md exists at the repo root; the submission format is documented in the README's "Adding a Skill" section. The file accepts only: `name`, `description`, `source` (sub-keys: `source`, `repo`), `category`. CI validates the JSON; the catalog is regenerated automatically.

**Verified at:** https://github.com/netresearch/claude-code-marketplace (README § "Adding a Skill")

**Status:** - [ ] PR not yet opened — operator approval required before filing

**Executor:** Agent may open the PR only after explicit user approval.

---

### marketplace.json entry (paste-ready)

```json
{
  "name": "github-boards",
  "description": "Conversational GitHub Projects v2 board for coding agents: file/move/route cards by talking, staged preview before every write, agent-vs-human queues, pipeline batching with dedup, drift healing, and snapshot-based undo. MIT, zero runtime deps, vendor-neutral via AGENTS.md.",
  "source": {
    "source": "github",
    "repo": "Deocracy/github-boards-skill"
  },
  "category": "productivity"
}
```

---

### PR description draft

```
## Add github-boards skill — conversational GitHub Projects board

**Repo:** https://github.com/Deocracy/github-boards-skill  
**Install:**
    /plugin marketplace add deocracy/github-boards-skill
    /plugin install github-boards@github-boards-skill

### Why it fits the agentskills.io open-standard story

The skill's instruction body is vendor-neutral and mirrored verbatim to `AGENTS.md` at the repo root — agents that read the AGENTS.md convention (Codex, Cursor, Gemini CLI, Copilot, and friends) get the exact same contract without any Claude-specific wrapper. All board logic lives in bundled Node scripts with zero runtime dependencies; the skill file is a thin routing layer. That is exactly the portability story agentskills.io was built to showcase.

### What it does

Drive a real GitHub Projects v2 Kanban board by conversation:
- `put` — file cards with staged preview + explicit approval before any write
- `queue` — your 🧍 queue vs the 🤖 agent queue
- `move` / `route` / `reject` — lane moves, owner re-routing, terminal lanes
- `sync` → `map` → `promote` — batch pipeline with dedup ledger (nothing files twice)
- `snapshot` + `reconcile` — drift healing and time-travel undo (never touches the board directly)

### Quality bar

- 420+ deterministic tests; a multi-session simulation harness with crash recovery and seeded soak
- Docs are drift-gated (CLI help ↔ SKILL.md ↔ AGENTS.md ↔ README enforced by tests)
- MIT license, SECURITY.md, CONTRIBUTING.md, full issue templates
- Every board write is staged-previewed and fail-closed; no bundled credentials; hooks are read-only toward GitHub
```

---

## 2. jeremylongshore/claude-code-plugins-plus-skills → tonsofskills.com

**Mechanism:** Path B (recommended for external repos) — open a PR against `jeremylongshore/claude-code-plugins-plus-skills` that adds one entry to `sources.yaml`. Their repo stays the source of truth; a weekly sync (Mondays 06:00 UTC) pulls the latest content and opens an automated PR. A maintainer can trigger an immediate sync via `gh workflow run sync-external.yml`. Do NOT hand-edit the README — the category tables are auto-generated.

**Submission bar:** Full-capability, enterprise-grade: SKILL.md with complete frontmatter, README, LICENSE, and a score ≥ threshold on their 100-point rubric. Validator: `python3 scripts/validate-skills-schema.py --marketplace --verbose plugins/community/github-boards/` (run locally before opening the PR using their `./scripts/quick-test.sh`). Our SKILL.md carries the required `name`, `description`, and `allowed-tools` frontmatter; their optional `version` and `author` fields have been added (v0.2.0 / Deocracy Institute) — confirm with the validator before filing.

**Verified at:** https://raw.githubusercontent.com/jeremylongshore/claude-code-plugins-plus-skills/main/CONTRIBUTING.md (§ "Path B — Auto-sync from your own repo")

**Status:** - [ ] PR not yet opened — operator approval required before filing

**Executor:** Agent may open the PR only after explicit user approval.

---

### sources.yaml entry (paste-ready, add to sources.yaml in their repo)

```yaml
- name: github-boards
  description: 'Conversational GitHub Projects v2 board for coding agents: file/move/route cards by talking, staged preview before every write, agent-vs-human queues, pipeline batching with dedup, drift healing, and snapshot-based undo. MIT, zero runtime deps, vendor-neutral via AGENTS.md.'
  repo: Deocracy/github-boards-skill
  source_path: .
  target_path: plugins/community/github-boards
  author:
    name: Christopher Colantuono
    github: Deocracy
    email: christopher@deocracy.org
  license: MIT
  category: community
  verified: true
  include:
    - 'skills/**'
    - 'scripts/**'
    - 'commands/**'
    - 'hooks/**'
    - 'presets/**'
    - '.claude-plugin/**'
    - 'AGENTS.md'
    - 'README.md'
    - 'LICENSE'
    - 'board.example.json'
  exclude:
    - 'docs/**'
    - 'tests/**'
    - 'wiki/**'
    - 'evals/**'
    - 'node_modules/**'
    - '.git/**'
    - 'assets/**'
```

---

### PR description draft

```
## Add github-boards (Path B auto-sync) — conversational GitHub Projects board

**Source repo:** https://github.com/Deocracy/github-boards-skill  
**Install:**
    /plugin marketplace add deocracy/github-boards-skill
    /plugin install github-boards@github-boards-skill

### What it does

Drive a real GitHub Projects v2 Kanban board by conversation. Staged preview before every write; agent-vs-human routing (🤖/🧍 queues); batch pipeline with dedup ledger; drift healing; and snapshot-based time-travel undo.

Full verb set: `put` `queue` `move` `route` `reject` `followup` `sync` `map` `promote` `ledger` `reconcile` `snapshot` `reshape` `bootstrap` `summary`.

### Quality

- MIT license, zero runtime dependencies
- SKILL.md with full frontmatter; README; CONTRIBUTING.md; SECURITY.md; issue templates
- 420+ deterministic tests (multi-session simulation harness, crash recovery, seeded soak)
- Docs drift-gated by tests (CLI help ↔ SKILL.md ↔ AGENTS.md ↔ README)
- Vendor-neutral: instruction body mirrored to AGENTS.md — works with Claude Code, Codex, Cursor, Gemini CLI
```

---

## 3. claudemarketplaces.com

**Mechanism:** Fully automated — no submission form, no PR path. Crawlers sweep GitHub on a schedule and refresh installs, stars, and metadata. **Threshold:** 500+ installs required to be listed. Listings that don't meet the threshold do not surface. An editor manually reviews and curates featured picks after auto-discovery.

**Evidence:** The About page states: "Crawlers sweep skills.sh, GitHub, and the MCP registries on a schedule, refreshing installs, stars, and metadata across every listing. Skills need 500+ installs to be listed; stars and registry signals rank everything else." The `/submit` and `/contact` endpoints both return 4xx — there is no submission path.

**TLS note:** `www.claudemarketplaces.com` returns `ERR_TLS_CERT_ALTNAME_INVALID` (www subdomain not on the cert); `claudemarketplaces.com` (no www) resolves correctly.

**Status:** - [ ] No action needed now — will auto-list once install count clears 500. Monitor with:
```bash
gh api repos/Deocracy/github-boards-skill/traffic/clones
```

**Executor:** N/A — automated. No operator action until threshold is met.

---

## 4. hesreallyhim/awesome-claude-code (46 k stars, active as of 2026-06-12)

**Mechanism:** GitHub issue — human must open the issue at the GitHub.com web UI using the `recommend-resource.yml` template. The `gh` CLI is **explicitly blocked** by the bot (submissions via CLI are auto-closed and counted against the submitter). A bot validates the issue, a maintainer reviews, and if approved the bot opens the PR automatically. Direct PRs adding resources are also blocked ("ONLY THE BOT MAY DO THIS").

**Verified at:** https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main/docs/CONTRIBUTING.md and the `recommend-resource.yml` issue template.

**Submission URL (human opens in browser):**
https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml

**Status:** - [ ] Not yet submitted — operator must open the issue manually in a browser (gh CLI will be auto-rejected)

**Executor:** Operator only — this target explicitly requires a human using the GitHub.com web UI.

---

### Issue form content (paste-ready for each field)

**Issue title:**
```
[Resource]: GitHub Boards — conversational GitHub Projects v2 board skill
```

**Category:** Agent Skills

**Sub-Category:** Project Management *(verify: "Project Management" may not exist as a sub-category option in the form UI — confirm the available choices when filling out the form; the closest verified option from the kit's research is "Agent Skills" as the primary category)*

**Display Name:**
```
GitHub Boards
```

**Primary Link:**
```
https://github.com/Deocracy/github-boards-skill
```

**Author Name:** Christopher Colantuono

**Author Link:** https://github.com/Deocracy

**License:** MIT

**Description (1–3 sentences, no emojis, descriptive not promotional):**
```
Conversational GitHub Projects v2 board skill: file, move, route, and reject cards by talking to an agent, with a staged preview required before every write. Supports agent-vs-human queue routing, a batch dedup pipeline (sync → map → promote), drift healing via reconcile, and time-travel undo via board snapshots with a permanent change journal. MIT, zero runtime dependencies, vendor-neutral instruction body mirrored to AGENTS.md.
```

**Install command:**
```
/plugin marketplace add deocracy/github-boards-skill
/plugin install github-boards@github-boards-skill
```

**Validate Claims (mandatory for skills):**
```
Install the skill and ask Claude: "set up a board for this repo." The skill runs `bootstrap --staged`, previews the board structure it would create (columns, labels, routing), and waits for approval — nothing is written until you say yes.
```

**Specific Task:**
```
Install the skill, then say: "put these on the board: fix the login redirect bug (for Claude), renew the grant paperwork (for me)." The skill previews both cards staged, reports which queue each goes to, then asks for approval before filing.
```

**Specific Prompt:**
```
"put these on the board: fix the login redirect bug (for Claude), renew the grant paperwork (for me)"
```

---

## Submission order (recommended)

> **Eligibility note:** awesome-claude-code requires the repo to have been public for more than 1 week before submission. This repo went public 2026-06-08; the earliest eligible submission date is approximately **2026-06-15**.

1. **tonsofskills.com** — operator approves, agent opens the sources.yaml PR
2. **agentskills.io** — operator approves, agent opens the marketplace.json PR
3. **awesome-claude-code** — operator opens the browser issue form manually (not before ~2026-06-15)
4. **claudemarketplaces.com** — no action; monitor install count, auto-lists at 500+
