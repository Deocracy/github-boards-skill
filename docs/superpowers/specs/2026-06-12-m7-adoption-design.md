# M7 "Adoption" — Design Spec

**Date:** 2026-06-12
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M7 of the github-boards buildout — the go-to-market milestone. The software (M1–M6) is shipped; M7 makes strangers find it, trust it, and install it.
**Predecessors:** [M6 spec](2026-06-11-m6-verification-design.md) · [M5 spec](2026-06-11-m5-skill-layer-design.md)

---

## 1. Purpose

The repo is excellent on the inside and invisible from the outside: zero GitHub topics, no releases, an empty Wiki tab, no demo, and a README intro written in our internal dialect ("six milestones shipped (M1–M6), 423 tests") that tells a stranger nothing. M7 turns the repo into a storefront and puts it in front of the people who already have what they need to use it.

**Audience (decided):** people who already use a coding agent (Claude Code first; Codex/Cursor/etc. via the `AGENTS.md` mirror) **and** already live on GitHub. The README sells exactly one thing: *your agent can drive your real board, safely.* It never sells Claude Code or GitHub themselves.

**Success criteria:**
1. The README's first screen has zero internal jargon and answers, in order: what it does for me → show me (animated demo) → how do I install (two commands) → what can I say to it.
2. Listed in Anthropic's official plugin directory and ≥3 community directories + ≥1 awesome-list.
3. A publish-ready Deocracy project-page draft exists.
4. Channel performance is checkable (traffic/clones/stars, manually).

**Decided posture (Q&A + research):**
- **Channels:** Tier 0 (storefront — prerequisite), Tier 1 (official Anthropic directory via `clau.de/plugin-directory-submission`, review bar incl. quality + security), Tier 2 (claudemarketplaces.com, tonsofskills, agentskills.io/netresearch — the AGENTS.md-native fit, awesome-claude-code lists), plus a **Deocracy website project-page draft**. NO social/forum launch in M7 (Tier 3 deferred; revisit after the directory listing exists).
- **Hero demo:** a hand-authored **animated terminal SVG** generated from a REAL `--staged` transcript (authentic text, no recording tooling, ~tiny, regenerable), with a static `<details>` transcript fallback beneath it.
- **Operator checkpoints** (the GBS_LIVE pattern, applied to marketing): the live E2E run precedes the official submission; the submission form, the social-preview upload, and the wiki-remote push are human-executed with everything prepped.

## 2. Scope

### In scope
**Phase A — the storefront (Tier 0; everything else waits on it):**
- README rewrite to the first-screen architecture (§3) — hook, demo, install, say-table above the fold; trust/pipeline/composability/status below; no M-codenames anywhere.
- `assets/demo.svg` — animated terminal demo built from a real staged transcript; `assets/social-preview.png` source (1280×640) for the Settings upload.
- Repo metadata via `gh`: ~8 topics; homepage URL set to the GitHub wiki initially, swapped to the Deocracy project page when it publishes; a **v0.2.0 GitHub release** with user-facing notes.
- Wiki publish: prep the `*.wiki.git` push (content already exists in `wiki/`); human runs the push (or grants it).
- Community-health files: `CONTRIBUTING.md` (dev setup, npm test, GBS_LIVE/GBS_EVAL contributor rules, the docs-drift rule), `SECURITY.md`, two issue templates (bug / board-setup help).
- **README drift gate:** extend `tests/skill-evals.test.mjs` so the CLI verb families must appear in README's say-table section — the storefront joins the drift surface.

### In scope, Phase B — distribution (after A merges):
- `docs/marketing/OFFICIAL-SUBMISSION.md` — paste-ready package for the official form (URLs, description, category, scope-of-access + security notes, asset links, resubmission log section). Preconditions stated inside: operator live E2E run, then operator files the form.
- Community submissions, each by its real mechanism (verified at execution): agentskills.io/netresearch PR (leads with the AGENTS.md open-standard fit), tonsofskills PR, claudemarketplaces.com (form or PR — TBD at execution), 1–2 awesome-claude-code list PRs. GitHub-native ones I open directly from a fork; account-required ones convert to drafted-for-you checklist items. All submissions carry the same canonical install snippet.

### In scope, Phase C — Deocracy + measurement:
- `docs/marketing/deocracy-project-page.md` — publish-ready, stack-agnostic markdown draft (hero, plain-language what-it-does, demo embed, install commands, trust paragraph, link block).
- `docs/marketing/MEASUREMENT.md` — the operator's funnel-reading notes (`gh api …/traffic/views|clones`, stars, per-directory counters). Manual, no automation.

### Out of scope (deferred)
- Tier 3 social/forum launch posts (drafted later, after the official listing exists).
- The MCP server (ROADMAP "Next" item — a future adoption multiplier, not M7).
- Site implementation on deocracy.org (we deliver the draft only).
- Analytics automation/dashboards.
- Paid promotion of any kind.

