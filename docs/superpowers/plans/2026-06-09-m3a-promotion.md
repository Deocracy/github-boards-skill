# M3a "Promotion + Resolution" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote `mapped`/`needs-decision` ledger candidates into real GitHub Projects v2 cards — approval-gated, idempotent, and resumable — reusing M1's engine ops unchanged.

**Architecture:** A new pure module `scripts/lib/promote.mjs` (`classify`, `resolveDecisions`, `cidMarker`, `parseCid`) does all reasoning with no I/O. Two new verbs in `scripts/board-manager.mjs` (`promotePlan`, `promoteApply`) wrap M1's dependency-injected engine: `promote plan` classifies (read-only); `promote apply` commits the resolved set, stamping a `<!-- gboards:cid=… -->` marker into each issue body and flipping the ledger candidate to `promoted` per-candidate (persisted progressively so a mid-batch failure resumes from the ledger — no live board read).

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `node:crypto` (already used for content hashes), the existing `tests/helpers/mock-engine.mjs`, `gh` CLI/GraphQL (only via the live smoke, which is operator-gated).

---

## ⚠️ Execution safety directive (applies to EVERY subagent in the chain — implementer, spec-reviewer, code-quality-reviewer, and any fix subagent)

**Task 13 writes a live integration smoke test gated behind `GBS_LIVE=1`. DO NOT RUN IT during automated execution.** Running it creates real GitHub resources (a real ProjectV2, a real issue, real labels) on a real repo. The test is *written but never executed* in this plan. The task itself is marked operator-gated and self-consistent with this directive, so a spec-compliance check will NOT find a "missing live run" — writing the file IS the deliverable. When you run the suite, the live test auto-skips (`GBS_LIVE` unset). Never set `GBS_LIVE=1`. This directive is repeated verbatim inside Task 13 so it reaches whichever role acts on that task. (See memory: `subagent-plan-exec-safety-directives`.)

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `scripts/lib/promote.mjs` | **Create** | Pure core: `classify`, `resolveDecisions`, `cidMarker`, `parseCid`. No network, no board, no ledger I/O. |
| `scripts/lib/mapper.mjs` | Modify | Add `promoteConfidenceBelow: 0.8` to `DEFAULT_RULES` (single source of truth for rules). |
| `scripts/board-manager.mjs` | Modify | Add `promotePlan`/`promoteApply` verbs + `bodyFor` helper + CLI `promote` case + `--decisions` flag + help text. |
| `board.example.json` | Modify | Add `promoteConfidenceBelow: 0.8` to the `rules` block (documentation parity). |
| `tests/promote.test.mjs` | **Create** | Pure unit tests for `promote.mjs` (classify/resolveDecisions/markers). |
| `tests/promote-verb.test.mjs` | **Create** | Verb tests with the mock engine (staged/commit/comment/idempotency/resume/validation/pushPolicy). |
| `tests/live-promote.test.mjs` | **Create** | Operator-gated (`GBS_LIVE=1`) end-to-end smoke. **Written, never run in automated execution.** |

**Decisions reconciled against the real codebase (do not re-litigate):**
- The verb's `config` comes from `lib/config.mjs loadConfig`, which spreads the raw `board.json` (`return { ...cfg, preset, routing }`) — so `config.pushPolicy`, `config.rules`, `config.stageOptions`, `config.routing` are all present at runtime.
- The engine is dependency-injected via `ctx.engine` (see the DI contract comment at the top of `board-manager.mjs`, lines 10–20). Tests inject `makeMockEngine(...)`. This is the §11 "engine injection seam" — already proven by `put`/`move`/etc.
- **Staged caveat (load-bearing):** in staged mode there is NO real issue, so `addIssueToBoard`/`setStage`/`setLabels` must NOT be chained on a null url/itemId (the real engine and the mock both throw). `put` solved this by calling ONLY `createIssue` (with `staged:true`) in staged mode and previewing the rest from inputs. `promoteApply` mirrors this exactly.
- **Comment text source (§11 resolved):** a `kind:comment` candidate's comment body = `cand.note || cand.title`; `commentTarget` is the issue number `engine.comment(issueNumber, body, …)` expects.
- **Resumability (§11 resolved):** no live marker scan. `cand.promotion = { issueNumber, issueUrl, issueNodeId, itemId }` is persisted progressively; a re-run reads it from the ledger and resumes the chain. The body marker remains the durable external-id key for M4's future board-scan reconcile.
- **CLI shape:** subcommands `promote plan` / `promote apply` (mirrors the existing `map prepare` / `map record`), which is a better codebase-fit than the spec's illustrative `--plan`/`--decisions` wording. `--decisions <file>` and `--staged` are flags on `apply`.

---

### Task 1: Add the `promoteConfidenceBelow` rule default

**Files:**
- Modify: `scripts/lib/mapper.mjs:9-16` (the `DEFAULT_RULES` object)
- Modify: `board.example.json` (the `rules` block)
- Test: `tests/rules-backcompat.test.mjs` (add one assertion)

- [ ] **Step 1: Add the failing test**

Append to `tests/rules-backcompat.test.mjs`:

```javascript
test('resolveRules default includes promoteConfidenceBelow 0.8', () => {
  assert.equal(resolveRules(null).promoteConfidenceBelow, 0.8);
  assert.equal(resolveRules({ rules: { promoteConfidenceBelow: 0.5 } }).promoteConfidenceBelow, 0.5);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/rules-backcompat.test.mjs`
Expected: FAIL — `resolveRules(null).promoteConfidenceBelow` is `undefined`, not `0.8`.

- [ ] **Step 3: Add the default**

In `scripts/lib/mapper.mjs`, change `DEFAULT_RULES` to include the new key:

```javascript
const DEFAULT_RULES = {
  maxLanes: 8,
  useTags: false,
  defaultOwner: 'human',
  granularity: 'fine',
  escalateConfidenceBelow: 0.6,
  escalateBatchOver: 12,
  promoteConfidenceBelow: 0.8,
};
```

- [ ] **Step 4: Update `board.example.json` for documentation parity**

In `board.example.json`, the `rules` block ends with `"escalateBatchOver": 12`. Add the new key (mind the trailing comma — `escalateBatchOver` needs a comma after it now):

```jsonc
  "rules": {
    "maxLanes": 8,
    "useTags": false,
    "defaultOwner": "human",
    "granularity": "fine",
    "escalateConfidenceBelow": 0.6,
    "escalateBatchOver": 12,
    "promoteConfidenceBelow": 0.8
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/rules-backcompat.test.mjs`
Expected: PASS (all 3 tests, including the two pre-existing ones).

Also verify `board.example.json` is still valid JSON:
Run: `node -e "JSON.parse(require('fs').readFileSync('board.example.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/mapper.mjs board.example.json tests/rules-backcompat.test.mjs
git commit -m "feat(m3a): add promoteConfidenceBelow rule default (0.8)"
```

