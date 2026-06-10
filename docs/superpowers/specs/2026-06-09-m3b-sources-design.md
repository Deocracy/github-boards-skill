# M3b "Source Adapters" — Design Spec

**Date:** 2026-06-09
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M3b of the github-boards buildout (see §12)
**Predecessors:** [M3a spec](2026-06-09-m3a-promotion-design.md) · [M2 spec](2026-06-09-m2-brain-design.md) · [M1 spec](2026-06-08-m1-foundation-design.md)

---

## 1. Purpose

Today the only way candidates enter the ledger is `ledger add "<title>"` — one manual title at a time. M3b makes the skill **notice work where it's written**: plan files, roadmaps, TODO lists produced by any skill (superpowers, GSD) or by hand. It reads them and feeds *unfinished* work items into the ledger as candidates, where the existing M2 → M3a pipeline (map → promote) takes over unchanged. **M3b never writes to the board.**

The design is **agnostic by construction**: there are no format parsers in code. The deterministic script handles discovery and bookkeeping; the LLM (Claude, the skill at runtime) reads artifact files natively — any format, any skill, even prose. Skill-specific knowledge lives in **profiles**: small declarative data files (watch globs + extraction hints + done-signals), not parsers. Supporting a new skill is a 20-line data file.

## 2. Scope

### In scope
- `lib/sources.mjs` — pure core (`detectProfiles`, `diffSources`, `buildManifest`, `validateExtraction`).
- Three shipped **profiles** as data: `superpowers`, `gsd`, `generic` (+ user globs via `board.json`).
- `sync scan` / `sync record --extracted <file>` verbs in `board-manager.mjs`.
- The **extraction-file schema** (Claude writes it after reading changed sources).
- `ledger.sources` — per-file last-synced content hashes (the change-detection state).
- SessionStart hook extension: cheap glob+hash scan → "N source file(s) changed since last sync" folded into the existing injected note.
- Deterministic unit + cross-module integration tests. **No live gate needed — M3b never touches GitHub.**

### Out of scope (later modules)
- PostToolUse/background capture during a session (the pending-sources queue) → **M3c**. M3b's awareness is session-start only.
- Real-time "build as you brainstorm" promotion loop → **M3c**.
- Source↔board reconciliation when an already-ingested item is later retitled, deleted, or completed upstream → **M4** (the `source` provenance recorded here is its key).
- SKILL.md triggering description that makes Claude drain the sync note automatically → **M5**. M3b ships the note; M5 ships the conversational enforcement.
- Done items are *skipped*, never ingested (the ledger collects intent, not history). No `--include-done` flag until someone needs it.

## 3. Architecture & data flow

The M2 pattern, one layer earlier: **the LLM is the parser; the script is the deterministic harness.**

```
board-manager.mjs sync scan        (read-only, deterministic, no LLM)
   detect active profiles (presence: docs/superpowers/ → superpowers,
                           .planning/ → gsd, generic always on,
                           board.json sources block may add/disable)
   glob each profile's watch patterns → hash file contents (sha256/12)
   diff against ledger.sources (last-synced hashes)
   → manifest { changedFiles:[{path, profile}], profiles:[{name, hints, doneSignals}] }
          │
   Claude reads each changed file natively (any format),
   guided by the active profiles' hints; extracts
   [{ title, note?, source, done? }] → writes an EXTRACTION file (§6)
          │
board-manager.mjs sync record --extracted <file>   (fail-closed)
   validate schema (whole-file refusal on any invalid item);
   drop done items → skippedDone[]; append the rest via appendCandidate
   (content-hash candidateId dedup → deduped[]);
   update ledger.sources hashes AFTER all appends succeed
   → report { added[], deduped[], skippedDone[], errors[] }
```