## 3. The README architecture (the heart of Phase A)

```
[h1 + one-line hook]      "Your coding agent can drive your real GitHub Projects board —
                           by conversation, with a preview before every change."
[badges]                  MIT · tests passing · works with Claude Code (+AGENTS.md agents)
[assets/demo.svg]         ~12s loop: user line → staged preview → approval → report-back
                          <details> static transcript fallback </details>
[Install]                 the two /plugin commands, verbatim, copy-pastable
[What you can say]        6–8 rows: put/queue/move/route/promote-the-backlog/sync-my-TODOs/
                          what-changed/undo-since — user phrase → what happens
──────────────── below the fold ────────────────
[Why it's safe]           staged preview before EVERY write · fail-closed · board never
                          written silently · owner-routing explained (🤖/🧍)
[The pipeline]            for power users: sync → ledger → map → promote; reconcile +
                          time-travel as maintenance loops (condensed, links to wiki)
[Works with other agents] the AGENTS.md mirror, agentskills-standard note
[Composable]              calling it from other skills (link COMPOSABILITY.md)
[Prerequisites + setup]   gh auth, Node 18+, doctor checklist (kept from current README)
[Project status]          plain words: actively maintained, fully tested (one live-hardening
                          pass remaining), links to ROADMAP/runbook — no codenames
```

Demo SVG mechanics: run the real verbs (`put --staged`, approval, `summary`) against the mock engine to capture authentic say-lines; hand-author the SVG with CSS keyframe typing/reveal animations; header comment documents the regeneration recipe. Committed asset, no build step.

## 4. Components & deliverables

| Unit | Phase | Responsibility | Owner |
|---|---|---|---|
| README.md rewrite | A | The storefront (§3). | me |
| `assets/demo.svg` + `assets/social-preview.png` | A | Hero demo + the 1280×640 social card. | me (creation) / **you** (Settings upload) |
| Repo metadata + v0.2.0 release | A | Topics, homepage, release notes via `gh`. | me |
| Wiki publish prep | A | Commands/content to push `wiki/` → `github-boards-skill.wiki.git`. | me (prep) / **you** (push) |
| CONTRIBUTING / SECURITY / issue templates | A | Trust + contributor surface; carries the docs-drift and GBS_* rules. | me |
| README drift gate | A | `skill-evals` extension: verb families must appear in README. | me |
| `docs/marketing/OFFICIAL-SUBMISSION.md` | B | Paste-ready official-directory package + resubmission log. | me (package) / **you** (live E2E run, then form) |
| Community-directory submissions | B | agentskills/netresearch PR, tonsofskills PR, claudemarketplaces (mechanism TBD), awesome-list PRs. | me where GitHub-native / drafted for you otherwise |
| `docs/marketing/deocracy-project-page.md` | C | Publish-ready stack-agnostic page draft. | me |
| `docs/marketing/MEASUREMENT.md` | C | Manual funnel-reading notes. | me (notes) / **you** (running them) |

## 5. Error handling (the marketing equivalent)

- **Official review rejects/requests changes** → findings land as normal fix commits; the OFFICIAL-SUBMISSION.md resubmission log records what changed; resubmit. No claim in any submitted copy may exceed what the code does (the drift-gate philosophy applied to marketing prose).
- **A directory's mechanism differs from research** (form vs PR, extra requirements) → the plan's row adapts at execution and reports the reality; nothing silently dropped.
- **Truth maintenance** → README joins the drift surface (the new gate); CONTRIBUTING states the rule: verb changes update the say-table and demo SVG in the same PR; version bumps trigger a listings re-check.
- **No overclaiming the status** → the storefront says "one live-hardening pass remaining" until your live E2E run passes; flips to plain "fully tested incl. live" after.

## 6. Testing / verification

1. **README drift gate** (deterministic, in `npm test`): every CLI verb family token appears in the README; the install snippet block present verbatim; the demo asset path referenced exists.
2. **SVG sanity:** the demo's text content comes from a captured real transcript (kept beside the asset as `assets/demo-transcript.txt` for diffing); a unit check asserts the SVG file parses as XML and references no external resources.
3. **Link check (one-shot, at execution):** every URL in README/marketing docs resolves (manual or scripted once — no CI cron).
4. **Human acceptance:** you read the README cold and the first screen answers what/show/install/say without scrolling — the actual success bar.

## 7. Module context

| Module | What it is | Status |
|---|---|---|
| M1–M6 | The software: engine → brain → pipeline → maintenance → skill layer → verification | ✅ shipped |
| **M7 · Adoption** *(this spec)* | Storefront, official + community distribution, Deocracy page draft | designing |
| Deferred | Tier 3 launch posts · MCP server · `snapshot restore` | backlog |
