# M3c "Real-Time Triggering" — Design Spec

**Date:** 2026-06-10
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M3c of the github-boards buildout (see §10)
**Predecessors:** [M3b spec](2026-06-09-m3b-sources-design.md) · [M3a spec](2026-06-09-m3a-promotion-design.md) · [M2 spec](2026-06-09-m2-brain-design.md) · [M1 spec](2026-06-08-m1-foundation-design.md)

---

## 1. Purpose

M3b made the skill notice changed source files **at session start**; M3c closes the last latency gap: noticing them **mid-session, the moment they're written**. When any skill (superpowers' writing-plans, GSD, or the user via Claude) saves a watched file, Claude learns about it on the very next turn — no session restart, no manual discovery.

**Design reduction (supersedes the roadmap sketch):** the roadmap imagined a durable "pending-sources queue" in the ledger. M3b's hash-diff (`ledger.sources`) already *is* the durable change record — any change nobody acts on is re-flagged at the next session-start scan, so nothing is ever lost. M3c therefore ships a **stateless signal, not a queue**: a PostToolUse hook whose only state is session-scoped anti-spam memory. The scan stays the single source of truth; the hook asserts nothing about sync state, so it can never disagree with it.

## 2. Scope

### In scope
- **`matchesWatch(relPath, patterns)`** — new pure matcher in `lib/sources.mjs`.
- **`hooks/PostToolUse/watch-sources.mjs`** — the hook (pure `decide(input, deps)` + thin `main()` shim, mirroring `load-board.mjs`).
- **`.github-boards/announced.json`** — session-scoped anti-spam memory `{ sessionId, files[] }`.
- **`hooks/hooks.json`** — register the PostToolUse entry, matcher `Write|Edit|MultiEdit|NotebookEdit`.
- Deterministic unit tests. **No live gate — M3c touches nothing external.**

### Out of scope (later modules / accepted)
- The conversational drain-the-note behavior (Claude auto-running sync on the note) → **M5** (SKILL.md triggering). M3c ships the signal; M5 ships the reflex.
- Bash-mediated writes (`echo > TODO.md`) don't fire PostToolUse Write/Edit matchers — **accepted**: caught by the session-start scan (M3b). Parsing Bash commands for file writes is fragile and out of scope.
- Windows case-mismatch (`todo.md` written while the pattern says `TODO.md`) produces no mid-session note — `matchesWatch` is case-sensitive string comparison — **accepted, same backstop**: the M3b scan reads real dirents (canonical casing) and re-flags at the next session start. Every M3c miss is advisory-only; the hash-diff stays the durable record.
- A durable pending queue in the ledger — **rejected** (§1): redundant with the hash-diff and a source of state disagreement.
- No-op-write suppression via hashing in the hook — **rejected**: puts file reads + sha256 in the per-tool-call hot path and duplicates scan logic; a rare spurious note is harmless.

## 3. Architecture & data flow

```
Claude calls Write / Edit / MultiEdit / NotebookEdit on any file
        │
hooks/PostToolUse/watch-sources.mjs   (matcher-gated: runs ONLY for those tools)
   1. relPath = relative(input.cwd, tool_input.file_path), forward slashes
      outside the repo (starts with "..") → exit 0 silent
   2. profiles = detectProfiles(presentDetectDirs(cwd), raw board.json)
      (identical activation to M3b's defaultScanSources — disabled profiles
       respected; user sources.watch globs participate)
   3. matchesWatch(relPath, union of profile watch patterns)?
      no  → exit 0 silent (the overwhelmingly common case — string match only,
            no fs walk, no hashing: microseconds)
      yes → 4
   4. announced.json: already announced THIS file THIS session?
      yes → exit 0 silent
      no  → record file in announced.json (best-effort) + inject:
            "github-boards: watched source file changed: <path> — run
             'sync scan' then 'sync record' to ingest when ready."
```

**Notification posture (decided):** once per file per session. The first save of a watched file produces one note; an execution session that re-saves the same plan thirty times produces no further noise. A new session (different `session_id`) announces afresh — by then the SessionStart scan note usually covers it anyway.

**M3c boundary:** the hook is observation-only — no LLM, no ledger writes, no board, no hashing, never blocks or modifies the tool call.

## 4. Components & interfaces

New code is **bold**.

| Unit | Responsibility | Interface |
|---|---|---|
| **`matchesWatch(relPath, patterns)`** in `lib/sources.mjs` | Pure string match of ONE repo-relative POSIX path against watch patterns. Same two supported forms as `expandWatch`: literal equality, and `<base>/**/*.<ext>` (path starts with `<base>/` and ends with `.<ext>`). Non-string/unsupported patterns never match. No fs. | `(string, string[]) → boolean` |
| **`hooks/PostToolUse/watch-sources.mjs`** | Extract path → relativize → match → anti-spam check → note or silence. | `decide(input, deps)` → `{additionalContext}` \| `null` · `main()` stdin/stdout shim. `deps` injects `{ getProfiles(cwd), readAnnounced(cwd), writeAnnounced(cwd, data) }` so unit tests never touch fs |
| **`.github-boards/announced.json`** | Anti-spam memory. | `{ sessionId: string, files: string[] }` — sessionId mismatch or missing/malformed file → treated as empty (fresh session) |
| **`hooks/hooks.json`** (mod) | Register the hook. | PostToolUse entry, matcher `Write\|Edit\|MultiEdit\|NotebookEdit`, command `node ${CLAUDE_PLUGIN_ROOT}/hooks/PostToolUse/watch-sources.mjs` |