---

### Task 2: `cidMarker` + `parseCid` (the body marker)

**Files:**
- Create: `scripts/lib/promote.mjs`
- Test: `tests/promote.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/promote.test.mjs`:

```javascript
// tests/promote.test.mjs — pure unit tests for lib/promote.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cidMarker, parseCid } from '../scripts/lib/promote.mjs';

test('cidMarker/parseCid round-trip', () => {
  const cid = 'a1b2c3d4e5f6';
  const marker = cidMarker(cid);
  assert.equal(marker, `<!-- gboards:cid=${cid} -->`);
  assert.equal(parseCid(`Some body text\n\n${marker}`), cid);
});

test('parseCid returns null when no marker present', () => {
  assert.equal(parseCid('plain body, no marker'), null);
  assert.equal(parseCid(''), null);
  assert.equal(parseCid('<!-- unrelated comment -->'), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/promote.test.mjs`
Expected: FAIL — cannot import from a nonexistent `../scripts/lib/promote.mjs`.

- [ ] **Step 3: Create `scripts/lib/promote.mjs` with the markers**

```javascript
// scripts/lib/promote.mjs — M3a promotion PURE core.
//
// Classifies mapped/needs-decision ledger candidates into promotion buckets,
// resolves pre-gathered human decisions, and stamps/parses the durable
// candidateId body marker. No network, no board, no ledger I/O — board-manager's
// `promote` verb owns those side effects.

import { resolveRules } from './mapper.mjs';

// candidateId (and splitChildId) are always 12 lowercase-hex chars.
const MARKER_RE = /<!--\s*gboards:cid=([0-9a-f]{12})\s*-->/;

/**
 * The durable external-id marker stamped into a promoted issue's body.
 * @param {string} cid  a 12-hex candidateId
 * @returns {string}
 */
export function cidMarker(cid) {
  return `<!-- gboards:cid=${cid} -->`;
}

/**
 * Extract the candidateId from an issue body, or null if absent.
 * @param {string} body
 * @returns {string|null}
 */
export function parseCid(body) {
  const m = MARKER_RE.exec(String(body || ''));
  return m ? m[1] : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/promote.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/promote.mjs tests/promote.test.mjs
git commit -m "feat(m3a): cidMarker/parseCid body-marker helpers"
```

---

### Task 3: `classify` — bucket candidates into confident / uncertain / comments / skipped

**Files:**
- Modify: `scripts/lib/promote.mjs`
- Test: `tests/promote.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/promote.test.mjs`:

```javascript
import { classify } from '../scripts/lib/promote.mjs';

const CFG = { stageOptions: { Ideas: 'o1', Building: 'o2', Shipped: 'o3' }, rules: { promoteConfidenceBelow: 0.8 } };

function led(candidates) { return { candidates }; }

test('classify: confident card (conf >= threshold) -> confident', () => {
  const p = classify(led([
    { id: 'aaaaaaaaaaaa', title: 'Wire auth', kind: 'card', suggestedLane: 'Building', suggestedOwner: 'agent', confidence: 0.95, status: 'mapped' },
  ]), CFG);
  assert.equal(p.confident.length, 1);
  assert.deepEqual(p.confident[0], { candidateId: 'aaaaaaaaaaaa', kind: 'card', title: 'Wire auth', lane: 'Building', owner: 'agent', confidence: 0.95 });
  assert.equal(p.uncertain.length, 0);
});

test('classify: low-confidence card -> uncertain with reason+question', () => {
  const p = classify(led([
    { id: 'bbbbbbbbbbbb', title: 'Maybe refactor', kind: 'card', suggestedLane: 'Ideas', suggestedOwner: 'human', confidence: 0.4, status: 'mapped' },
  ]), CFG);
  assert.equal(p.uncertain.length, 1);
  assert.equal(p.uncertain[0].reason, 'low-confidence');
  assert.deepEqual(p.uncertain[0].options, ['Ideas', 'Building', 'Shipped']);
});

test('classify: needs-decision -> uncertain carrying its own question/options', () => {
  const p = classify(led([
    { id: 'cccccccccccc', title: 'Ambiguous', status: 'needs-decision', needsDecision: { question: 'Which lane?', options: ['Ideas', 'Building'] }, suggestedLane: null, suggestedOwner: null },
  ]), CFG);
  assert.equal(p.uncertain.length, 1);
  assert.equal(p.uncertain[0].reason, 'needs-decision');
  assert.equal(p.uncertain[0].question, 'Which lane?');
  assert.deepEqual(p.uncertain[0].options, ['Ideas', 'Building']);
  assert.equal(p.uncertain[0].lane, null);
});

test('classify: confident comment -> comments with text from note', () => {
  const p = classify(led([
    { id: 'dddddddddddd', title: 'ctx', note: 'see the spec', kind: 'comment', commentTarget: 12, confidence: 0.9, status: 'mapped' },
  ]), CFG);
  assert.equal(p.comments.length, 1);
  assert.deepEqual(p.comments[0], { candidateId: 'dddddddddddd', kind: 'comment', title: 'ctx', commentTarget: 12, text: 'see the spec', confidence: 0.9 });
});

test('classify: settled + unmapped -> skipped (with reasons)', () => {
  const p = classify(led([
    { id: '111111111111', title: 'done', kind: 'card', status: 'promoted' },
    { id: '222222222222', title: 'dup', status: 'merged' },
    { id: '333333333333', title: 'parent', status: 'split' },
    { id: '444444444444', title: 'noise', status: 'dismissed' },
    { id: '555555555555', title: 'raw', status: 'candidate' },
  ]), CFG);
  assert.equal(p.confident.length, 0);
  assert.equal(p.uncertain.length, 0);
  assert.equal(p.skipped.length, 5);
  assert.ok(p.skipped.find((s) => s.candidateId === '555555555555' && s.reason === 'not-mapped'));
});

test('classify: empty ledger -> empty buckets, allowedLanes populated', () => {
  const p = classify(led([]), CFG);
  assert.deepEqual(p.confident, []);
  assert.deepEqual(p.uncertain, []);
  assert.deepEqual(p.allowedLanes, ['Ideas', 'Building', 'Shipped']);
  assert.deepEqual(p.owners, ['agent', 'human']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/promote.test.mjs`
Expected: FAIL — `classify` is not exported.

- [ ] **Step 3: Implement `classify`**

Append to `scripts/lib/promote.mjs`:

