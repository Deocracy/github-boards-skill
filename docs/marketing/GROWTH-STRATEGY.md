# Growth Strategy — getting github-boards-skill found, starred, and used

*Evidence-based; sources cited inline. Numbers marked "ballpark" are web-derived estimates, not live Google Keyword Planner data — run the API spec in §6 for exact figures.*

---

## 0. TL;DR

- **Google Ads is the wrong primary channel for this project, and broad paid search would mostly waste money.** A free MIT plugin has no revenue conversion to optimize against; the truly qualified audience (people who already run Claude Code **+** GitHub **+** `gh`) is tiny and hard to target; developers block ads at 40–60%; and a raw GitHub repo is a poor, partly non-compliant ad destination.
- **The growth comes from organic developer channels — most of which we already prepared in the M7 adoption kit.** Ranked by return: the official Anthropic plugin directory → awesome-claude-code → a Show HN launch → Reddit/X with a demo → a search-optimized blog post → community directories.
- **If you still want to spend the ad budget, there is exactly one defensible way** (§5): a tiny exact-match Search campaign pointed at a *real hosted landing page* (not the repo), behind proper conversion tracking. It will be cheap but low-volume, and it must not run until the landing page + tracking exist.
- **The Google Ads API is genuinely useful here — but for SEO, not ads.** Use its keyword research (§6) to find the phrases real people search, then put those phrases in the README, the blog post, and GitHub topics. That compounds; an ad disappears the moment billing stops.

---

## 1. The honest verdict on Google Ads

Five independent research passes converged on the same conclusion. The load-bearing facts:

- **No conversion event to optimize.** Google's bidding optimizes toward conversions (signups, purchases, leads). Our "conversion" is a GitHub star or a CLI install — **neither can fire a Google pixel.** You cannot place a tag on github.com, and a `claude plugin install` happens in a terminal with no remote event. The best trackable proxy is "clicked through to GitHub from our landing page" (§4) — a weak signal for Smart Bidding, which also needs ~30–50 conversions/month to even function.
- **The PostHog precedent.** PostHog (the most analytically transparent dev-tool company) tried Google Display and developer ad networks (Carbon Ads) and **dropped all of them**, keeping only Google Search for defending their own brand name. A free OSS plugin has far less justification than a VC-funded SaaS. (posthog.com/handbook/marketing/paid)
- **Adblock.** Developers run ad blockers at 40–60% vs ~30% general population — half your target audience never renders the ad. (backlinko.com/ad-blockers-users)
- **The keyword economics are broken** (§2). Every keyword cluster is either the wrong audience (enterprise PM SaaS shoppers at $8–$20 CPC) or the right audience at near-zero volume.
- **Cost per outcome.** At a realistic ~$1.50 CPC and ~2% click-to-GitHub rate, that is **~$75 per GitHub page-visit** — and a page-visit is not a star. For a free tool, that math never closes.

This is not "ads are bad." It's that *this* product, at *this* stage, with *this* audience, is the textbook case where paid search underperforms organic.

---

## 2. Keyword landscape (why broad paid search misfires)

Ballpark figures (web-derived; confirm via §6):

| Cluster | Monthly volume | CPC | Audience fit | Verdict |
|---|---|---|---|---|
| `claude code plugin` / `claude code skill` | <1K–2K | **$1–$4** | **Perfect** (existing Claude Code users) | Only defensible cluster — but volume too small to move the needle alone |
| `github projects automation` / `github project management` | 1K–10K | $3–$8 | Moderate (GitHub users, but informational intent) | Marginal — high bounce, tiny volume |
| `ai kanban board` / `kanban automation` | 500–3K | $4–$10 | Poor (SaaS comparison shoppers) | Wrong buyer |
| `ai project management tool/software` | 10K–100K | **$8–$20** | **Very poor** (enterprise SaaS evaluators) | **Where money burns** — never bid here |
| `ai agent task management` | 5K–50K | $5–$15 | Mixed (heavy bleed to workflow-automation SaaS) | Needs heavy negative-keyword filtering |

The product's differentiation — **it drives a real GitHub Projects v2 board via the API, not local markdown files** — must lead every message. The Claude-Code-kanban space is already crowded with markdown-based tools (kanban-skill, claude-kanban, KANBAII, etc.); without that one-line distinction, even good traffic bounces to a simpler alternative.

---

## 3. What actually gets it starred — the real plan (ranked by ROI)

**Tier 1 — free, highest leverage, do first (most already prepped in M7):**

1. **Official Anthropic plugin directory** (`anthropics/claude-plugins-official`, 20K+ stars, launched May 2026). In-product discovery at the exact moment of install intent. This is the single highest-leverage action. Package ready: [OFFICIAL-SUBMISSION.md](OFFICIAL-SUBMISSION.md). *Precondition: your live E2E run.*
2. **awesome-claude-code** (`hesreallyhim/awesome-claude-code`, 36.8K stars). Permanent, compounding referral. Browser-only issue form; eligible ~June 15 (1-week-public rule). Content ready: [SUBMISSIONS.md](SUBMISSIONS.md).
3. **Show HN on Hacker News.** A front-page finish averages ~289 stars in week one (arXiv 2511.04453, study of 138 AI-tool launches; median lower — most see 50–150). Frame on differentiation: *"Show HN: A Claude Code skill that drives real GitHub Projects v2 boards by conversation — live API, not markdown files."* Best window: Tue–Thu, 9 AM–12 PM ET.
4. **Reddit** r/ClaudeAI + r/programming with a demo GIF (the `assets/demo.svg` story as a screen recording). Zero cost, concentrated audience.

