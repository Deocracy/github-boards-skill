# M4b "Time-Travel" — Design Spec

**Date:** 2026-06-10
**Status:** Design (approved in brainstorming; pre-plan)
**Sub-project:** M4b of the github-boards buildout (see §10). Completes M4 alongside [M4a · Reconcile](2026-06-10-m4a-reconcile-design.md).
**Predecessors:** [M4a spec](2026-06-10-m4a-reconcile-design.md) · [M3c spec](2026-06-10-m3c-realtime-design.md) · [M1 spec](2026-06-08-m1-foundation-design.md)

---

## 1. Purpose

Today the board's past is one overwrite-on-read file: `state.json` remembers only "last time," and `summary` reports what changed since. M4b gives the board a **memory**, in two complementary layers:

- **Snapshots** — full board states, pruned to the newest N (bulky; restore-points). "What did the board look like?"
- **The event log** — an append-only, **never-pruned** journal of the *changes between* consecutive snapshots (tiny; permanent). "What happened, and when?"

Both accumulate as a side effect of normal use, answering "what changed this week?", "when did #42 leave Building?", "what did the board look like before the cleanup?" — and the log keeps answering after the snapshots that produced it are pruned. Granularity is honest: it's a journal of *observed* change between looks (per session + manual takes), not a per-click audit trail — GitHub pushes us no events.