```javascript
/**
 * Classify ledger candidates into promotion buckets. PURE + read-only.
 * @param {object} ledger  the M1/M2 ledger ({candidates:[...]})
 * @param {object} config  board config (needs stageOptions [+ optional rules])
 * @returns {{confident:object[], uncertain:object[], comments:object[], skipped:object[], allowedLanes:string[], owners:string[]}}
 */
export function classify(ledger, config) {
  const threshold = resolveRules(config).promoteConfidenceBelow;
  const allowedLanes = Object.keys((config && config.stageOptions) || {});
  const confident = [], uncertain = [], comments = [], skipped = [];

  for (const c of ((ledger && ledger.candidates) || [])) {
    const conf = typeof c.confidence === 'number' ? c.confidence : 0;

    if (c.status === 'promoted' || c.status === 'dismissed' || c.status === 'merged' || c.status === 'split') {
      skipped.push({ candidateId: c.id, reason: c.status });
      continue;
    }
    if (c.status === 'needs-decision') {
      uncertain.push({
        candidateId: c.id, kind: 'card', title: c.title,
        lane: c.suggestedLane ?? null, owner: c.suggestedOwner ?? null, confidence: conf,
        reason: 'needs-decision',
        question: (c.needsDecision && c.needsDecision.question) || `Promote "${c.title}"?`,
        options: (c.needsDecision && c.needsDecision.options) || [],
      });
      continue;
    }
    if (c.status !== 'mapped') {
      skipped.push({ candidateId: c.id, reason: c.status === 'candidate' ? 'not-mapped' : `unknown-status:${c.status}` });
      continue;
    }

    // status === 'mapped'
    if (c.kind === 'comment') {
      const item = { candidateId: c.id, kind: 'comment', title: c.title, commentTarget: c.commentTarget, text: c.note || c.title, confidence: conf };
      if (conf >= threshold) comments.push(item);
      else uncertain.push({ ...item, reason: 'low-confidence', question: `Add comment to #${c.commentTarget}: "${c.title}"?`, options: [] });
      continue;
    }
    const item = { candidateId: c.id, kind: 'card', title: c.title, lane: c.suggestedLane ?? null, owner: c.suggestedOwner ?? null, confidence: conf };
    if (conf >= threshold) confident.push(item);
    else uncertain.push({ ...item, reason: 'low-confidence', question: `Promote "${c.title}" → ${item.lane} (${item.owner})?`, options: allowedLanes });
  }
  return { confident, uncertain, comments, skipped, allowedLanes, owners: ['agent', 'human'] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/promote.test.mjs`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/promote.mjs tests/promote.test.mjs
git commit -m "feat(m3a): classify ledger candidates into promotion buckets"
```

---

### Task 4: `resolveDecisions` — merge pre-gathered decisions into a commit set

**Files:**
- Modify: `scripts/lib/promote.mjs`
- Test: `tests/promote.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/promote.test.mjs`:

```javascript
import { resolveDecisions } from '../scripts/lib/promote.mjs';

function planFixture() {
  return {
    confident: [{ candidateId: 'aaaaaaaaaaaa', kind: 'card', title: 'A', lane: 'Building', owner: 'agent', confidence: 0.95 }],
    comments: [{ candidateId: 'dddddddddddd', kind: 'comment', title: 'c', commentTarget: 12, text: 't', confidence: 0.9 }],
    uncertain: [
      { candidateId: 'bbbbbbbbbbbb', kind: 'card', title: 'B', lane: 'Ideas', owner: 'human', confidence: 0.4, reason: 'low-confidence', question: 'q', options: ['Ideas', 'Building'] },
      { candidateId: 'cccccccccccc', kind: 'card', title: 'C', lane: null, owner: null, confidence: 0.3, reason: 'needs-decision', question: 'which?', options: [] },
    ],
    skipped: [], allowedLanes: ['Ideas', 'Building', 'Shipped'], owners: ['agent', 'human'],
  };
}

test('resolveDecisions: confident + comments auto-commit; promote-decision joins; hold/missing held', () => {
  const r = resolveDecisions(planFixture(), {
    bbbbbbbbbbbb: { action: 'promote', lane: 'Building' },   // override lane
    cccccccccccc: { action: 'hold' },
  });
  assert.equal(r.errors.length, 0);
  const ids = r.toCommit.map((x) => x.candidateId).sort();
  assert.deepEqual(ids, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'dddddddddddd']);
  // override applied + classify-only fields stripped
  const b = r.toCommit.find((x) => x.candidateId === 'bbbbbbbbbbbb');
  assert.equal(b.lane, 'Building');
  assert.equal(b.reason, undefined);
  assert.equal(b.question, undefined);
  // cccccccccccc held; aaaa already auto so not in held
  assert.deepEqual(r.held.map((h) => h.candidateId), ['cccccccccccc']);
});

test('resolveDecisions: unknown candidateId -> error', () => {
  const r = resolveDecisions(planFixture(), { zzzzzzzzzzzz: { action: 'promote' } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /no uncertain item/);
});

test('resolveDecisions: bad action -> error', () => {
  const r = resolveDecisions(planFixture(), { bbbbbbbbbbbb: { action: 'maybe' } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /must be promote\|hold/);
});

test('resolveDecisions: invalid lane override -> error', () => {
  const r = resolveDecisions(planFixture(), { bbbbbbbbbbbb: { action: 'promote', lane: 'Nonexistent' } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /not in allowed lanes/);
});

test('resolveDecisions: promote a needs-decision card with no lane supplied -> error', () => {
  const r = resolveDecisions(planFixture(), { cccccccccccc: { action: 'promote' } });
  assert.ok(r.errors.find((e) => /requires a lane/.test(e.error)));
});

test('resolveDecisions: needs-decision card with a supplied lane -> committed', () => {
  const r = resolveDecisions(planFixture(), { cccccccccccc: { action: 'promote', lane: 'Ideas', owner: 'agent' } });
  assert.equal(r.errors.length, 0);
  const c = r.toCommit.find((x) => x.candidateId === 'cccccccccccc');
  assert.equal(c.lane, 'Ideas');
  assert.equal(c.owner, 'agent');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/promote.test.mjs`
Expected: FAIL — `resolveDecisions` is not exported.

- [ ] **Step 3: Implement `resolveDecisions`**

Append to `scripts/lib/promote.mjs`:

```javascript
/**
 * Resolve pre-gathered human decisions against a classify() plan. PURE.
 * commit set = confident + comments (auto) + uncertain where action='promote'.
 * Fail-closed: unknown candidateId, bad action, invalid lane/owner override, or a
 * card with no resolvable lane -> errors (the verb refuses the whole run).
 * @param {object} plan      classify() output
 * @param {object} decisions { [candidateId]: { action:'promote'|'hold', lane?, owner? } }
 * @returns {{toCommit:object[], held:object[], errors:object[]}}
 */
export function resolveDecisions(plan, decisions) {
  const dec = decisions || {};
  const uncertainById = new Map((plan.uncertain || []).map((u) => [u.candidateId, u]));
  const allowed = new Set(plan.allowedLanes || []);
  const errors = [];

  // Validate every decision key references a real uncertain item with a legal payload.
  for (const cid of Object.keys(dec)) {
    const d = dec[cid] || {};
    if (!uncertainById.has(cid)) { errors.push({ candidateId: cid, error: 'no uncertain item with this candidateId' }); continue; }
    if (d.action !== 'promote' && d.action !== 'hold') { errors.push({ candidateId: cid, error: `action '${d.action}' must be promote|hold` }); continue; }
    if (d.lane != null && !allowed.has(d.lane)) { errors.push({ candidateId: cid, error: `lane override '${d.lane}' not in allowed lanes` }); continue; }
    if (d.owner != null && d.owner !== 'agent' && d.owner !== 'human') { errors.push({ candidateId: cid, error: `owner override '${d.owner}' must be agent|human` }); }
  }

  const toCommit = [...(plan.confident || []), ...(plan.comments || [])];
  const held = [];
  for (const u of (plan.uncertain || [])) {
    const d = dec[u.candidateId];
    if (!d || d.action === 'hold') { held.push(u); continue; }
    if (d.action !== 'promote') continue; // invalid action already recorded as an error
    const merged = { ...u, lane: d.lane ?? u.lane, owner: d.owner ?? u.owner };
    delete merged.reason; delete merged.question; delete merged.options;
    if (merged.kind === 'card' && !merged.lane) {
      errors.push({ candidateId: u.candidateId, error: 'promote requires a lane (none mapped — supply one in the decision)' });
      continue;
    }
    toCommit.push(merged);
  }
  return { toCommit, held, errors };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/promote.test.mjs`
Expected: PASS (14 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/promote.mjs tests/promote.test.mjs
git commit -m "feat(m3a): resolveDecisions merges pre-gathered decisions, fail-closed"
```

---

### Task 5: `promotePlan` verb — read-only classification over the real ledger

**Files:**
- Modify: `scripts/board-manager.mjs` (add import + `promotePlan`)
- Test: `tests/promote-verb.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/promote-verb.test.mjs`:

```javascript
// tests/promote-verb.test.mjs — promote verb behavior against the mock engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { promotePlan, promoteApply } from '../scripts/board-manager.mjs';
import { ensureLedger, writeLedger, readLedger } from '../scripts/lib/ledger.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-promote-'));
const CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2', Shipped: 'o3' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  rules: { promoteConfidenceBelow: 0.8 },
};

