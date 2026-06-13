# Configuration

A `board.json` binds the skill to your board. Run `doctor` to discover the IDs.

```jsonc
{
  "owner":         "deocracy",            // repo/project owner login (org or user)
  "ownerType":     "organization",        // "organization" or "user"
  "projectNumber": 23,                    // the project number (visible in the URL)
  "projectId":     "PVT_…",              // Project v2 node id (found by doctor)
  "repo":          "deocracy/your-repo",  // owner/repo slug
  "stageFieldId":  "PVTSSF_…",           // the Stage single-select field id
  "stageOptions":  {                      // lane label → option id map
    "Ideas":    "…optionId",
    "Building": "…optionId",
    "Shipped":  "…optionId"
  },
  "preset":   "build",                    // or "grants" — selects the lane shape template
  "routing":  { "agent": "agent:go", "human": "needs-claude" },  // 🤖/🧍 labels (optional, these are the defaults)
  "projectUrl": "https://github.com/orgs/your-org/projects/23",  // full GitHub project URL (for links in output)
  "pushPolicy":    "on-approval",         // writes only happen after explicit user OK
  "pullCadence":   "session-start",       // when to pull a fresh board digest
  "sources": {
    "watch":   [],                        // glob patterns for source files to watch (sync + PostToolUse)
    "disable": []                         // patterns to exclude from scanning
  },
  "snapshots": {
    "keep": 50                            // how many pruned save-points to retain (log.jsonl is never pruned)
  },
  "rules": {
    "maxLanes":                8,
    "useTags":                 false,     // tag-based routing (false = label-based, the default)
    "defaultOwner":            "human",
    "granularity":             "fine",
    "escalateConfidenceBelow": 0.6,
    "escalateBatchOver":       12,
    "promoteConfidenceBelow":  0.8
  }
}
```

## Key sections

### `sources`

Controls the `sync` verb and the PostToolUse real-time hook.

- **`watch`** — glob patterns for source files the skill tracks (e.g. `["TODO.md", "docs/plans/**/*.md"]`). When any watched file changes mid-session, a one-line note appears as the cue to offer `sync scan`.
- **`disable`** — patterns to exclude from scanning (e.g. `["node_modules/**"]`).

### `snapshots`

Controls the `snapshot` family.

- **`keep`** — how many pruned full-board save-points to retain. The permanent event log (`log.jsonl`) is **never** pruned regardless of this setting.

### `rules`

Fine-tunes routing and confidence thresholds.

- **`useTags`** — when `false` (default), routing uses GitHub labels. Set to `true` to use GitHub tags instead.
- **`maxLanes`** — maximum number of lanes; `doctor` warns if the board exceeds this.
- **`defaultOwner`** — `"human"` or `"agent"`. Cards with no explicit owner signal are routed here.
- **`granularity`** — `"fine"` (one card per work item) or `"coarse"` (batched cards).
- **`escalateConfidenceBelow`** — route confidence threshold below which the skill escalates to the human queue.
- **`escalateBatchOver`** — batch size above which routing is always escalated regardless of confidence.
- **`promoteConfidenceBelow`** — confidence threshold below which `promote` pauses for confirmation.

### `stageOptions` and `preset`

`stageOptions` maps each lane name to its GitHub option ID. `preset` names the lane-shape template (`build` or `grants`) used by `reshape` and `doctor`. The IDs are board-specific and discovered by `doctor` — never hand-copy them.

## Lane presets (project-agnostic formats)

Lanes are **read from a preset**, so board formats are reusable across projects with no code change. A preset is a lane-shape *template* stored as data in [`presets/`](../presets); `board.json` just names which one a board uses (`"preset": "grants"`), and `doctor` binds the preset's lane names to that board's live option IDs.

Bundled presets:

- **build** (software): Ideas → Researching → Building → Review → Shipped → Rejected (learnings kept)
- **grants / paperwork** (`kind: non-software`): Intake → Drafting → Needs-info → Ready-to-submit → Submitted → Awaiting-decision → Awarded / Rejected

**Make your own:** copy `presets/build.json` to `presets/<your-format>.json`, edit the lanes, set `"preset": "<your-format>"` in `board.json`, run `doctor`, then `reshape`. Full guide: [`presets/README.md`](../presets/README.md). The board *view* grouping is the one-time human step in [Installation](Installation); `reshape` handles the data part.

## Auth & secrets

The skill uses `gh`'s stored credentials. **Never** put a token in `board.json` or commit one. See `.gitignore` — the local state file and any `.env` are excluded.