**Decided posture (Q&A):**
- **Read-only history** — no board writes, no restore verb. Multi-step *undo* is already achievable conversationally: `snapshot diff` yields the exact inverse operations and the existing approval-gated verbs (`move`, `route`) replay them; a batch `snapshot restore` can be added later on the same store if usage demands it (the store is restore-ready: itemId + lane + labels are everything restore needs).
- **Capture = piggyback on `summary` + a manual verb.** Every `summary` run (including the session-start hook's) already fetches the full board; writing a snapshot there is free history — roughly one per working session. `snapshot take ["label"]` covers deliberate save-points. Content-hash dedup means idle sessions add zero files.

## 2. Scope

### In scope
- **`lib/snapshots.mjs`** — the snapshot store: write (dedup + prune), list, read-by-ref, pure `diffSnapshots`, **and the append-only event log** (`appendLogEntry`, `readLog`).
- **`log.jsonl`** — one JSON line per observed change-event, written whenever a non-skipped snapshot lands; **never pruned**.
- **`summary` piggyback** — non-fatal snapshot+log write after summary's existing work.
- **`snapshot take ["label"]` / `snapshot list` / `snapshot diff <ref> [<ref2>]` / `snapshot log [N]`** verbs + CLI (loadConfig path).
- Optional **`snapshots: { keep: 50 }`** config block (raw-tolerant, like `sources`); `board.example.json` documents it.
- Deterministic unit + verb + cross-module tests. **No new live surface** — the only board read is the long-shipped `listItems`.

### Out of scope (deferred)
- **`snapshot restore`** (batch board rollback) — deferred until usage demands it; the conversational diff→move/route path covers undo meanwhile.
- **Issue bodies in snapshots** — lane/label/title history is the asked question; bodies would bloat ~50 files for nothing.
- **Ledger snapshots/restore** — the ledger has reconcile (M4a) for drift; versioning it answers no asked question.
- **`state.mjs` changes** — `summary`'s "since last run" contract is load-bearing and proven; snapshots are a parallel, append-only history.

## 3. Architecture & data flow

```
summary (existing verb, incl. the session-start hook's run)
   already fetches listItems() → AFTER its normal work, also:
     writeSnapshot(dir, items, {keep})       ← non-fatal (try/catch; a failure
                                                appends "(snapshot skipped: …)"
                                                to the say, never breaks summary)
        │
.github-boards/snapshots/snapshot-<stamp>.json      (gitignored dir, M1's home)
   stamp = ISO timestamp with ':'/'.' → '-'         (Windows-safe, sorts chrono)
   { takenAt, label, count, itemsHash, items: [listItems shape] }
   DEDUP: contentHash(normalized items) === newest snapshot's itemsHash → skip
   PRUNE: after each successful write, delete oldest beyond `keep` (default 50)
        │
   AND (when the write was NOT skipped):
.github-boards/snapshots/log.jsonl       append-only, NEVER pruned
   first snapshot ever → { at, initial: true, count }
   otherwise          → { at, ...diffSnapshots(prevNewest.items, items) }
   (the previous snapshot is already in hand for dedup — the log line is free)
        │
snapshot take ["label"]       manual save-point (same dedup/prune/log; label optional)
snapshot list                 newest-first: stamp, label, count, age
snapshot diff <ref> [<ref2>]  PURE diff; ref2 omitted → fresh engine.listItems()
                              as "now"
   → { moved[], added[], removed[], relabeled[], retitled[] }
snapshot log [N]              last N events (default 20) from log.jsonl,
                              newest-first, human-readable
```

## 4. Components & interfaces

New code is **bold**.

| Unit | Responsibility | Interface |
|---|---|---|
| **`lib/snapshots.mjs`** | Snapshot store + event log; owns `.github-boards/snapshots/`. | `writeSnapshot(dir, items, {label?, keep?})` → `{path, skipped:false, logged:boolean}` \| `{skipped:true, reason}` · `listSnapshots(dir)` → `[{file, takenAt, label, count}]` newest-first · `readSnapshot(dir, ref)` → snapshot object · `diffSnapshots(prevItems, currItems)` → diff (pure) · `resolveRef(refs, ref)` (pure ref→file resolution, exported for tests) · `readLog(dir, n)` → `{entries:[…newest-first], skippedLines}` |
| **`board-manager.mjs`** | `summary` piggyback; `snapshotTake(label, ctx)`, `snapshotList(ctx)`, `snapshotDiff(refA, refB, ctx)`, `snapshotLog(n, ctx)` verbs; CLI `snapshot <take\|list\|diff\|log>`. | `snapshotDiff(refA, refB?, ctx)` — `refB` omitted → live board via `engine.listItems()` |
| **`board.example.json`** | Document `"snapshots": { "keep": 50 }`. | — |

### Mechanics

- **File format:** `snapshot-2026-06-10T14-30-05-123Z.json`: `{ takenAt (real ISO), label (string|null), count, itemsHash, items[] }` — items exactly as `listItems` returns them (`itemId, contentType, issueNumber, title, state, repo, stageLabel, labels[]`). Filename sorts chronologically by construction; `listSnapshots` = readdir + filter valid names + sort desc. No index file.
- **Dedup:** normalize items (sorted by itemId, stable key order) → `contentHash` (reused from `lib/sources.mjs`) → compare with newest snapshot's stored `itemsHash`. Equal → `{skipped:true}`, no file. The hash is stored so dedup never has to re-read/re-normalize old files.
- **Refs:** `latest` · ISO-stamp prefix (`2026-06-10` → that day's newest; longer prefixes narrow further) · `~N` 1-based age index (`~1` = newest). Unresolvable/ambiguous-empty → legible error listing the three nearest stamps.
- **Diff (pure, keyed by `itemId`):** `moved` `{itemId, issueNumber, title, from, to}` (stageLabel changed) · `relabeled` `{itemId, issueNumber, title, added[], removed[]}` (label SET changed — order-insensitive) · `retitled` `{itemId, issueNumber, from, to}` · `added`/`removed` `{itemId, issueNumber, title}` (one side only). Unchanged items silent. A card can appear in several buckets (moved AND relabeled) — buckets are independent.
- **Retention:** default 50; `config.snapshots.keep` (positive integer; anything else → default). Prune deletes strictly the valid-snapshot-named files beyond newest-N; **`log.jsonl` is never pruned** and never matches the snapshot-name filter; other foreign files are likewise never touched.
- **The event log:** written inside `writeSnapshot` only when the write is NOT skipped. First-ever snapshot → `{at, initial:true, count}`; thereafter → `{at, moved, added, removed, relabeled, retitled}` from `diffSnapshots(previousNewest.items, items)` (the previous snapshot is already loaded for dedup — the line is free). Append-only `log.jsonl`; one compact JSON line per event. `readLog(dir, n)` returns the last `n` entries newest-first and **tolerates malformed lines** (a torn write from a crash must not kill the whole journal — bad lines are skipped and counted in `skippedLines`).
- **Piggyback placement:** inside `summary` after its existing state write, wrapped so failure degrades to a say suffix. The hook needs no change — it calls `summary` and inherits both the snapshot and the tolerance.

## 5. Error handling

- **Piggyback never breaks `summary`** (and therefore never the session-start hook): all store failures caught → "(snapshot skipped: <reason>)" suffix.
- **Manual verbs are loud:** unresolvable ref → error listing nearest stamps; malformed snapshot JSON on read → error naming the file (corrupted history must be visible, not skipped); no snapshots yet → `list` says so, `diff latest` errors legibly.
- **Empty board** snapshots fine (`count: 0`). Diffing identical refs → empty buckets, say "no changes."
- **`~N` out of range** → error showing the valid range.
- **Log robustness:** a failed log append degrades exactly like a failed snapshot write (caught in the piggyback; loud in manual `take`). `snapshot log` with no log yet → "no events recorded yet." Malformed log lines are skipped and reported as a count, never fatal — the log is a journal, and one torn line must not orphan years of history.

## 6. Testing

All deterministic — temp dirs, mock engine, no live gate.

1. **`lib/snapshots.mjs` unit:** write→list→read round-trip; dedup (identical items → skipped, no second file, NO log line; changed items → new file + log line); prune (N+3 distinct writes with keep=N → oldest snapshots deleted, **`log.jsonl` survives with all its lines**, foreign file untouched); ref resolution (`latest`, date prefix, `~N`, out-of-range/unknown → legible errors); `diffSnapshots`: each bucket isolated + a combined multi-bucket case + label-order insensitivity + same-items → all empty; log: first write → `initial` line, subsequent → diff lines, `readLog` newest-first + n-cap + malformed-line tolerance (`skippedLines`).
2. **Verb tests (mock engine):** summary piggyback — one snapshot+log event on changed board, none on unchanged, injected store failure → summary still succeeds with the suffix; `snapshotTake` stores the label; `snapshotDiff` two refs and ref-vs-live; `snapshotLog` renders the last N events; say lines.
3. **Cross-module reality check (the standing lesson):** snapshots written from real `listItems`-shaped mock-engine data flowing through the existing promote pipeline — diff pre-promote vs post-promote board, assert the promoted card shows in `added` with its real title. No hand-built snapshot fixtures at the boundary.
4. **Hook tolerance:** the session-start summary path with a sabotaged snapshots dir still injects its note.

## 7. Open questions (resolve/verify at plan time)

- **`summary`'s current shape:** verify where summary's items are available in its flow (it builds the state map from `listItems` — confirm the raw items array is in scope for the piggyback without a second fetch).
- **`Date` use:** snapshot stamps need real timestamps (`new Date().toISOString()`), consistent with ledger's `addedAt` — no constraint here, just match house style.
- **CLI ref quoting:** `~1` on PowerShell — verify `~` needs no escaping when passed as an argv (it doesn't inside quotes; document in help if needed).

## 8. The undo story (for the record)

M4b ships **no restore**, but multi-step undo works conversationally: `snapshot diff <ref>` lists exactly what changed (moves, label swaps); Claude proposes the inverse and executes it through the existing approval-gated `move`/`route` verbs. If a one-command batch restore proves wanted, `snapshot restore <ref>` later composes the same diff with those same verbs — gated like promote, restoring lanes + routing labels for still-existing cards only (never recreating deleted cards). The store already carries everything it needs.

## 9. Module context

| Module | What it is | Status |
|---|---|---|
| **M1 · Foundation** | Provisioning + intent ledger | ✅ shipped |
| **M2 · The Brain** | Mapper + ruleset + ambiguity dialogue | ✅ shipped |
| **M3a/b/c** | Promote · source adapters · real-time signal | ✅ shipped |
| **M4a · Reconcile** | Drift detection + ledger-only healing | ✅ shipped |
| **M4b · Time-travel** *(this spec)* | Versioned snapshots, list + diff (read-only) | designing |
| **M5 · Skill layer** | SKILL.md, triggering, evals — incl. conversational undo reflex | backlog |
| **M6 · Verification & simulation** | Unit + simulation + live integration | seeded by M1–M4 |