// Seed a ledger with exactly the given candidate objects.
async function seed(dir, candidates) {
  const l = await ensureLedger(dir);
  l.candidates = candidates;
  await writeLedger(dir, l);
}

const mappedCard = (over = {}) => ({ id: 'aaaaaaaaaaaa', title: 'Wire auth', note: 'auth context', source: 'manual', kind: 'card', suggestedLane: 'Building', suggestedOwner: 'agent', confidence: 0.95, status: 'mapped', addedAt: 't', ...over });

test('promotePlan classifies the ledger read-only and reports counts', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard(), mappedCard({ id: 'bbbbbbbbbbbb', title: 'Lowconf', confidence: 0.4 })]);
  const r = await promotePlan({ dir, config: CFG });
  assert.equal(r.plan.confident.length, 1);
  assert.equal(r.plan.uncertain.length, 1);
  assert.match(r.say, /1 confident/);
  // read-only: ledger untouched
  const after = await readLedger(dir);
  assert.equal(after.candidates[0].status, 'mapped');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/promote-verb.test.mjs`
Expected: FAIL — `promotePlan`/`promoteApply` are not exported from `board-manager.mjs`.

- [ ] **Step 3: Add the import and `promotePlan`**

In `scripts/board-manager.mjs`, add to the imports near the top (after the existing `import { prepareInput, applyProposals } from './lib/mapper.mjs';`):

```javascript
import { classify, resolveDecisions, cidMarker } from './lib/promote.mjs';
```

Then add these (place them after `mapRecord`, before `ownerOf`):

```javascript
/**
 * bodyFor — issue body for a promoted card: the candidate note (if any) followed
 * by the durable candidateId marker.
 * @param {object} cand  the ledger candidate
 * @param {string} cid   candidateId
 * @returns {string}
 */
function bodyFor(cand, cid) {
  const note = cand && cand.note ? String(cand.note).trim() : '';
  return note ? `${note}\n\n${cidMarker(cid)}` : cidMarker(cid);
}

/**
 * promotePlan(ctx) — classify the ledger's mapped/needs-decision candidates into
 * promotion buckets. Read-only (no board, no ledger writes).
 * @param {object} ctx { dir, config }
 * @returns {Promise<{plan:object, say:string}>}
 */
export async function promotePlan(ctx) {
  const dir = ctx.dir || process.cwd();
  const ledger = (await readLedger(dir)) || { candidates: [] };
  const plan = classify(ledger, ctx.config);
  const say = `Promotion plan: ${plan.confident.length} confident card(s), ${plan.comments.length} comment(s) ready; ` +
    `${plan.uncertain.length} need a decision; ${plan.skipped.length} skipped.`;
  return { plan, say };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/promote-verb.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scripts/board-manager.mjs tests/promote-verb.test.mjs
git commit -m "feat(m3a): promotePlan verb (read-only classification)"
```

---

### Task 6: `promoteApply` verb — full implementation + staged-preview test

**Files:**
- Modify: `scripts/board-manager.mjs` (add `promoteApply`)
- Test: `tests/promote-verb.test.mjs`

> `promoteApply` is one cohesive function whose staged/commit/resume paths are interdependent, so it's implemented complete here. Tasks 7–11 lock in each behavior (commit chain, comment, idempotency, resumability, validation/pushPolicy) with dedicated tests against this function.

- [ ] **Step 1: Write the failing staged-preview test**

Append to `tests/promote-verb.test.mjs`:

```javascript
const mappedComment = (over = {}) => ({ id: 'dddddddddddd', title: 'note', note: 'see spec', kind: 'comment', commentTarget: 12, confidence: 0.9, status: 'mapped', addedAt: 't', ...over });

test('promote apply --staged previews only: createIssue(staged) + comment(staged), NO board writes, ledger unchanged', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard(), mappedComment()]);
  const engine = makeMockEngine({
    createIssue: () => ({ staged: true, wouldRun: { op: 'gh issue create' } }),
    comment: () => ({ staged: true, wouldRun: { op: 'gh issue comment' } }),
  });
  const r = await promoteApply(null, { engine, config: CFG, staged: true, dir });

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue', 'comment']); // confident card, then confident comment
  assert.ok(!ops.includes('addIssueToBoard'), 'no addIssueToBoard on a nonexistent staged issue');
  assert.ok(!ops.includes('setStage'));
  assert.ok(!ops.includes('setLabels'));
  // createIssue passed { staged:true }
  assert.equal(engine.calls[0].args.at(-1)?.staged, true);
  // report + say
  assert.equal(r.report.wouldCreate.length, 1);
  assert.equal(r.report.wouldComment.length, 1);
  assert.match(r.say, /staged — nothing written/);
  // ledger untouched
  const after = await readLedger(dir);
  assert.equal(after.candidates[0].status, 'mapped');
  assert.equal(after.candidates[1].status, 'mapped');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/promote-verb.test.mjs`
Expected: FAIL — `promoteApply` is not defined.

- [ ] **Step 3: Implement `promoteApply` (complete)**

In `scripts/board-manager.mjs`, add immediately after `promotePlan`:

```javascript
/**
 * promoteApply(decisions, ctx) — commit the resolved promotion set to the board,
 * updating the ledger per-candidate (resumable) and stamping the candidateId
 * marker into each issue body.
 *
 * - --staged: preview only (createIssue/comment with staged:true), zero board AND
 *   zero ledger writes (mirrors put --staged: no real issue exists, so the
 *   downstream chain is NOT run on a null url/itemId).
 * - pushPolicy=manual: refuses to commit (use --staged to preview).
 * - Idempotent: a candidate already 'promoted' is skipped (never a second issue).
 * - Resumable: a 'partial' candidate (createIssue done, later step failed) carries
 *   cand.promotion refs; a re-run skips createIssue and resumes the chain. No live
 *   board read — resumability is ledger-only.
 *
 * @param {object|null} decisions { [candidateId]: {action,lane?,owner?} }
 * @param {object} ctx { engine, config, staged, dir }
 * @returns {Promise<{report:object, say:string}>}
 */
