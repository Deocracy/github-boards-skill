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
  "routing":  { "agent": "agent:go", "human": "needs-claude" }  // 🤖/🧍 labels (optional, these are the defaults)
}
```

## Lane presets (project-agnostic formats)

Lanes are **read from a preset**, so board formats are reusable across projects with no code change. A preset is a lane-shape *template* stored as data in [`presets/`](../presets); `board.json` just names which one a board uses (`"preset": "grants"`), and `doctor` binds the preset's lane names to that board's live option IDs.

Bundled examples:

- **build** (software): Ideas → Researching → Building → Review → Shipped → Rejected (learnings kept)
- **grants / paperwork** (`kind: non-software`): Intake → Drafting → Needs-info → Ready-to-submit → Submitted → Awaiting-decision → Awarded / Rejected

**Make your own:** copy `presets/build.json` to `presets/<your-format>.json`, edit the lanes, set `"preset": "<your-format>"` in `board.json`, run `doctor`, then `reshape`. Full guide: [`presets/README.md`](../presets/README.md). The board *view* grouping is the one-time human step in [Installation](Installation); `reshape` handles the data part.

## Auth & secrets

The skill uses `gh`'s stored credentials. **Never** put a token in `board.json` or commit one. See `.gitignore` — the local state file and any `.env` are excluded.
