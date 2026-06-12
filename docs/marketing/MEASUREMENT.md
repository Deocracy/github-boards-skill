# Reading the funnel (operator notes)

Manual, whenever curious — no automation.

```bash
gh api repos/Deocracy/github-boards-skill/traffic/views    # 14-day views + uniques (needs push access)
gh api repos/Deocracy/github-boards-skill/traffic/clones   # 14-day clones + uniques
gh api repos/Deocracy/github-boards-skill/traffic/popular/referrers   # WHERE they came from — the channel signal
gh repo view Deocracy/github-boards-skill --json stargazerCount
```

Per-directory counters: check each listing page in docs/marketing/SUBMISSIONS.md (some show install/view counts). Referrers is the most useful: it attributes which channel actually sends people.

Cadence suggestion: look ~weekly for the first month after each submission lands, then whenever.