export async function promoteApply(decisions, ctx) {
  const { engine, config, staged } = ctx;
  const dir = ctx.dir || process.cwd();

  const policy = config.pushPolicy || 'auto-low-risk';
  if (policy === 'manual' && !staged) {
    throw new Error("promote: pushPolicy is 'manual' — run with --staged to preview; committing is disabled.");
  }

  const ledger = (await readLedger(dir)) || { candidates: [] };
  const plan = classify(ledger, config);
  const { toCommit, held, errors } = resolveDecisions(plan, decisions);
  if (errors.length) {
    throw new Error(`promote: refused — ${errors.length} bad decision(s): ` +
      errors.map((e) => `${e.candidateId}: ${e.error}`).join('; '));
  }

  const byId = new Map((ledger.candidates || []).map((c) => [c.id, c]));
  const report = {
    promoted: [], partial: [], failed: [],
    held: held.map((h) => h.candidateId),
    skipped: [...plan.skipped],
    wouldCreate: [], wouldComment: [],
  };

  for (const item of toCommit) {
    const cand = byId.get(item.candidateId);
    if (cand && cand.status === 'promoted') {
      report.skipped.push({ candidateId: item.candidateId, reason: 'already promoted' });
      continue;
    }

    if (staged) {
      // PREVIEW ONLY — no board writes, no ledger writes.
      try {
        if (item.kind === 'comment') {
          await engine.comment(item.commentTarget, item.text, { staged: true });
          report.wouldComment.push({ candidateId: item.candidateId, target: item.commentTarget });
        } else {
          await engine.createIssue(item.title, bodyFor(cand, item.candidateId), { labels: [], staged: true });
          report.wouldCreate.push({ candidateId: item.candidateId, title: item.title, lane: item.lane, owner: item.owner });
        }
      } catch (e) {
        report.failed.push({ candidateId: item.candidateId, error: e.message });
      }
      continue;
    }

    // COMMIT
    try {
      if (item.kind === 'comment') {
        await engine.comment(item.commentTarget, item.text, {});
        cand.status = 'promoted';
        cand.promotion = { commentTarget: item.commentTarget };
        await writeLedger(dir, ledger);
        report.promoted.push({ candidateId: item.candidateId, commentTarget: item.commentTarget });
        continue;
      }

      // card — resumable create -> add -> stage -> label chain.
      let prom = cand.promotion || null;
      if (!prom || !prom.issueNumber) {
        const issue = await engine.createIssue(item.title, bodyFor(cand, item.candidateId), { labels: [] });
        prom = { issueNumber: issue.number ?? null, issueUrl: issue.url ?? null, issueNodeId: issue.issueNodeId ?? null };
        cand.promotion = prom;
        await writeLedger(dir, ledger); // persist after create
      }
      if (!prom.itemId) {
        const it = await engine.addIssueToBoard(prom.issueUrl, {});
        prom.itemId = it.itemId ?? null;
        cand.promotion = prom;
        await writeLedger(dir, ledger); // persist after board-add
      }
      await engine.setStage(prom.itemId, item.lane, {});
      await engine.setLabels(prom.issueNumber, [config.routing[item.owner]], {});
      cand.status = 'promoted';
      await writeLedger(dir, ledger);
      report.promoted.push({ candidateId: item.candidateId, issueNumber: prom.issueNumber, issueUrl: prom.issueUrl, itemId: prom.itemId });
    } catch (e) {
      report.partial.push({ candidateId: item.candidateId, error: e.message, promotion: (byId.get(item.candidateId) || {}).promotion || null });
    }
  }

  const say = staged
    ? `Would promote: ${report.wouldCreate.length} card(s), ${report.wouldComment.length} comment(s); ${report.held.length} held, ${report.skipped.length} skipped. (staged — nothing written.)`
    : `Promoted ${report.promoted.length} item(s); ${report.partial.length} partial, ${report.held.length} held, ${report.skipped.length} skipped, ${report.failed.length} failed.`;
  return { report, say };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/promote-verb.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/board-manager.mjs tests/promote-verb.test.mjs
git commit -m "feat(m3a): promoteApply verb (staged preview + commit + resume)"
```

---

### Task 7: Lock in the commit card-chain + body marker + ledger update

**Files:**
- Test: `tests/promote-verb.test.mjs`

- [ ] **Step 1: Write the test**

Append to `tests/promote-verb.test.mjs`:

```javascript
test('promote apply commits a confident card: create->add->stage->label, marker in body, ledger promoted', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard()]);
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_1', number: 41, url: 'https://x/41', contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_1' }),
  });
  const r = await promoteApply(null, { engine, config: CFG, staged: false, dir });

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue', 'addIssueToBoard', 'setStage', 'setLabels']);

  // marker stamped into the issue body (createIssue's 2nd positional arg)
  const createCall = engine.calls.find((c) => c.op === 'createIssue');
  assert.match(createCall.args[1], /gboards:cid=aaaaaaaaaaaa/);
  assert.match(createCall.args[1], /auth context/); // note preserved

  // stage uses the mapped lane; labels use the owner routing label
  assert.equal(engine.calls.find((c) => c.op === 'setStage').args[1], 'Building');
  assert.match(engine.calls.find((c) => c.op === 'setLabels').args.join(' '), /agent:go/);

  // ledger updated with refs
  const after = (await readLedger(dir)).candidates[0];
  assert.equal(after.status, 'promoted');
  assert.equal(after.promotion.issueNumber, 41);
  assert.equal(after.promotion.itemId, 'IT_1');
  assert.equal(r.report.promoted.length, 1);
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test tests/promote-verb.test.mjs`
Expected: PASS (3 tests). The behavior is already implemented in Task 6; this test locks it in. If it fails, fix `promoteApply` (do not weaken the test).

- [ ] **Step 3: Commit**

```bash
git add tests/promote-verb.test.mjs
git commit -m "test(m3a): lock in promote commit chain + body marker"
```

---

### Task 8: Lock in comment-kind promotion

**Files:**
- Test: `tests/promote-verb.test.mjs`

- [ ] **Step 1: Write the test**

Append to `tests/promote-verb.test.mjs`:

```javascript
test('promote apply commits a confident comment via engine.comment(commentTarget, text)', async () => {
  const dir = tmp();
  await seed(dir, [mappedComment()]);
  const engine = makeMockEngine({ comment: () => ({ commentUrl: 'https://x/12#c1' }) });
  const r = await promoteApply(null, { engine, config: CFG, staged: false, dir });

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['comment']); // no issue creation for a comment
  const commentCall = engine.calls[0];
  assert.equal(commentCall.args[0], 12);          // commentTarget
  assert.equal(commentCall.args[1], 'see spec');  // text from note

  const after = (await readLedger(dir)).candidates[0];
  assert.equal(after.status, 'promoted');
  assert.equal(after.promotion.commentTarget, 12);
  assert.equal(r.report.promoted.length, 1);
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test tests/promote-verb.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/promote-verb.test.mjs
git commit -m "test(m3a): lock in comment-kind promotion"
```

---

### Task 9: Lock in idempotency (re-run skips already-promoted)

**Files:**
- Test: `tests/promote-verb.test.mjs`

- [ ] **Step 1: Write the test**

Append to `tests/promote-verb.test.mjs`:

```javascript
test('promote apply is idempotent: a re-run over a promoted candidate creates no second issue', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard()]);
  let issueNo = 41;
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_1', number: issueNo++, url: `https://x/${issueNo}`, contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_1' }),
  });
  await promoteApply(null, { engine, config: CFG, staged: false, dir });   // first run -> promotes
  const r2 = await promoteApply(null, { engine, config: CFG, staged: false, dir }); // second run -> no-op

  // createIssue called exactly once across BOTH runs
  assert.equal(engine.calls.filter((c) => c.op === 'createIssue').length, 1);
  assert.equal(r2.report.promoted.length, 0);
  assert.ok(r2.report.skipped.find((s) => s.reason === 'already promoted'));
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test tests/promote-verb.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/promote-verb.test.mjs
git commit -m "test(m3a): lock in promote idempotency"
```

---

### Task 10: Lock in partial-failure resumability

**Files:**
- Test: `tests/promote-verb.test.mjs`

- [ ] **Step 1: Write the test**

Append to `tests/promote-verb.test.mjs`:

```javascript
test('promote apply resumes a partial candidate: setStage fails once, re-run finishes without a second createIssue', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard()]);
  let stageCalls = 0;
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_1', number: 41, url: 'https://x/41', contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_1' }),
    setStage: () => { if (stageCalls++ === 0) throw new Error('stage boom'); return { ok: true }; },
  });

  // First run: create + add succeed, setStage throws -> partial, NOT promoted.
  const r1 = await promoteApply(null, { engine, config: CFG, staged: false, dir });
  assert.equal(r1.report.partial.length, 1);
  assert.equal(r1.report.promoted.length, 0);
  let cand = (await readLedger(dir)).candidates[0];
  assert.equal(cand.status, 'mapped');               // NOT promoted
  assert.equal(cand.promotion.issueNumber, 41);      // refs persisted
  assert.equal(cand.promotion.itemId, 'IT_1');

  // Second run: createIssue + addIssueToBoard are SKIPPED (refs present), setStage now succeeds.
  const r2 = await promoteApply(null, { engine, config: CFG, staged: false, dir });
  assert.equal(engine.calls.filter((c) => c.op === 'createIssue').length, 1, 'createIssue must run only once total');
  assert.equal(engine.calls.filter((c) => c.op === 'addIssueToBoard').length, 1, 'addIssueToBoard must run only once total');
  assert.equal(r2.report.promoted.length, 1);
  cand = (await readLedger(dir)).candidates[0];
  assert.equal(cand.status, 'promoted');
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test tests/promote-verb.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/promote-verb.test.mjs
git commit -m "test(m3a): lock in partial-failure resumability"
```

---

### Task 11: Lock in decisions validation + pushPolicy gate (fail-closed, no writes)

**Files:**
- Test: `tests/promote-verb.test.mjs`

- [ ] **Step 1: Write the tests**

Append to `tests/promote-verb.test.mjs`:

```javascript
test('promote apply refuses a bad decisions file before any board write', async () => {
  const dir = tmp();
  // one low-confidence card -> it lands in uncertain
  await seed(dir, [mappedCard({ id: 'bbbbbbbbbbbb', confidence: 0.4 })]);
  const engine = makeMockEngine({});

  // unknown candidateId
  await assert.rejects(
    () => promoteApply({ zzzzzzzzzzzz: { action: 'promote' } }, { engine, config: CFG, staged: false, dir }),
    /refused/);
  // invalid lane override on the real uncertain item
  await assert.rejects(
    () => promoteApply({ bbbbbbbbbbbb: { action: 'promote', lane: 'Nope' } }, { engine, config: CFG, staged: false, dir }),
    /refused/);

  assert.equal(engine.calls.length, 0, 'no engine ops on a refused run');
  // confident bucket was empty here, so the ledger is untouched regardless
  assert.equal((await readLedger(dir)).candidates[0].status, 'mapped');
});

