# Operator checklist — publishing surfaces

## 0. After merge: tag + release (operator or agent on main)

Run these commands **after the feat/m7-adoption branch is merged to main** — not before (the release tag must point to main HEAD).

```bash
git tag v0.2.0
gh release create v0.2.0 --title "v0.2.0 — the conversational board, complete" --notes "Drive a GitHub Projects v2 board by conversation from Claude Code (or any AGENTS.md-reading agent): file/move/route/reject cards with a staged preview before every write, batch work through a dedup'd pipeline (sync → map → promote), heal drift without touching the board, and time-travel — snapshots, a permanent change journal, and a computed undo plan.

- Install: \`/plugin marketplace add deocracy/github-boards-skill\` then \`/plugin install github-boards@github-boards-skill\`
- Safety: every write previewed + approved; fail-closed; your gh credentials stay yours
- Fully tested: deterministic simulation harness (crash recovery, multi-session soak); live suite is operator-gated
- Works beyond Claude Code via the vendor-neutral AGENTS.md mirror"
```

## 1. Wiki tab (one-time)

The `wiki/` folder ships in-repo; GitHub's Wiki tab is a separate git repo. To publish:

```bash
git clone https://github.com/Deocracy/github-boards-skill.wiki.git ../gbs-wiki
cp wiki/*.md ../gbs-wiki/
cd ../gbs-wiki && git add -A && git commit -m "Publish wiki from repo wiki/ folder" && git push
```

Re-run after any `wiki/` change (or decide the in-repo folder is canonical and the tab is a mirror).

## 2. Social preview (one-time, Settings UI only)

Repo → Settings → General → Social preview → upload `assets/social-preview.png` (1280×640).

## 3. After the live E2E passes

Flip the README "Project status" line from "one live-hardening pass remaining" to "fully tested, including live" (same PR as any fixes the run surfaces).