**Tier 2 — low cost / low effort, compounding:**

5. **X/Twitter thread** with the demo GIF; notify 5–10 accounts in the Claude Code / MCP / agentic-coding niche. A single retweet from a ~10K-follower dev account can drive 300–800 stars (dev.to 2026 star-growth analysis).
6. **One search-optimized blog post** on dev.to + a Deocracy blog: *"Automate GitHub Projects v2 from Claude Code with natural language."* SEO median ROI ~748% and it compounds; this is where the §6 keyword research pays off. Target phrases: "automate github projects", "claude code github kanban", "github projects cli agent".
7. **Community directories**: tonsofskills, agentskills.io/netresearch, claudemarketplaces (auto-crawl at 500+ installs). Mechanisms verified in [SUBMISSIONS.md](SUBMISSIONS.md).

**Tier 3 — only with budget, only after Tier 1–2:**

8. A small developer-newsletter mention (5K–40K-subscriber lists at $200–$2K beat a $15K TLDR slot for an OSS tool). Newsletters bypass adblock. Wait until the star count can anchor the mention.

**Ignore entirely:** Google Display, Carbon Ads, Facebook/Instagram, LinkedIn Ads, and — absolutely — any "buy stars" service (GitHub purged 90%+ of flagged fake-star repos by Jan 2025; it destroys credibility and ranking).

---

## 4. What's measurable (and what isn't)

Hard platform constraints, not tooling gaps:

- **Stars and CLI installs are unmeasurable as ad conversions.** No pixel on github.com; no remote event on a terminal install.
- **GitHub's referrers panel shows the referring *domain only*** (e.g. `deocracy.org`), never the UTM campaign — a browser Referrer-Policy limitation, and the window is only 14 days.
- **The measurable ceiling** is on *your own* landing page: sessions by campaign/keyword (GA4) and an **outbound "View on GitHub" click** marked as a conversion. That is the honest proxy — directionally correlated with stars, not equal to them.

This is *the* reason a self-hosted landing page is mandatory for any paid spend: it is the only surface where you own a pixel.

---

## 5. If you run ads anyway — the one defensible campaign

Do **none** of this until the prerequisites are met. In order:

**Prerequisites (a hard gate):**

1. **Publish a real landing page** on a Deocracy domain (e.g. `deocracy.org/github-boards`). The content already exists in [deocracy-project-page.md](deocracy-project-page.md); wrap it in a dev-tool landing structure (the free MIT *LaunchKit* template, launchkit.evilmartians.io, does exactly this in a few hours). **Never point ads at the raw repo** — Google's destination policy may disapprove it (crawlability/"insufficient original content"), Quality Score suffers, and you own no pixel there.
2. **Add GA4 with Enhanced Measurement**, then a custom event `github_click` = a `click` whose `link_url` contains `github.com/Deocracy/github-boards-skill`; mark it a conversion. Link GA4 ↔ Google Ads; turn on auto-tagging (GCLID); import `github_click` as the Ads conversion.
3. **Confirm `robots.txt` on the landing domain allows `AdsBot-Google`** — the #1 disapproval cause for non-ecommerce advertisers.

**The campaign:**