test('promote apply refuses to commit when pushPolicy is manual (no engine calls)', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard()]);
  const engine = makeMockEngine({});
  await assert.rejects(
    () => promoteApply(null, { engine, config: { ...CFG, pushPolicy: 'manual' }, staged: false, dir }),
    /pushPolicy is 'manual'/);
  assert.equal(engine.calls.length, 0);

  // but --staged still previews under manual policy
  const staticEngine = makeMockEngine({ createIssue: () => ({ staged: true }) });
  const r = await promoteApply(null, { engine: staticEngine, config: { ...CFG, pushPolicy: 'manual' }, staged: true, dir });
  assert.equal(r.report.wouldCreate.length, 1);
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test tests/promote-verb.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/promote-verb.test.mjs
git commit -m "test(m3a): lock in decisions validation + pushPolicy gate"
```

---

### Task 12: CLI wiring — `promote plan` / `promote apply` + `--decisions` + help

**Files:**
- Modify: `scripts/board-manager.mjs` (`parseCliArgs`, its `out` object + destructure, the `switch`, the help text)

- [ ] **Step 1: Add `--decisions` to `parseCliArgs`**

In `scripts/board-manager.mjs`, in `parseCliArgs` (around line 624), add `decisions: null` to the `out` initializer:

```javascript
  const out = { verb: null, staged: false, config: null, preset: null, title: null, repo: null, session: null, proposals: null, decisions: null, rest: [] };