**Session-start awareness:** `hooks/SessionStart/load-board.mjs` additionally runs the same cheap scan (glob + hash compare — no LLM, no writes) and folds "N source file(s) changed since last sync" into its injected note. Intended posture (enforced by M5's SKILL.md, stated here): Claude drains that into the **ledger** without ceremony — the ledger is the safe, gitignored buffer; approval stays at M3a's promotion gate.

**M3b boundary:** reads source files + ledger; writes ledger only. Never the board, never GitHub.

## 4. Components & interfaces

New code is **bold**. M3b mirrors M1/M2/M3a's pure-module pattern, so everything but the file-glob and the hook is unit-testable with no I/O.

| Unit | Responsibility | Interface |
|---|---|---|
| **`lib/sources.mjs`** | Pure core: profile detection, source diffing, manifest build, extraction validation. No fs, no network — callers pass data in. | `detectProfiles(presentDirs, config)` → active profiles · `diffSources(currentHashes, ledgerSources)` → `{changed[], unchanged[]}` · `buildManifest(changed, profiles)` → manifest · `validateExtraction(items)` → `{valid[], skippedDone[], errors[]}` |
| **`lib/profiles.mjs`** | The three shipped profiles as plain data (no logic). | exports `PROFILES = [{name, watch[], hints, doneSignals[], detect}]` |
| **`board-manager.mjs` `sync` verb** | Wire fs (glob, hash, ledger) around the pure core. | `sync scan` → prints manifest · `sync record --extracted <f>` → appends + updates hashes + prints report |
| **`hooks/SessionStart/load-board.mjs`** (mod) | Cheap scan; fold changed-source count into the existing note. Read-only; degrades silently on error. | unchanged signature |
| **`ledger.sources`** (new ledger field) | Per-file last-synced content hash. | `{ "<path>": { hash, syncedAt, profile } }` |

**Profile shape** (data, never logic) — superpowers example:

```js
{
  name: 'superpowers',
  detect: 'docs/superpowers',            // presence of this dir activates the profile
  watch: ['docs/superpowers/plans/**/*.md'],
  hints: 'Each "### Task N:" heading is ONE candidate; the checkbox steps under it are ' +
         'implementation detail, not separate candidates. Title = the task name after ' +
         "the colon. Use the plan's linked spec for the note.",
  doneSignals: ['- [x] on every step of the task', 'Status: shipped', 'Status: complete'],
}
```

- `gsd` — `detect: '.planning'`, `watch: ['.planning/**/*.md']`, phase/milestone-level hints.
- `generic` — always active; `watch: ['TODO.md', 'ROADMAP.md', 'BACKLOG.md']` at repo root **plus** any `config.sources.watch[]` globs; hint: "extract actionable work items; `- [ ]` lines are tasks, `- [x]` are done."

**Config (`board.json`, optional `sources` block):**

```jsonc
{
  "sources": {
    "watch": ["notes/**/*.md"],   // extra globs, fed to the generic profile
    "disable": ["gsd"]            // suppress a presence-detected profile
  }
}
```

Absent block → pure presence-detection defaults (back-compat: M1 configs unchanged).

## 5. Profile detection

Presence-based, zero-config, deterministic:

| Condition | Active profile |
|---|---|
| `docs/superpowers/` exists | `superpowers` |
| `.planning/` exists | `gsd` |
| always | `generic` |
| listed in `config.sources.disable` | suppressed (even if detected) |

A repo using several skills activates several profiles; their watch sets are unioned (a file matched by two profiles is scanned once, attributed to the more specific profile — first match in `PROFILES` order, generic last).

## 6. The extraction file

Claude writes this after reading the manifest's changed files:

```jsonc
[
  {
    "title": "Wire up retry on the upload endpoint",   // required, non-empty
    "note": "From the error-handling task in the M4 plan",  // optional
    "source": "docs/superpowers/plans/2026-06-10-m4.md#task-3",  // required: file[#section]
    "done": false                                       // optional, default false
  }
]
```

**`validateExtraction` is fail-closed:** malformed JSON, a non-array, or any item with a missing/empty `title` or `source` → the **whole run is refused** with a legible message, zero appends (same posture as M3a's decisions file). Per-item soft conditions are reported, not fatal: `done:true` → `skippedDone[]` (never appended); duplicate `candidateId` → `deduped[]`.

**Why `source` is required:** dedup is title-hash (`candidateId`) — correct, the same task text shouldn't double-add — but `file#section` provenance is the durable external-id key M4 needs to detect "this plan task changed upstream," exactly as M3a's body marker is for board cards. M3b only *writes* it.

## 7. Change detection & `ledger.sources`

- `sync scan` hashes each watched file's content (sha256, 12 hex chars — same style as `candidateId`) and diffs against `ledger.sources["<path>"].hash`.
- New file (no entry) or changed hash → `changedFiles`. Matching hash → skipped. A previously-synced file that no longer exists is simply absent from the manifest (its ledger entry is left in place — upstream-deletion handling is M4).
- `sync record` updates `ledger.sources` **after all appends succeed** (persist-after-success, as in M3a).

## 8. Idempotency (three layers)

1. **Re-running `sync record` with the same extraction** → every item dedupes via `appendCandidate`'s content-hash; report shows all `deduped`; ledger candidates byte-identical.
2. **Re-running `sync scan` after a successful record** → hashes match → empty `changedFiles`, nothing to extract.
3. **Crash between append and hash update** → next scan re-flags the file, Claude re-extracts, every already-appended item dedupes away. Worst case is wasted LLM tokens, never duplicate candidates.

**Accepted limitation:** an *edited* source file re-flags wholesale — Claude re-reads the whole file; unchanged items dedup away, genuinely new ones land. A **retitled** item becomes a *new* candidate (the old one stays; title-hash is the dedup key). Documented; upstream retitle/delete reconciliation is M4's job, keyed by the `source` provenance recorded here.

## 9. Error handling

- **Fail-closed recording:** any structurally invalid extraction item refuses the whole `sync record` run before any ledger write (§6).
- **Hook safety:** the SessionStart scan is read-only; a scan error (unreadable file, bad glob) degrades to the existing note rather than breaking session start — matching the hook's current stay-silent-on-trouble posture.
- **Empty cases:** no profiles beyond generic → fine; no watched files exist → empty manifest, not an error; extraction file with zero items → no-op report; no ledger yet → `sync record` ensures one (as `mapRecord` does).
- **`sync scan` with no `board.json`:** profiles still detect and the scan still runs — the `sources` config block is optional and the verb must not require a bound board (the ledger is Tier-0, pre-board). Mirror the `ledger`/`bootstrap` verbs' loadConfig bypass.

## 10. Testing

All deterministic — temp-dir fs, no network, **no live gate** (M3b never touches GitHub).

1. **`lib/sources.mjs` unit:** `detectProfiles` (dirs present/absent / disabled via config / custom globs added); `diffSources` (new file / changed hash / unchanged / upstream-deleted leaves entry untouched); `validateExtraction` (missing title or source → fail-closed; done-routing; valid pass-through; non-array refused); `buildManifest` carries the right hints per profile and attributes overlap-matched files to the more specific profile.
2. **`sync` verb (temp dirs):** scan → manifest correctness against real files on disk; record → appends with provenance + updates hashes after success; full-loop idempotency (scan → record → scan = empty); refusal on malformed extraction (ledger untouched); crash-window simulation (append succeeded, hash not updated → re-scan re-flags, re-record dedupes cleanly); works without `board.json`.
3. **Cross-module integration (the M3a lesson):** run the **real** chain — `sync record` output → `prepareInput` (M2) sees the new candidates as `status:'candidate'` → `applyProposals` → `classify` (M3a) buckets them. Proves the field names actually line up across all three modules; no hand-built fixtures at the module boundary.
4. **Hook:** changed-source count appears in the injected note; zero changed → note unchanged from today; scan failure → degrades gracefully.

## 11. Open questions (resolve/verify at plan time)

- **Glob implementation:** Node ≥18 has no stable `fs.glob` everywhere; confirm the simplest dependency-free walk (recursive `readdir` + pattern match) consistent with the no-third-party-deps stance, and its symlink/depth behavior.
- **Path normalization:** ledger keys must be repo-relative POSIX-style paths (forward slashes) so Windows and CI agree; confirm the existing repo conventions.
- **Hook cost ceiling:** confirm the session-start scan stays cheap on large repos (watch sets are narrow globs, not full-tree walks); cap or skip-with-note if a watch set explodes.
- **Manifest handoff:** exact print format of `sync scan` (JSON to stdout, as `map prepare` does) and the extraction-file path convention Claude uses (mirror `--proposals` handling).

## 12. Module context

| Module | What it is | Status |
|---|---|---|
| **M1 · Foundation** | Provisioning + intent ledger | ✅ shipped |
| **M2 · The Brain** | Mapper + ruleset + ambiguity dialogue | ✅ shipped |
| **M3a · Promotion + resolution** | Promote mapped candidates to the board; needs-decision loop | ✅ shipped |
| **M3b · Source adapters** *(this spec)* | Read external skill artifacts into the ledger, agnostically | designing |
| **M3c · Real-time triggering** | PostToolUse pending-sources queue; "build as you brainstorm" | backlog |
| **M4 · Board→skill + time-travel** | External-change detection; source↔board reconcile; snapshots | backlog |
| **M5 · Skill layer** | SKILL.md, triggering-description tuning, evals | backlog |
| **M6 · Verification & simulation** | Unit + simulation + live integration | seeded by M1–M3 |