**`expandWatch`/`matchesWatch` parity:** both implement the same two pattern forms. A shared-fixture test asserts they agree on identical cases (a file `expandWatch` finds must satisfy `matchesWatch` for the same pattern, and vice-versa for misses), so the two implementations cannot drift.

**Hook input (PostToolUse stdin JSON):** `{ session_id, cwd, hook_event_name, tool_name, tool_input, tool_response }`. The hook uses `session_id`, `cwd`, and `tool_input.file_path` (`NotebookEdit` uses `notebook_path` — read whichever is present). Missing/non-string path → silent.

**Hook output (verify exact format against the hooks docs at plan time, as M1 did for SessionStart):**

```json
{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "<note>" } }
```

Silence = print nothing, exit 0. The hook NEVER emits `decision`/`reason` (it never blocks).

## 5. The anti-spam memory

- Lives at `<cwd>/.github-boards/announced.json` (the gitignored dir M1 established).
- Read: missing file, unparseable JSON, or `sessionId !== input.session_id` → empty state (announce).
- Write: best-effort `{ sessionId, files: [...existing matching session, relPath] }`. A failed write is swallowed — worst case is a duplicate note on the next save of the same file, never an error and never a blocked tool call.
- Not cleaned up between sessions; the next session's first announce simply overwrites it with the new sessionId.

## 6. Error handling

- **Never-throw contract** (same as the SessionStart hook): `decide()` catches everything to `null`; `main()` has a belt-and-suspenders catch; always exit 0; print nothing unless there is a note.
- Every fs touch (board.json read, detect-dir existsSync, announced.json read/write) is individually guarded; any failure degrades to "not watched" or "not yet announced" — the failure mode is a missed or duplicate note, never noise or a broken tool call.
- The hook adds work to EVERY Write/Edit/MultiEdit/NotebookEdit call, so the fast path is ordered cheapest-first: path extraction + relativize (string ops, no I/O — the no-path and outside-repo cases exit here) → profile activation (lazy-import of the verb layer + two existsSync + one best-effort `board.json` read — paid on every in-repo write) → pattern match (string ops). `announced.json` I/O happens only after a positive match.

## 7. Testing

All deterministic, no live gate.

1. **`matchesWatch` unit (tests/sources.test.mjs):** literal hit/miss; glob hit incl. nested subpath; wrong-ext miss; prefix-collision miss (`docs/superpowers/plans-old/x.md` must NOT match `docs/superpowers/plans/**/*.md`); `*`-containing non-glob-shape forms (`docs/*.md`) and non-strings never match (`*`-less glob-ish forms like `?`/`{}` take the literal branch — exact equality, matching nothing real, same as expandWatch); leading `./` normalized; empty/null patterns → false.
2. **Parity test:** shared fixtures asserting `expandWatch` (fs) and `matchesWatch` (pure) agree — every file expandWatch returns for a pattern satisfies matchesWatch, and known-miss cases fail both.
3. **`decide()` unit (tests/hooks.watch-sources.test.mjs, injected deps):** watched file first time → note containing the relPath and the sync hint; same file same session → null; same file NEW sessionId → note again; unwatched path → null; path outside repo → null; missing file_path/tool_input → null; NotebookEdit `notebook_path` honored; every dep throwing (getProfiles, readAnnounced, writeAnnounced) → null or note-without-persist (degrade, never throw); writeAnnounced called with the updated file list.
4. **hooks.json:** valid JSON; the PostToolUse entry exists with the exact matcher string and command path.
5. **Drift guard (the M3a/M3b lesson):** the note's suggested verbs must match reality — assert the note's `sync scan` / `sync record` substrings appear in `board-manager.mjs`'s CLI help text, so a future verb rename can't silently orphan the hint.

## 8. Open questions (resolve/verify at plan time)

- **PostToolUse `additionalContext` support:** verify against the current Claude Code hooks docs that PostToolUse supports `hookSpecificOutput.additionalContext` (M1 verified the SessionStart shape the same way). If unsupported, fall back to plain-stdout context emission per the documented PostToolUse output contract.
- **`MultiEdit` tool name:** confirm the current tool name set for the matcher (Write/Edit/NotebookEdit are stable; MultiEdit may or may not exist in current Claude Code) — harmless if the matcher names a tool that never fires.
- **`tool_input` path field names:** verify `file_path` (Write/Edit) and `notebook_path` (NotebookEdit) against the docs.

## 9. Module context

| Module | What it is | Status |
|---|---|---|
| **M1 · Foundation** | Provisioning + intent ledger | ✅ shipped |
| **M2 · The Brain** | Mapper + ruleset + ambiguity dialogue | ✅ shipped |
| **M3a · Promotion + resolution** | Promote mapped candidates; needs-decision loop | ✅ shipped |
| **M3b · Source adapters** | Read external skill artifacts into the ledger | ✅ shipped |
| **M3c · Real-time triggering** *(this spec)* | Mid-session change signal (PostToolUse hook) | designing |
| **M4 · Board→skill + time-travel** | External-change detection; source↔board reconcile; snapshots | backlog |
| **M5 · Skill layer** | SKILL.md, triggering-description tuning, evals — incl. the drain-the-note reflex | backlog |
| **M6 · Verification & simulation** | Unit + simulation + live integration | seeded by M1–M3 |