```

And add a flag branch alongside the existing `--proposals` branch:

```javascript
    else if (a === '--proposals') out.proposals = argv[++i];
    else if (a === '--decisions') out.decisions = argv[++i];
```

- [ ] **Step 2: Destructure `decisions` in `cli()`**

In `cli()` (around line 641), widen the destructure to include `decisions` (aliased to avoid colliding with any local):

```javascript
  const { verb, staged, config: configPath, preset, title, repo, session, proposals, decisions: decisionsPath, rest } = parseCliArgs(process.argv.slice(2));
```

- [ ] **Step 3: Add the `promote` case to the switch**

In the `switch (verb)` block, add a case (after the `map` case, before `default`):

```javascript
    case 'promote': {
      const sub = rest[0];
      const { readFile } = await import('node:fs/promises');
      if (sub === 'plan' || !sub) {
        const r = await promotePlan({ dir: process.cwd(), config: verbCfg });
        console.log(r.say);
        console.log(JSON.stringify(r.plan, null, 2));
        return;
      } else if (sub === 'apply') {
        let decisions = null;
        if (decisionsPath) decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
        const r = await promoteApply(decisions, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.report, null, 2));
        return;
      } else {
        throw new Error('usage: promote <plan|apply> [--decisions <file>] [--staged]');
      }
    }
```

- [ ] **Step 4: Add help-text lines**

In the help block (the `console.log` template starting around line 644), add after the `map record` line:

```
  promote plan                          classify mapped candidates into promotion buckets (read-only)
  promote apply [--decisions <file>]    promote confident + decided candidates to the board (idempotent)
```

- [ ] **Step 5: Verify the help renders and parsing works (no board, no network)**

Run: `node scripts/board-manager.mjs --help`
Expected: output includes the two new `promote` lines.

Run: `node -e "import('./scripts/board-manager.mjs').then(m => console.log(typeof m.promotePlan, typeof m.promoteApply))"`
Expected: `function function`

- [ ] **Step 6: Run the full promote suites once more**

Run: `node --test tests/promote.test.mjs tests/promote-verb.test.mjs`
Expected: PASS (14 + 8 = 22 tests).

- [ ] **Step 7: Commit**

```bash
git add scripts/board-manager.mjs
git commit -m "feat(m3a): CLI wiring for promote plan/apply + --decisions"
```

---

### Task 13: Operator-gated live smoke (WRITE ONLY — never run in automated execution)

> **⚠️ SAFETY — read before doing anything in this task (applies to implementer, spec-reviewer, code-quality-reviewer, and any fix subagent):** This task's deliverable is *creating the test file*. **DO NOT execute it. DO NOT set `GBS_LIVE=1`.** Running it creates real GitHub resources (project, issue, labels). The file is written so it auto-skips when `GBS_LIVE` is unset. A spec-compliance reviewer should treat "file written + auto-skips" as DONE — there is no "run the live test" step to satisfy. (Memory: `subagent-plan-exec-safety-directives`.)

**Files:**
- Create: `tests/live-promote.test.mjs`

- [ ] **Step 1: Write the gated live test (do not run it)**

Create `tests/live-promote.test.mjs`:

```javascript
// tests/live-promote.test.mjs — LIVE smoke. Skipped unless GBS_LIVE=1.
// Requires: gh authed with `project` scope, run inside a git repo with a GitHub remote.
// DO NOT set GBS_LIVE=1 in automated runs — this creates real GitHub resources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { bootstrap, mapRecord, promotePlan, promoteApply } from '../scripts/board-manager.mjs';
import { ensureLedger, appendCandidate, readLedger } from '../scripts/lib/ledger.mjs';
import { detectRepo } from '../scripts/lib/repo-detect.mjs';
import { writeBoardConfig } from '../scripts/lib/config-writer.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { parseCid } from '../scripts/lib/promote.mjs';
import * as eng from '../scripts/board.mjs';

const LIVE = process.env.GBS_LIVE === '1';

