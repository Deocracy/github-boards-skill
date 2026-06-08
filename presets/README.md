# Presets — project-agnostic lane formats

A **preset** is a reusable lane-shape *template*. It describes the columns (and optional custom fields) a board should have, and knows nothing about any specific GitHub project. That is what makes board formats **project-agnostic**: define a shape once, reuse it on any number of boards.

## How it fits together

- **Preset (here, in `presets/`)** = the *format* — lane names, order, terminal lanes, owner labels, optional custom fields. Pure data, reusable across projects.
- **`board.json` (per project)** = the *binding* — which GitHub project, plus the live option IDs `doctor` discovered. It names a preset: `"preset": "grants"`.
- **`doctor`** maps the preset's lane *names* to that board's live `Stage` option IDs.
- **`reshape`** reads a preset and sets a board's `Stage` options to match it (you still do the one-time board *view* grouping in the GitHub UI — no token can do that part).

Three boards can each use a different preset, or all share one — no code changes, just data.

## Preset schema

```jsonc
{
  "name": "grants",
  "kind": "non-software",          // software | non-software | mixed
  "description": "Grant / paperwork lifecycle.",
  "lanes": [
    { "name": "Intake",    "terminal": false },
    { "name": "Submitted", "terminal": false },
    { "name": "Awarded",   "terminal": true }
  ],
  "customFields": [                 // optional Projects v2 fields this format needs
    { "name": "Deadline", "type": "date", "appliesTo": "card" }
  ]
}
```

> **Routing labels live in `board.json`, not in a preset.** The 🤖/🧍 labels (`agent:go` / `needs-claude`) are universal — they're the same for a build board or a grants board — so they're set once under `board.json`'s `routing` key (with a sensible default), not repeated per preset. A preset describes *lane shape* only.

## Make your own format (per project)

1. Copy `build.json` to `presets/<your-format>.json` and edit the `lanes`.
2. In that board's `board.json`, set `"preset": "<your-format>"`.
3. Run `doctor` to bind the IDs, then `reshape` to push the lanes onto the board.

Bundled examples: `build.json` (software) and `grants.json` (paperwork). Neither is special — they are just starting points you can copy or replace.