- Type: **Search only.** No Display, no Performance Max (it removes keyword control).
- Bidding: **Manual CPC** or Maximize Clicks (volume is too low for Smart Bidding's 30–50 conv/mo minimum).
- Keywords: **exact match only**, the perfect-fit cluster: `[claude code github boards]`, `[claude code project management]`, `[github projects coding agent]`, `[claude code kanban]`. Add the SaaS clusters as **negative keywords** (`-asana -jira -monday -clickup -notion -software`).
- Final URL: the **landing page**, with `utm_source=google&utm_medium=cpc&utm_campaign={campaignid}`.
- Budget: **$50–$100/month exploratory.** Expect low CPC ($0.50–$2) and low volume (single-digit to low-tens of impressions/day). Treat it as a measurement experiment, not a growth engine.
- KPI: **cost per `github_click`** and `github_click` rate. Accept that true install/star attribution is unknowable.

**Trademark landmines (do not skip):**

- **Never** put "Claude", "Claude Code", or "Anthropic" in ad **headlines, descriptions, or display URLs** without Anthropic's written approval. Anthropic registered CLAUDE (Reg. #7645254) and has filed trademark complaints before. You *may* bid on those terms as keywords (Google allows it), but watch for a restriction request.
- Descriptive body copy ("works with Claude Code") is plausibly nominative fair use but carries nonzero risk — get it reviewed if you scale.
- "GitHub" descriptively ("plugin for GitHub Projects") is lower risk; never imply GitHub endorsement.
- **Never** run ad copy that asks users to star the repo — that edges toward incentivized inauthentic activity under GitHub's AUP. And grow gradually: an anomalous star spike correlated with a campaign can trip GitHub's fake-star detection even when the traffic is real.

---

## 6. The Google Ads API keyword-research spec (runnable)

Use this for **SEO and README/blog keyword targeting** — valuable regardless of whether you ever run an ad. (I don't have a Google Ads tool in this session, so this is the hand-off spec to run in your own environment.)

**Service:** `KeywordPlanIdeaService` (Google Ads API v21+; stable through v24 as of 2026).

- `GenerateKeywordHistoricalMetrics` — metrics for a known list (up to 10,000 terms). Use for the seed list below.
- `GenerateKeywordIdeas` — discover adjacent terms from a `keywordSeed` (1–20 terms) or `urlSeed` (your landing page / repo). Use to expand.

**Auth (all four required):**

- OAuth2 access token (`Authorization: Bearer …`).
- `developer-token` header — **must be Basic Access or higher**; a *Test Account* token returns zero/null metrics (~5 business days to get Basic at ads.google.com/aw/apicenter).
- `login-customer-id` (manager account, no hyphens) — omitting it with manager creds → `USER_PERMISSION_DENIED`.
- `customer_id` in the body (no hyphens).

**Recommended request fields:** `language: "languageConstants/1000"` (English), `geo_target_constants: ["geoTargetConstants/2840"]` (US), `keyword_plan_network: GOOGLE_SEARCH`, `historical_metrics_options.year_month_range` for trend. Rate limit: **1 QPS** — batch and back off.

**Outputs per keyword** (`KeywordPlanHistoricalMetrics`): `avg_monthly_searches`, `competition` (LOW/MEDIUM/HIGH), `competition_index` (0–100), `low_top_of_page_bid_micros`, `high_top_of_page_bid_micros` — **divide micros by 1,000,000** for USD.

**Seed list to research (paste into `keywords`):**

```
claude code plugin
claude code skill
claude code github
claude code kanban
claude code project management
github projects automation
github projects cli
github projects v2 api
ai kanban board
github kanban
ai project management agent
agentic project management
github mcp
manage github projects from terminal
automate github projects
```

**Minimal Python (official `google-ads` library):**

```python
from google.ads.googleads.client import GoogleAdsClient

client = GoogleAdsClient.load_from_storage("google-ads.yaml")  # has dev token, OAuth, login-customer-id
svc = client.get_service("KeywordPlanIdeaService")
req = client.get_type("GenerateKeywordHistoricalMetricsRequest")
req.customer_id = "1234567890"  # no hyphens
req.language = "languageConstants/1000"          # English
req.geo_target_constants.append("geoTargetConstants/2840")  # United States
req.keyword_plan_network = client.enums.KeywordPlanNetworkEnum.GOOGLE_SEARCH
req.keywords.extend(open("seeds.txt").read().splitlines())

for r in svc.generate_keyword_historical_metrics(request=req).results:
    m = r.keyword_metrics
    low = (m.low_top_of_page_bid_micros or 0) / 1e6
    high = (m.high_top_of_page_bid_micros or 0) / 1e6
    print(f"{r.text:40} vol={m.avg_monthly_searches or 0:>7} "
          f"comp={m.competition.name:6} cpc=${low:.2f}-${high:.2f}")
```

Feed the high-volume / on-topic results into: the README's first paragraph and headings, the dev.to blog post title/body, and the repo's GitHub topics. **That** is how the keyword research drives stars — through search-visible content, not paid clicks.

---

## 7. Repo / asset changes recommended

- **No structural repo change is needed for ads.** The differentiation hook ("real GitHub Projects v2 API, not markdown") is already in the README first screen.
- **The one repo tweak worth considering:** make the markdown-alternative contrast even more explicit in the README's first lines, since the niche is crowded — a single sentence like *"Unlike markdown-file kanban skills, this drives your actual GitHub Projects v2 board."* (Optional; say the word and I'll add it.)
- **The real work is a separate Deocracy-site workstream**, not a repo change: publish the landing page + GA4 + conversion event (§5 prerequisites). The M7 spec explicitly deferred site implementation and paid promotion — so this is net-new scope, correctly outside the shipped milestone.

---

## 8. Recommended sequence

1. **Now (free, you):** run the Tier-1 organic plan — official directory (after your live E2E), awesome-claude-code (~June 15), Show HN, Reddit. This is where the stars are.
2. **Now (free, me on your go):** the two community-directory PRs already prepped.
3. **Soon (small build):** if you want the ads option alive, stand up the deocracy.org landing page + GA4 + `github_click` conversion. This also strengthens every *organic* link.
4. **Optional, last:** the $50–$100/month exact-match Search experiment (§5) — purely to learn, not to grow.
5. **Anytime:** run the §6 keyword research and fold the winning phrases into the README, blog post, and GitHub topics.

**Bottom line:** spend the Google Ads budget only after the landing page exists, keep it tiny and exact-match, and treat organic developer channels — which we've already armed — as the actual growth engine.