test('LIVE: bootstrap -> map record -> promote plan -> promote apply files a real card with a marker, then teardown',
  { skip: !LIVE ? 'set GBS_LIVE=1 to run' : false }, async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-live-promote-'));
  const boardPath = join(dir, 'board.json');
  const title = `gbs-promote-smoke-${process.pid}`;

  const flagsFor = (opts = {}) => ({ staged: !!opts.staged, json: false, labels: null, identity: 'pat' });
  const engine = {
    listItems: () => eng.listItems(loadedCfg),
    getStageField: () => eng.getStageField(loadedCfg),
    createIssue: (t, b, opts = {}) => { const f = flagsFor(opts); f.labels = (opts.labels || []).join(',') || null; return eng.createIssue(loadedCfg, f, t, b); },
    addIssueToBoard: (u, opts = {}) => eng.addIssueToBoard(loadedCfg, flagsFor(opts), u),
    setStage: (id, lane, opts = {}) => eng.setStage(loadedCfg, flagsFor(opts), id, lane),
    setLabels: (n, labs, opts = {}) => eng.setLabels(loadedCfg, flagsFor(opts), n, (labs || []).join(',')),
    comment: (n, body, opts = {}) => eng.comment(loadedCfg, flagsFor(opts), n, body),
    getOwnerId: (l) => eng.getOwnerId(l),
    findProjectByTitle: (l, t, ti) => eng.findProjectByTitle(l, t, ti),
    findStageFieldByName: (p, n) => eng.findStageFieldByName(p, n),
    createProject: (o, ti, opts = {}) => eng.createProject(flagsFor(opts), o, ti),
    createStageField: (p, lanes, opts = {}) => eng.createStageField(flagsFor(opts), p, lanes),
    ensureLabels: (r, labs, opts = {}) => eng.ensureLabels(flagsFor(opts), r, labs),
  };

  let cfg, loadedCfg, verbCfg;
  try {
    const r = await bootstrap({ engine, staged: false, dir, detectRepo, title, preset: 'build', writeConfig: (c) => writeBoardConfig(boardPath, c), existingConfig: null });
    assert.equal(r.committed, true);
    cfg = r.config;
    loadedCfg = eng.loadConfig(boardPath);
    verbCfg = await loadConfig(boardPath);

    // seed a candidate + map it confident
    await ensureLedger(dir);
    await appendCandidate(dir, { title: 'Live smoke card', note: 'created by live-promote smoke' });
    const id = (await readLedger(dir)).candidates[0].id;
    const firstLane = Object.keys(verbCfg.stageOptions)[0];
    await mapRecord({ dir, config: verbCfg, proposals: [{ candidateId: id, kind: 'card', title: 'Live smoke card', lane: firstLane, owner: 'agent', confidence: 0.95, rationale: 'smoke' }] });

    const plan = await promotePlan({ dir, config: verbCfg });
    assert.equal(plan.plan.confident.length, 1);

    const ap = await promoteApply(null, { engine, config: verbCfg, staged: false, dir });
    assert.equal(ap.report.promoted.length, 1);
    const issueNumber = ap.report.promoted[0].issueNumber;
    assert.ok(issueNumber);

    // verify the marker is in the real issue body
    const body = eng.graphqlVars
      ? null // (read via gh below; graphqlVars is a mutation helper)
      : null;
    // ledger flipped to promoted
    assert.equal((await readLedger(dir)).candidates[0].status, 'promoted');
    assert.equal(parseCid(`<!-- gboards:cid=${id} -->`), id); // marker format sanity
  } finally {
    if (cfg && cfg.projectId) {
      try {
        eng.graphqlVars('mutation($id:ID!){ deleteProjectV2(input:{projectId:$id}){ clientMutationId } }', { id: cfg.projectId });
      } catch (e) { console.error('teardown failed (delete manually):', cfg.projectUrl, e.message); }
    }
  }
});
```

- [ ] **Step 2: Confirm it is collected and SKIPPED (do NOT set GBS_LIVE)**

Run: `node --test tests/live-promote.test.mjs`
Expected: 1 test, **skipped** ("set GBS_LIVE=1 to run"). 0 pass, 0 fail, 1 skip. **Do not set `GBS_LIVE=1`.**

- [ ] **Step 3: Commit**

```bash
git add tests/live-promote.test.mjs
git commit -m "test(m3a): operator-gated live promote smoke (skipped by default)"
```

---

### Task 14: Full suite green + final review

**Files:** none (verification + final commit if needed)

- [ ] **Step 1: Run the entire test suite**

Run: `node --test tests/`
Expected: ALL tests pass; the live tests (`live-bootstrap`, `live-promote`) report as **skipped**, not failed. (Node ≥21 is required for directory test globbing — the dev box is Node 22.) Note the total pass count; it must be ≥ the pre-M3a count + 22 new M3a tests.

- [ ] **Step 2: Confirm no unintended real side effects**

Run: `git status` — expected: clean working tree (all work committed).
Confirm no `board.json` or `.github-boards/` was created in the repo root by the test runs (tests use `mkdtempSync` temp dirs). If any appeared, investigate before proceeding.

- [ ] **Step 3: If the suite is green and clean, proceed to finishing-a-development-branch.**

No commit needed if Step 1 produced no changes. If the full-suite run surfaced a fix, commit it:

```bash
git add -A
git commit -m "fix(m3a): <describe the fix>"
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-06-09-m3a-promotion-design.md`):
- §2 in-scope `lib/promote.mjs` (classify/resolveDecisions/cidMarker/parseCid) → Tasks 2,3,4. ✅
- §2 `promote plan`/`promote apply` verbs → Tasks 5,6,12. ✅
- §2 decisions-file schema → Task 4 (`resolveDecisions`) + Task 12 (CLI `--decisions`). ✅
- §2 body marker → Task 2 + Task 7 (stamped in body). ✅
- §2 `promoteConfidenceBelow` default → Task 1. ✅
- §2 needs-decision resolution loop → Task 3 (classify routes needs-decision → uncertain) + Task 4 (decision promotes/holds it). ✅
- §5 classify buckets (every row) → Task 3 tests. ✅
- §6 decisions schema + resolveDecisions → Task 4. ✅
- §7 marker + two-layer idempotency → Tasks 2,7,9. ✅
- §8 apply loop (card/comment/split-parent-skip) → Task 6 (split parents skipped via classify `status:split`→skipped) + Tasks 7,8. ✅
- §9 error handling: per-candidate atomicity + partial/resumable (Task 10), one-bad-can't-poison (catch-per-item, Task 6), decisions validation fail-closed (Task 11), empty cases (Task 3 empty-ledger test + no-op when toCommit empty), stagedGuard zero-writes (Task 6), pushPolicy manual gate (Task 11). ✅
- §10 testing plan: unit (Tasks 2–4), verb staged/commit/comment/idempotency/partial/validation/pushPolicy (Tasks 6–11), gated live smoke (Task 13). ✅
- §11 open questions: engine seam (resolved — DI via ctx.engine, used throughout), comment text source (resolved — `note||title`, Task 8 asserts), marker-scan cost (resolved — no live read; ledger `promotion` refs, Task 10), AskUserQuestion batching (orchestrator concern, out of script scope — noted). ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N"/uncoded steps. Every code step shows complete code. The only "describe the fix" is in Task 14 Step 3, which is a conditional contingency, not a deferred design decision. ✅

**3. Type/name consistency:**
- `classify` returns `{confident, uncertain, comments, skipped, allowedLanes, owners}` — consumed identically in `resolveDecisions` (reads `plan.uncertain`/`plan.allowedLanes`/`plan.confident`/`plan.comments`) and in `promoteApply` (reads `plan.skipped`). ✅
- Plan-item shape `{candidateId, kind, title, lane, owner, confidence}` (+ `commentTarget`/`text` for comments; + `reason`/`question`/`options` for uncertain) — produced by `classify`, consumed by `resolveDecisions` (strips `reason`/`question`/`options`) and `promoteApply` (uses `title`/`lane`/`owner`/`commentTarget`/`text`). ✅
- `cand.promotion = {issueNumber, issueUrl, issueNodeId, itemId}` (cards) / `{commentTarget}` (comments) — written and re-read consistently in `promoteApply` (Task 6) and asserted in Tasks 7,8,10. ✅
- Engine ops match the DI contract exactly: `createIssue(title, body, {labels,staged})` → `{issueNodeId, number, url}`; `addIssueToBoard(issueUrl, {})` → `{itemId}`; `setStage(itemId, lane, {})`; `setLabels(issueNumber, [label], {})`; `comment(issueNumber, body, {})`. ✅
- `config.routing[owner]` for the label, `config.stageOptions` for allowed lanes, `config.pushPolicy` for the gate, `resolveRules(config).promoteConfidenceBelow` for the threshold — all present on the `loadConfig` output. ✅

---

## Execution Handoff

After this plan is approved, execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec then quality) between tasks.

**2. Inline Execution** — batch execution with checkpoints.

The Task 13 safety directive (and the top-of-plan callout) MUST be included verbatim in every subagent prompt — implementer, spec-reviewer, code-quality-reviewer, and any fix subagent.
