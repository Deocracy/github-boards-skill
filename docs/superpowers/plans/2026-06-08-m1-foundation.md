# M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give github-boards a two-tier bootstrap — an always-on intent ledger plus an approval-gated `bootstrap` verb that provisions a real GitHub Project (v2) from the current repo.

**Architecture:** Two new gitignored files — `.github-boards/ledger.json` (intent + candidate cards) and `board.json` (the live binding). New `lib/` modules (`ledger`, `repo-detect`, `config-writer`) are pure-ish and fs/cli-only; four provisioning ops are added to the engine (`board.mjs`) behind the existing `stagedGuard()`; two verbs (`bootstrap`, `ledger`) join the verb layer; the SessionStart hook gains a Tier-0 ensure-ledger step. The fail-closed `loadConfig` is untouched.

**Tech Stack:** Node ≥18 (ESM), `node:test`, `gh` CLI + GitHub GraphQL (via `gh api graphql`), no third-party deps.

**Spec:** [docs/superpowers/specs/2026-06-08-m1-foundation-design.md](../specs/2026-06-08-m1-foundation-design.md)

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `scripts/lib/ledger.mjs` | **New** | Tier-0 intent ledger: ensure/read/append/setIntent + content-hash id. Mirrors `state.mjs`. fs-only. |
| `scripts/lib/repo-detect.mjs` | **New** | Resolve `{owner, repo, nameWithOwner}` from the current git remote via `gh repo view`. Fail-closed. |
| `scripts/lib/config-writer.mjs` | **New** | Persist `board.json` (the config loader is read-only today). |
| `scripts/board.mjs` | **Mod** | Add `graphqlVars` helper + read ops (`getOwnerId`, `findProjectByTitle`, `findStageFieldByName`) + write ops (`createProject`, `createStageField`, `ensureLabels`) behind `stagedGuard`. |
| `scripts/board-manager.mjs` | **Mod** | Add `bootstrap` + `ledger` verbs; extend `makeRealEngine` + CLI dispatch (bypassing `loadConfig` for these two). |
| `hooks/SessionStart/load-board.mjs` | **Mod** | `decide()` ensures the ledger first (always), folds candidate count into the injected note, stays silent when there's nothing to say. |
| `tests/helpers/mock-engine.mjs` | **Mod** | Record the new provisioning ops. |
| `tests/ledger.test.mjs` | **New** | Unit tests for the ledger module. |
| `tests/repo-detect.test.mjs` | **New** | Unit tests for repo detection (injected runner). |
| `tests/config-writer.test.mjs` | **New** | Round-trip + validation tests. |
| `tests/bootstrap.test.mjs` | **New** | `bootstrap`/`ledger` verb tests against the mock engine. |
| `tests/hooks.ledger.test.mjs` | **New** | SessionStart `decide()` ledger behavior. |
| `tests/live-bootstrap.test.mjs` | **New** | Gated live integration smoke (creates + tears down a throwaway board). |
| `board.example.json` | **Mod** | Document the three new optional fields. |

`.gitignore` already ignores `board.json` and `.github-boards/` — no change needed.

---

## Task 1: Ledger module (`lib/ledger.mjs`)

**Files:**
- Create: `scripts/lib/ledger.mjs`
- Test: `tests/ledger.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/ledger.test.mjs`:

```js
// tests/ledger.test.mjs — unit tests for scripts/lib/ledger.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { ensureLedger, readLedger, appendCandidate, setIntent, candidateId } from '../scripts/lib/ledger.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-ledger-'));

test('readLedger returns null for a fresh temp dir (no file)', async () => {
  assert.equal(await readLedger(tmp()), null);
});

test('ensureLedger creates a default ledger and is idempotent', async () => {
  const dir = tmp();
  const l1 = await ensureLedger(dir);
  assert.equal(l1.ledgerVersion, 1);
  assert.deepEqual(l1.candidates, []);
  assert.equal(l1.intent.wantsBoard, null);
  assert.equal(l1.intent.boundBoard, null);
  assert.equal(l1.intent.pushPolicy, 'on-approval');
  assert.equal(l1.intent.pullCadence, 'session-start');
  // second call must not reset it (idempotent): mutate, re-ensure, mutation survives
  await appendCandidate(dir, { title: 'keep me' });
  const l2 = await ensureLedger(dir);
  assert.equal(l2.candidates.length, 1);
});

test('candidateId is a stable 12-char hash, case/space-insensitive', () => {
  const a = candidateId('Fix the bug');
  const b = candidateId('  fix the bug ');
  assert.equal(a, b);
  assert.equal(a.length, 12);
});

test('appendCandidate adds a candidate with defaults and persists', async () => {
  const dir = tmp();
  await appendCandidate(dir, { title: 'Submit form', source: 'superpowers:brainstorming' });
  const l = await readLedger(dir);
  assert.equal(l.candidates.length, 1);
  const c = l.candidates[0];
  assert.equal(c.title, 'Submit form');
  assert.equal(c.source, 'superpowers:brainstorming');
  assert.equal(c.status, 'candidate');
  assert.equal(c.suggestedLane, null);
  assert.equal(c.suggestedOwner, null);
  assert.ok(c.id && c.addedAt);
});

test('appendCandidate dedups by content-hash (same title appended twice -> one)', async () => {
  const dir = tmp();
  await appendCandidate(dir, { title: 'Same task' });
  await appendCandidate(dir, { title: ' same task ' });
  const l = await readLedger(dir);
  assert.equal(l.candidates.length, 1);
});

test('setIntent merges into intent and persists', async () => {
  const dir = tmp();
  await setIntent(dir, { wantsBoard: true, boundBoard: { projectNumber: 7, projectUrl: 'u' } });
  const l = await readLedger(dir);
  assert.equal(l.intent.wantsBoard, true);
  assert.deepEqual(l.intent.boundBoard, { projectNumber: 7, projectUrl: 'u' });
  assert.equal(l.intent.pushPolicy, 'on-approval'); // untouched default preserved
});

test('readLedger throws a clear error on malformed JSON', async () => {
  const dir = tmp();
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(dir, '.github-boards'), { recursive: true });
  await writeFile(join(dir, '.github-boards', 'ledger.json'), '{ bad', 'utf8');
  await assert.rejects(() => readLedger(dir), (e) => e.message.includes('malformed JSON'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/ledger.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/lib/ledger.mjs'`.

- [ ] **Step 3: Implement `scripts/lib/ledger.mjs`**

```js
// scripts/lib/ledger.mjs — Tier-0 intent ledger helpers.
//
// Mirrors state.mjs. The ledger is gitignored working state at
// <dir>/.github-boards/ledger.json. It records (a) board INTENT (does this
// project want a board? which one, if bound? push/pull policy) and (b)
// CANDIDATE items collected before they are committed to a board.
//
//   ensureLedger(dir)            — create-if-absent → return the ledger
//   readLedger(dir)              — read; null if missing; throws on bad JSON
//   appendCandidate(dir, item)   — add a candidate (deduped by content hash)
//   setIntent(dir, partial)      — shallow-merge into ledger.intent
//   candidateId(title)           — stable 12-char content hash (dedup key)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const LEDGER_DIR = '.github-boards';
const LEDGER_FILE = 'ledger.json';

function ledgerPath(dir) {
  return join(dir, LEDGER_DIR, LEDGER_FILE);
}

function defaultLedger() {
  return {
    ledgerVersion: 1,
    createdAt: new Date().toISOString(),
    intent: {
      wantsBoard: null,
      boundBoard: null,
      pushPolicy: 'on-approval',
      pullCadence: 'session-start',
    },
    candidates: [],
  };
}

/**
 * Stable dedup key for a candidate: lowercased/trimmed title -> 12 hex chars.
 * @param {string} title
 * @returns {string}
 */
export function candidateId(title) {
  return createHash('sha256').update(String(title).trim().toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * Read <dir>/.github-boards/ledger.json. null if absent; throws on bad JSON.
 * @param {string} dir
 * @returns {Promise<object|null>}
 */
export async function readLedger(dir) {
  const p = ledgerPath(dir);
  let raw;
  try {
    raw = await readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`ledger.mjs: malformed JSON in ${p}: ${e.message}`);
  }
}

async function writeLedger(dir, ledger) {
  const d = join(dir, LEDGER_DIR);
  await mkdir(d, { recursive: true });
  const p = join(d, LEDGER_FILE);
  await writeFile(p, JSON.stringify(ledger, null, 2), 'utf8');
  return p;
}

/**
 * Create the ledger if absent; otherwise return the existing one (idempotent).
 * @param {string} dir
 * @returns {Promise<object>}
 */
export async function ensureLedger(dir) {
  const existing = await readLedger(dir);
  if (existing) return existing;
  const fresh = defaultLedger();
  await writeLedger(dir, fresh);
  return fresh;
}

/**
 * Append a candidate, deduped by content hash. Returns the updated ledger.
 * @param {string} dir
 * @param {{title:string, note?:string, source?:string, suggestedLane?:string|null, suggestedOwner?:string|null, id?:string}} candidate
 * @returns {Promise<object>}
 */
export async function appendCandidate(dir, candidate) {
  if (!candidate || !candidate.title) {
    throw new Error('appendCandidate: candidate.title is required');
  }
  const ledger = (await readLedger(dir)) || defaultLedger();
  const id = candidate.id || candidateId(candidate.title);
  if (ledger.candidates.some((c) => c.id === id)) {
    return ledger; // dedup: identical content already present
  }
  ledger.candidates.push({
    id,
    title: candidate.title,
    note: candidate.note || '',
    source: candidate.source || 'unknown',
    suggestedLane: candidate.suggestedLane ?? null,
    suggestedOwner: candidate.suggestedOwner ?? null,
    addedAt: new Date().toISOString(),
    status: 'candidate',
  });
  await writeLedger(dir, ledger);
  return ledger;
}

/**
 * Shallow-merge `partial` into ledger.intent and persist.
 * @param {string} dir
 * @param {object} partial
 * @returns {Promise<object>}
 */
export async function setIntent(dir, partial) {
  const ledger = (await readLedger(dir)) || defaultLedger();
  ledger.intent = { ...ledger.intent, ...partial };
  await writeLedger(dir, ledger);
  return ledger;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/ledger.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ledger.mjs tests/ledger.test.mjs
git commit -m "feat(ledger): Tier-0 intent ledger module with content-hash dedup"
```

---

## Task 2: Repo detection (`lib/repo-detect.mjs`)

**Files:**
- Create: `scripts/lib/repo-detect.mjs`
- Test: `tests/repo-detect.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/repo-detect.test.mjs`:

```js
// tests/repo-detect.test.mjs — unit tests for scripts/lib/repo-detect.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRepo, RepoDetectError } from '../scripts/lib/repo-detect.mjs';

test('detectRepo parses owner/name/nameWithOwner from gh JSON', () => {
  const runner = () => JSON.stringify({
    name: 'github-boards-skill',
    nameWithOwner: 'Deocracy/github-boards-skill',
    owner: { id: 'O_1', login: 'Deocracy' },
  });
  const r = detectRepo(runner);
  assert.deepEqual(r, {
    owner: 'Deocracy',
    repo: 'github-boards-skill',
    nameWithOwner: 'Deocracy/github-boards-skill',
  });
});

test('detectRepo falls back to owner/name when nameWithOwner is absent', () => {
  const runner = () => JSON.stringify({ name: 'r', owner: { login: 'o' } });
  assert.equal(detectRepo(runner).nameWithOwner, 'o/r');
});

test('detectRepo throws RepoDetectError on missing owner/name', () => {
  const runner = () => JSON.stringify({ owner: {} });
  assert.throws(() => detectRepo(runner), (e) => e instanceof RepoDetectError && e.refusal === true);
});

test('detectRepo throws RepoDetectError on unparseable output', () => {
  const runner = () => 'not json';
  assert.throws(() => detectRepo(runner), (e) => e instanceof RepoDetectError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/repo-detect.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/lib/repo-detect.mjs`**

```js
// scripts/lib/repo-detect.mjs — resolve the current repo from the git remote.
//
// detectRepo(runner) is pure given an injected `runner` that returns the raw
// `gh repo view --json owner,name,nameWithOwner` stdout. The default runner
// shells out to gh. Fail-closed: a RepoDetectError (a refusal) is thrown when
// no GitHub repo can be resolved, so bootstrap stops with a legible message
// instead of guessing.

import { spawnSync } from 'node:child_process';

export class RepoDetectError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RepoDetectError';
    this.refusal = true;
  }
}

/**
 * @param {() => string} [runner] returns `gh repo view --json ...` stdout
 * @returns {{owner:string, repo:string, nameWithOwner:string}}
 */
export function detectRepo(runner = defaultRunner) {
  const out = runner();
  let data;
  try {
    data = JSON.parse(out);
  } catch (e) {
    throw new RepoDetectError(`could not parse \`gh repo view\` output: ${e.message}`);
  }
  const owner = data && data.owner && data.owner.login;
  const repo = data && data.name;
  if (!owner || !repo) {
    throw new RepoDetectError(
      'no GitHub repo detected for the current directory. ' +
      'Run bootstrap with --repo owner/name to name one explicitly, ' +
      'or check `gh repo view`.'
    );
  }
  return { owner, repo, nameWithOwner: data.nameWithOwner || `${owner}/${repo}` };
}

function defaultRunner() {
  const r = spawnSync('gh', ['repo', 'view', '--json', 'owner,name,nameWithOwner'], {
    encoding: 'utf8',
    shell: false,
  });
  if (r.error) throw new RepoDetectError(`failed to spawn gh: ${r.error.message}`);
  if (r.status !== 0) {
    throw new RepoDetectError(
      `\`gh repo view\` failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}. ` +
      'Are you in a git repo with a GitHub remote? Use --repo owner/name to name one.'
    );
  }
  return (r.stdout || '').trim();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/repo-detect.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/repo-detect.mjs tests/repo-detect.test.mjs
git commit -m "feat(repo-detect): resolve current repo from gh, fail-closed"
```

---

## Task 3: Config writer (`lib/config-writer.mjs`)

**Files:**
- Create: `scripts/lib/config-writer.mjs`
- Test: `tests/config-writer.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/config-writer.test.mjs`:

```js
// tests/config-writer.test.mjs — unit tests for scripts/lib/config-writer.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { writeBoardConfig } from '../scripts/lib/config-writer.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';

const fullCfg = () => ({
  owner: 'Deocracy',
  ownerType: 'Organization',
  projectNumber: 7,
  projectId: 'PVT_x',
  repo: 'Deocracy/github-boards-skill',
  stageFieldId: 'PVTSSF_x',
  stageOptions: { Ideas: 'o1', Shipped: 'o2' },
  preset: 'build',
  routing: { agent: 'agent:go', human: 'needs-claude' },
  projectUrl: 'https://github.com/orgs/Deocracy/projects/7',
  pushPolicy: 'on-approval',
  pullCadence: 'session-start',
});

test('writeBoardConfig writes a board.json that loadConfig round-trips', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-cfgw-'));
  const path = join(dir, 'board.json');
  await writeBoardConfig(path, fullCfg());
  const loaded = await loadConfig(path);
  assert.equal(loaded.projectId, 'PVT_x');
  assert.equal(loaded.stageFieldId, 'PVTSSF_x');
  assert.deepEqual(loaded.stageOptions, { Ideas: 'o1', Shipped: 'o2' });
  assert.equal(loaded.preset.name, 'build'); // loadConfig resolves the preset object
});

test('writeBoardConfig refuses a config missing required keys', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-cfgw-'));
  const path = join(dir, 'board.json');
  const bad = fullCfg();
  delete bad.projectId;
  await assert.rejects(() => writeBoardConfig(path, bad), (e) => /projectId/.test(e.message));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/config-writer.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/lib/config-writer.mjs`**

```js
// scripts/lib/config-writer.mjs — persist board.json (the loader is read-only).
//
// writeBoardConfig validates the minimum binding keys before writing so a
// half-built config never lands on disk in a shape loadConfig would later
// reject. Used by the bootstrap verb's write-as-you-go resumability.

import { writeFile } from 'node:fs/promises';

const REQUIRED = ['owner', 'projectNumber', 'projectId', 'repo', 'stageFieldId', 'stageOptions', 'preset', 'routing'];

/**
 * @param {string} path  absolute path to board.json
 * @param {object} cfg   the binding config
 * @returns {Promise<string>} the path written
 */
export async function writeBoardConfig(path, cfg) {
  for (const k of REQUIRED) {
    if (cfg[k] === undefined || cfg[k] === null) {
      throw new Error(`writeBoardConfig: config missing required key '${k}'`);
    }
  }
  if (typeof cfg.projectNumber !== 'number') {
    throw new Error(`writeBoardConfig: projectNumber must be a number, got ${typeof cfg.projectNumber}`);
  }
  if (typeof cfg.stageOptions !== 'object' || Array.isArray(cfg.stageOptions) || Object.keys(cfg.stageOptions).length === 0) {
    throw new Error('writeBoardConfig: stageOptions must be a non-empty object');
  }
  await writeFile(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return path;
}
```

> Note: `writeBoardConfig` requires the FINAL shape, so no partial `board.json` is ever written. The bootstrap verb persists the complete binding once (Task 5). Resumability after a mid-provision failure comes from (a) a complete `board.json` passed back as `existingConfig` on a re-run, and (b) the adopt-by-title path (Task 5 reads any existing `board.json` raw, then `findProjectByTitle`/`findStageFieldByName` rediscover already-created GitHub objects).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/config-writer.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/config-writer.mjs tests/config-writer.test.mjs
git commit -m "feat(config-writer): validated board.json writer"
```

---

## Task 4: Engine provisioning ops (`board.mjs`)

Adds a complex-variable GraphQL helper plus three read ops and three write ops. The write ops route through the existing `stagedGuard()` so a staged run prints the mutation and writes nothing. Real network calls are proven in the live smoke (Task 7); here we unit-test the staged plans and the helper's request body.

**Files:**
- Modify: `scripts/board.mjs` (add helper + ops near the other ops; export them in the bottom `export {}` block)
- Test: `tests/provision.test.mjs` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/provision.test.mjs`:

```js
// tests/provision.test.mjs — staged-mode + helper tests for board.mjs provisioning ops
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createStageField, ensureLabels, buildGraphqlInput } from '../scripts/board.mjs';

const staged = { staged: true, json: false };

test('createProject in staged mode returns the planned mutation, writes nothing', () => {
  const r = createProject(staged, 'O_owner', 'my-repo board');
  assert.equal(r.staged, true);
  assert.equal(r.wouldRun.op, 'createProjectV2');
  assert.equal(r.wouldRun.ownerId, 'O_owner');
  assert.equal(r.wouldRun.title, 'my-repo board');
});

test('createStageField in staged mode plans the field + all lane options', () => {
  const r = createStageField(staged, 'PVT_1', ['Ideas', 'Building', 'Shipped']);
  assert.equal(r.staged, true);
  assert.equal(r.wouldRun.op, 'createProjectV2Field');
  assert.equal(r.wouldRun.name, 'Stage');
  assert.deepEqual(r.wouldRun.options, ['Ideas', 'Building', 'Shipped']);
});

test('ensureLabels in staged mode plans the labels, writes nothing', () => {
  const r = ensureLabels(staged, 'o/r', ['agent:go', 'needs-claude']);
  assert.equal(r.staged, true);
  assert.equal(r.wouldRun.op, 'gh label create');
  assert.deepEqual(r.wouldRun.labels, ['agent:go', 'needs-claude']);
});

test('buildGraphqlInput produces a {query, variables} JSON body string', () => {
  const body = buildGraphqlInput('query($l:String!){x}', { l: 'Deocracy' });
  const parsed = JSON.parse(body);
  assert.equal(parsed.query, 'query($l:String!){x}');
  assert.deepEqual(parsed.variables, { l: 'Deocracy' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/provision.test.mjs`
Expected: FAIL — `createProject`/`buildGraphqlInput` not exported.

- [ ] **Step 3: Add the helper + ops to `scripts/board.mjs`**

Add `buildGraphqlInput` + `graphqlVars` next to the existing `graphql()` helper (after it):

```js
// Build the request body for `gh api graphql --input -`. Exposed for testing.
function buildGraphqlInput(query, variables = {}) {
  return JSON.stringify({ query, variables });
}

// Like graphql(), but passes arbitrary (incl. array/object) variables via
// `gh api graphql --input -`. The scalar-only graphql() helper above cannot
// carry the singleSelectOptions array createProjectV2Field needs.
function graphqlVars(query, variables = {}) {
  const out = sh(["api", "graphql", "--input", "-"], { input: buildGraphqlInput(query, variables) });
  const parsed = JSON.parse(out);
  if (parsed.errors) throw new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`);
  return parsed.data;
}
```

Add the MAKE-tier provisioning ops (place them in the `// MAKE` section, after `addIssueToBoard`):

```js
// getOwnerId — resolve an owner login to its node id + type (User/Organization).
// Read-only. ownerType is read from __typename so callers need not know it up front.
function getOwnerId(login) {
  const q = `query($login:String!){ repositoryOwner(login:$login){ id __typename } }`;
  const data = graphql(q, { login });
  const o = data.repositoryOwner;
  if (!o) throw new Refusal(`owner '${login}' not found (check the org/user login)`);
  return { ownerId: o.id, ownerType: o.__typename }; // "User" | "Organization"
}

// findProjectByTitle — return an existing ProjectV2 with this title under the
// owner, or null. Used by bootstrap to ADOPT instead of duplicating. Read-only.
function findProjectByTitle(login, ownerType, title) {
  const ownerSel = String(ownerType).toLowerCase() === 'user' ? 'user' : 'organization';
  const q = `query($login:String!){
    ${ownerSel}(login:$login){ projectsV2(first:100){ nodes { id number title url } } }
  }`;
  const data = graphql(q, { login });
  const nodes = data[ownerSel]?.projectsV2?.nodes || [];
  const hit = nodes.find((n) => n.title === title);
  return hit ? { projectId: hit.id, projectNumber: hit.number, url: hit.url } : null;
}

// findStageFieldByName — return an existing single-select field by name on a
// project, or null. Used by bootstrap to ADOPT an existing Stage field. Read-only.
function findStageFieldByName(projectId, name) {
  const q = `query($id:ID!){
    node(id:$id){ ... on ProjectV2 { fields(first:50){ nodes {
      __typename ... on ProjectV2SingleSelectField { id name options { id name } }
    } } } }
  }`;
  const data = graphql(q, { id: projectId });
  const nodes = data.node?.fields?.nodes || [];
  const f = nodes.find((n) => n.__typename === 'ProjectV2SingleSelectField' && n.name === name);
  return f ? { stageFieldId: f.id, options: f.options.map((o) => ({ label: o.name, optionId: o.id })) } : null;
}

// createProject — createProjectV2 under an owner. Staged-previewable.
function createProject(flags, ownerId, title) {
  const plan = { op: "createProjectV2", ownerId, title };
  return stagedGuard(flags, plan, () => {
    const q = `mutation($ownerId:ID!,$title:String!){
      createProjectV2(input:{ownerId:$ownerId,title:$title}){ projectV2 { id number url } }
    }`;
    const data = graphql(q, { ownerId, title });
    const p = data.createProjectV2.projectV2;
    return { projectId: p.id, projectNumber: p.number, url: p.url };
  });
}

// createStageField — one createProjectV2Field (SINGLE_SELECT) with all lane
// options inline. Uses graphqlVars (array variable). Staged-previewable.
function createStageField(flags, projectId, lanes) {
  const options = lanes.map((name) => ({ name, color: "GRAY", description: "" }));
  const plan = { op: "createProjectV2Field", projectId, name: "Stage", dataType: "SINGLE_SELECT", options: lanes };
  return stagedGuard(flags, plan, () => {
    const q = `mutation($projectId:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){
      createProjectV2Field(input:{projectId:$projectId,dataType:SINGLE_SELECT,name:$name,singleSelectOptions:$options}){
        projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } }
      }
    }`;
    const data = graphqlVars(q, { projectId, name: "Stage", options });
    const f = data.createProjectV2Field.projectV2Field;
    return { stageFieldId: f.id, options: f.options.map((o) => ({ label: o.name, optionId: o.id })) };
  });
}

// ensureLabels — idempotent `gh label create --force` for the routing labels.
function ensureLabels(flags, repo, labels) {
  const plan = { op: "gh label create", repo, labels };
  return stagedGuard(flags, plan, () => {
    const results = [];
    for (const name of labels) {
      const r = spawnSync("gh", ["label", "create", name, "--repo", repo, "--force"], { encoding: "utf8", shell: false });
      if (r.error) throw new Error(`failed to spawn gh: ${r.error.message}`);
      if (r.status !== 0) throw new Error(`gh label create ${name}: ${(r.stderr || r.stdout || "").trim()}`);
      results.push(name);
    }
    return { created: results };
  });
}
```

Extend the bottom `export { ... }` block to include the new names:

```js
export {
  loadConfig, getStageField, listItems, getIssue, snapshot,
  createIssue, addIssueToBoard, setLabels, removeLabels, comment, setStage,
  capabilities, resolveStageOption, runDoctor, diffItems, runWatch, Refusal,
  // M1 provisioning:
  buildGraphqlInput, graphqlVars, getOwnerId, findProjectByTitle, findStageFieldByName,
  createProject, createStageField, ensureLabels,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/provision.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all prior tests still pass plus the new ones.

- [ ] **Step 6: Commit**

```bash
git add scripts/board.mjs tests/provision.test.mjs
git commit -m "feat(engine): provisioning ops (project/field/labels) + graphqlVars helper"
```

---

## Task 5: `bootstrap` + `ledger` verbs (`board-manager.mjs`)

The verbs are dependency-injected (engine + `detectRepo` + `writeConfig` + `dir` + `existingConfig`) so they unit-test against mocks. `bootstrap` is **idempotent**: it resumes from a partial `board.json` and adopts an existing same-title project / Stage field instead of duplicating.

**Files:**
- Modify: `tests/helpers/mock-engine.mjs` (record new ops)
- Modify: `scripts/board-manager.mjs` (add verbs; import ledger + presets)
- Test: `tests/bootstrap.test.mjs` (new)

- [ ] **Step 1: Extend the mock engine**

In `tests/helpers/mock-engine.mjs`, add these recorders inside the returned object (after `comment`):

```js
    getOwnerId:          rec('getOwnerId'),
    findProjectByTitle:  rec('findProjectByTitle'),
    findStageFieldByName: rec('findStageFieldByName'),
    createProject:       rec('createProject'),
    createStageField:    rec('createStageField'),
    ensureLabels:        rec('ensureLabels'),
```

- [ ] **Step 2: Write the failing tests**

Create `tests/bootstrap.test.mjs`:

```js
// tests/bootstrap.test.mjs — bootstrap + ledger verb tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { bootstrap, ledger } from '../scripts/board-manager.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-boot-'));
const detect = () => ({ owner: 'Deocracy', repo: 'demo', nameWithOwner: 'Deocracy/demo' });

function happyEngine() {
  return makeMockEngine({
    getOwnerId: () => ({ ownerId: 'O_1', ownerType: 'Organization' }),
    findProjectByTitle: () => null,
    findStageFieldByName: () => null,
    createProject: () => ({ projectId: 'PVT_1', projectNumber: 9, url: 'https://x/9' }),
    createStageField: () => ({ stageFieldId: 'PVTSSF_1', options: [
      { label: 'Ideas', optionId: 'o1' }, { label: 'Researching', optionId: 'o2' },
      { label: 'Building', optionId: 'o3' }, { label: 'Review', optionId: 'o4' },
      { label: 'Shipped', optionId: 'o5' }, { label: 'Rejected (learnings kept)', optionId: 'o6' },
    ] }),
    ensureLabels: () => ({ created: ['agent:go', 'needs-claude'] }),
  });
}

test('bootstrap --staged previews the plan and performs NO engine writes', async () => {
  const engine = happyEngine();
  const writes = [];
  const r = await bootstrap({
    engine, staged: true, dir: tmp(),
    detectRepo: detect, writeConfig: (c) => writes.push(c), preset: 'build', existingConfig: null,
  });
  assert.equal(r.committed, false);
  assert.equal(r.staged, true);
  assert.match(r.say, /Would bootstrap/);
  assert.equal(engine.calls.length, 0, 'staged mode must not call the engine');
  assert.equal(writes.length, 0, 'staged mode must not write config');
});

test('bootstrap commit: full create chain in order, write-as-you-go, ledger bound', async () => {
  const engine = happyEngine();
  const dir = tmp();
  const writes = [];
  const r = await bootstrap({
    engine, staged: false, dir,
    detectRepo: detect, writeConfig: (c) => writes.push({ ...c }), preset: 'build', existingConfig: null,
  });
  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['getOwnerId', 'findProjectByTitle', 'createProject', 'findStageFieldByName', 'createStageField', 'ensureLabels']);
  assert.equal(r.committed, true);
  // persisted exactly once, with the complete binding
  assert.equal(writes.length, 1);
  const finalCfg = writes.at(-1);
  assert.equal(finalCfg.projectId, 'PVT_1');
  assert.equal(finalCfg.stageFieldId, 'PVTSSF_1');
  assert.equal(finalCfg.ownerType, 'Organization');
  assert.equal(finalCfg.pushPolicy, 'on-approval');
  assert.equal(finalCfg.stageOptions.Ideas, 'o1');
  // ledger bound
  const l = await readLedger(dir);
  assert.equal(l.intent.wantsBoard, true);
  assert.equal(l.intent.boundBoard.projectNumber, 9);
  // browser-only reminder present
  assert.match(r.say, /group by Stage/i);
});

test('bootstrap resumes from a partial board.json (project done, field missing)', async () => {
  const engine = happyEngine();
  const r = await bootstrap({
    engine, staged: false, dir: tmp(),
    detectRepo: detect, writeConfig: () => {}, preset: 'build',
    existingConfig: { projectId: 'PVT_OLD', projectNumber: 3, projectUrl: 'u', owner: 'Deocracy', repo: 'Deocracy/demo', preset: 'build', routing: { agent: 'agent:go', human: 'needs-claude' } },
  });
  const ops = engine.calls.map((c) => c.op);
  assert.ok(!ops.includes('createProject'), 'must NOT recreate an existing project');
  assert.ok(ops.includes('createStageField'), 'must still create the missing field');
  assert.equal(r.config.projectId, 'PVT_OLD');
});

test('bootstrap adopts an existing same-title project and its Stage field', async () => {
  const engine = makeMockEngine({
    getOwnerId: () => ({ ownerId: 'O_1', ownerType: 'Organization' }),
    findProjectByTitle: () => ({ projectId: 'PVT_FOUND', projectNumber: 12, url: 'u12' }),
    findStageFieldByName: () => ({ stageFieldId: 'PVTSSF_FOUND', options: [{ label: 'Ideas', optionId: 'o1' }] }),
    ensureLabels: () => ({ created: [] }),
  });
  const r = await bootstrap({
    engine, staged: false, dir: tmp(),
    detectRepo: detect, writeConfig: () => {}, preset: 'build', existingConfig: null,
  });
  const ops = engine.calls.map((c) => c.op);
  assert.ok(!ops.includes('createProject'), 'must adopt, not create project');
  assert.ok(!ops.includes('createStageField'), 'must adopt, not create field');
  assert.equal(r.config.projectId, 'PVT_FOUND');
  assert.equal(r.config.stageFieldId, 'PVTSSF_FOUND');
});

test('ledger verb: add then show', async () => {
  const dir = tmp();
  const added = await ledger('add', 'Investigate dedup', { dir, source: 'test' });
  assert.match(added.say, /Added candidate/);
  const shown = await ledger('show', null, { dir });
  assert.match(shown.say, /1 candidate/);
  assert.match(shown.say, /no board bound/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/bootstrap.test.mjs`
Expected: FAIL — `bootstrap`/`ledger` not exported.

- [ ] **Step 4: Implement the verbs in `scripts/board-manager.mjs`**

Add to the imports at the top (alongside the existing preset/state imports):

```js
import { ensureLedger, readLedger, appendCandidate, setIntent } from './lib/ledger.mjs';
```

Add the two verbs in the VERBS section (after `reshape`):

```js
/**
 * bootstrap(ctx) — Tier-1: provision a real board from the current repo.
 * Idempotent: resumes from ctx.existingConfig (partial board.json) and adopts an
 * existing same-title project / Stage field instead of duplicating. Approval-gated
 * via ctx.staged (staged previews the whole plan and writes nothing).
 *
 * @param {object} ctx { engine, staged, dir, detectRepo, writeConfig, preset?, title?, existingConfig? }
 * @returns {Promise<{committed:boolean, staged?:boolean, plan?:object, config?:object, say:string}>}
 */
export async function bootstrap(ctx) {
  const { engine, staged, dir } = ctx;
  const detectRepo = ctx.detectRepo;
  const writeConfig = ctx.writeConfig;
  const presetName = ctx.preset || 'build';
  const routing = { agent: 'agent:go', human: 'needs-claude' };

  const repo = await detectRepo();
  const repoSlug = repo.nameWithOwner || `${repo.owner}/${repo.repo}`;
  const preset = await loadPreset(presetName);
  const lanes = laneNames(preset);
  const projectTitle = ctx.title || `${repo.repo} board`;

  if (staged) {
    const plan = { op: 'bootstrap', repo: repoSlug, projectTitle, lanes, labels: [routing.agent, routing.human] };
    const say = `Would bootstrap board "${projectTitle}" on ${repoSlug}: ${lanes.length} lanes [${lanes.join(', ')}], labels [${routing.agent}, ${routing.human}]. After commit, set the board view to group by Stage (browser-only).`;
    return { committed: false, staged: true, plan, say };
  }

  // COMMIT — write-as-you-go; resume from a partial existing config.
  const cfg = { ...(ctx.existingConfig || {}) };
  cfg.owner = repo.owner;
  cfg.repo = repoSlug;
  cfg.preset = presetName;
  cfg.routing = routing;

  const ownerInfo = await engine.getOwnerId(repo.owner);
  cfg.ownerType = ownerInfo.ownerType;

  // Project: reuse partial config -> else adopt same-title -> else create.
  if (!cfg.projectId) {
    const found = await engine.findProjectByTitle(repo.owner, ownerInfo.ownerType, projectTitle);
    const proj = found || await engine.createProject(ownerInfo.ownerId, projectTitle, {});
    cfg.projectId = proj.projectId;
    cfg.projectNumber = proj.projectNumber;
    cfg.projectUrl = proj.url;
  }

  // Stage field: reuse partial config -> else adopt existing -> else create.
  if (!cfg.stageFieldId) {
    const found = await engine.findStageFieldByName(cfg.projectId, 'Stage');
    const field = found || await engine.createStageField(cfg.projectId, lanes, {});
    cfg.stageFieldId = field.stageFieldId;
    cfg.stageOptions = Object.fromEntries(field.options.map((o) => [o.label, o.optionId]));
  }

  cfg.pushPolicy = cfg.pushPolicy || 'on-approval';
  cfg.pullCadence = cfg.pullCadence || 'session-start';

  // Persist the complete binding ONCE. writeBoardConfig requires the full shape,
  // so there is no partial/checkpoint file. Resumability after a mid-provision
  // failure comes from two places instead: (i) a complete board.json passed back
  // as ctx.existingConfig on a re-run, and (ii) the adopt-by-title path above
  // (findProjectByTitle / findStageFieldByName), which rediscovers the
  // already-created project/field on GitHub even if no local board.json survived.
  await writeConfig(cfg);

  await engine.ensureLabels(cfg.repo, [routing.agent, routing.human], {});

  if (dir) {
    await setIntent(dir, { wantsBoard: true, boundBoard: { projectNumber: cfg.projectNumber, projectUrl: cfg.projectUrl } });
  }

  const say = `Bootstrapped board "${projectTitle}" (#${cfg.projectNumber}) on ${cfg.repo} with ${lanes.length} lanes. One manual step remains: open the project and set the board view to group by Stage. Then run doctor.`;
  return { committed: true, config: cfg, say };
}

/**
 * ledger(action, arg, ctx) — inspect/append the Tier-0 intent ledger.
 * @param {'show'|'add'} action
 * @param {string|null} arg  candidate title (for 'add')
 * @param {object} ctx { dir, source? }
 * @returns {Promise<{say:string, ledger:object}>}
 */
export async function ledger(action, arg, ctx) {
  const dir = ctx.dir || process.cwd();
  if (action === 'add') {
    if (!arg) throw new Error('usage: ledger add "<title>"');
    const updated = await appendCandidate(dir, { title: arg, source: ctx.source || 'manual' });
    return { say: `Added candidate "${arg}" (${updated.candidates.length} total in the ledger).`, ledger: updated };
  }
  const l = (await readLedger(dir)) || await ensureLedger(dir);
  const n = l.candidates.length;
  const bound = l.intent.boundBoard ? `bound to project #${l.intent.boundBoard.projectNumber}` : 'no board bound';
  return { say: `Ledger: ${n} candidate(s), ${bound}.`, ledger: l };
}
```

> Resumability note: `bootstrap` is idempotent without local checkpoints. A re-run after a mid-provision failure recovers via (a) `existingConfig` (a complete `board.json` from a prior successful run) and (b) the adopt-by-title path — `findProjectByTitle`/`findStageFieldByName` rediscover the already-created project/field on GitHub, so orphaned objects are adopted rather than duplicated. The config is written once, at the end, with the complete binding (the commit test asserts a single write).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/bootstrap.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/board-manager.mjs tests/helpers/mock-engine.mjs tests/bootstrap.test.mjs
git commit -m "feat(verbs): bootstrap (idempotent provisioning) + ledger verbs"
```

---

## Task 6: CLI wiring (`board-manager.mjs`)

Wire the two verbs into the CLI so they run as real commands, building the real engine adapter and default deps. `bootstrap`/`ledger` must run **without** an existing `board.json`, so they bypass the fail-closed `loadConfig` (same pattern `board.mjs` uses for `doctor`).

**Files:**
- Modify: `scripts/board-manager.mjs` (`parseCliArgs`, `makeRealEngine`, `cli()` help + dispatch)

- [ ] **Step 1: Extend `parseCliArgs`** to capture the new flags:

Replace the body of `parseCliArgs` with:

```js
function parseCliArgs(argv) {
  const out = { verb: null, staged: false, config: null, preset: null, title: null, repo: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') out.staged = true;
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--preset') out.preset = argv[++i];
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (!out.verb) out.verb = a;
    else out.rest.push(a);
  }
  return out;
}
```

- [ ] **Step 2: Add the new ops to `makeRealEngine`** (inside the returned object, after `comment`):

```js
    getOwnerId: (login) => eng.getOwnerId(login),
    findProjectByTitle: (login, ownerType, title) => eng.findProjectByTitle(login, ownerType, title),
    findStageFieldByName: (projectId, name) => eng.findStageFieldByName(projectId, name),
    createProject: (ownerId, title, opts = {}) => eng.createProject(flagsFor(opts), ownerId, title),
    createStageField: (projectId, lanes, opts = {}) => eng.createStageField(flagsFor(opts), projectId, lanes),
    ensureLabels: (repo, labels, opts = {}) => eng.ensureLabels(flagsFor(opts), repo, labels),
```

- [ ] **Step 3: Add `bootstrap`/`ledger` to the CLI help** — in `cli()`, extend the help string's verb list:

```
  bootstrap [--preset build] [--title "..."] [--repo owner/name]  provision a board from the current repo
  ledger [add "<title>"]              show or append to the intent ledger
```

- [ ] **Step 4: Widen the top-of-`cli()` parse, then dispatch `bootstrap`/`ledger` before the config path.**

First, widen the existing destructure at the top of `cli()` so the new flags are in scope. Change:

```js
const { verb, staged, config: configPath, rest } = parseCliArgs(process.argv.slice(2));
```

to:

```js
const { verb, staged, config: configPath, preset, title, repo, rest } = parseCliArgs(process.argv.slice(2));
```

Then, immediately after the `--help` block (and BEFORE the `loadConfig` calls), insert the dispatch for the two config-free verbs. There is exactly one `parseCliArgs` call (the widened one above); this block reuses its bindings:

```js
  // bootstrap + ledger run WITHOUT an existing board.json — bypass loadConfig.
  if (verb === 'ledger') {
    const action = rest[0] === 'add' ? 'add' : 'show';
    const arg = action === 'add' ? rest[1] : null;
    const result = await ledger(action, arg, { dir: process.cwd() });
    console.log(result.say);
    return;
  }
  if (verb === 'bootstrap') {
    const eng = await import('./board.mjs');
    const { writeBoardConfig } = await import('./lib/config-writer.mjs');
    const { detectRepo } = await import('./lib/repo-detect.mjs');
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');

    const boardPath = resolve(process.cwd(), 'board.json');
    let existingConfig = null;
    try { existingConfig = JSON.parse(await readFile(boardPath, 'utf8')); } catch { existingConfig = null; }

    // --repo owner/name overrides git-remote detection.
    const detect = repo
      ? () => { const [o, n] = repo.split('/'); return { owner: o, repo: n, nameWithOwner: repo }; }
      : detectRepo;

    // makeRealEngine(eng, {}) is safe here: bootstrap only calls the provisioning
    // ops, which ignore cfg. (The cfg-reading ops are never reached on this path.)
    const engine = makeRealEngine(eng, {});
    const result = await bootstrap({
      engine, staged, dir: process.cwd(),
      detectRepo: detect, writeConfig: (cfg) => writeBoardConfig(boardPath, cfg),
      preset: preset || 'build', title, existingConfig,
    });
    console.log(result.say);
    if (!staged) console.log(JSON.stringify(result, null, 2));
    return;
  }
```

- [ ] **Step 5: Smoke test the help + a staged dry-run**

Run: `node scripts/board-manager.mjs --help`
Expected: output now lists `bootstrap` and `ledger`.

Run: `node scripts/board-manager.mjs ledger`
Expected: prints `Ledger: 0 candidate(s), no board bound.` and creates `.github-boards/ledger.json`.

Run (needs `gh` auth; writes nothing): `node scripts/board-manager.mjs bootstrap --staged`
Expected: prints `Would bootstrap board "github-boards-skill board" on Deocracy/github-boards-skill: 6 lanes [...]`. No `board.json` is created.

- [ ] **Step 6: Clean up the ledger smoke artifact and commit**

```bash
rm -rf .github-boards
git add scripts/board-manager.mjs
git commit -m "feat(cli): wire bootstrap + ledger verbs (bypass fail-closed loadConfig)"
```

---

## Task 7: SessionStart hook — Tier-0 ensure ledger

The SessionStart hook must ensure the ledger exists on every session (Tier 0), fold the candidate count into the injected note, and stay silent only when there is genuinely nothing to say (no board status AND no candidates) — preserving the existing "never spam a fresh install" rule.

**Files:**
- Modify: `hooks/SessionStart/load-board.mjs`
- Test: `tests/hooks.ledger.test.mjs` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/hooks.ledger.test.mjs`:

```js
// tests/hooks.ledger.test.mjs — SessionStart decide() ledger behavior
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../hooks/SessionStart/load-board.mjs';

const baseDeps = {
  hasBoard: () => false,
  runSummary: async () => null,
  ensureLedger: async () => ({ candidates: [] }),
  readLedger: async () => ({ candidates: [] }),
};

test('decide always calls ensureLedger with the cwd', async () => {
  let calledWith = null;
  await decide({ cwd: '/work' }, { ...baseDeps, ensureLedger: async (d) => { calledWith = d; return { candidates: [] }; } });
  assert.equal(calledWith, '/work');
});

test('decide returns null when no board and zero candidates (anti-spam)', async () => {
  const r = await decide({ cwd: '/work' }, baseDeps);
  assert.equal(r, null);
});

test('decide injects a ledger note when there are candidates but no board', async () => {
  const r = await decide({ cwd: '/work' }, { ...baseDeps, ensureLedger: async () => ({ candidates: [1, 2] }) });
  assert.ok(r && /2 candidate/.test(r.additionalContext));
});

test('decide injects board status when a board summary is available', async () => {
  const r = await decide({ cwd: '/work' }, { ...baseDeps, hasBoard: () => true, runSummary: async () => 'Since last time: 1 moved' });
  assert.ok(r && /Since last time: 1 moved/.test(r.additionalContext));
});

test('decide never throws if ensureLedger throws (degrades silently)', async () => {
  const r = await decide({ cwd: '/work' }, { ...baseDeps, ensureLedger: async () => { throw new Error('fs'); } });
  assert.equal(r, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/hooks.ledger.test.mjs`
Expected: FAIL — `decide` ignores `ensureLedger`/`readLedger` deps (current signature has neither), so several assertions fail.

- [ ] **Step 3: Update `decide()` and add default deps in `hooks/SessionStart/load-board.mjs`**

Add imports near the top (after the existing imports):

```js
import { ensureLedger as defaultEnsureLedger, readLedger as defaultReadLedger } from '../../scripts/lib/ledger.mjs';
```

Replace the body of `decide()` with:

```js
export async function decide(input, deps = {}) {
  const hasBoard = deps.hasBoard || defaultHasBoard;
  const runSummary = deps.runSummary || defaultRunSummary;
  const ensureLedgerFn = deps.ensureLedger || defaultEnsureLedger;
  const readLedgerFn = deps.readLedger || defaultReadLedger;

  const cwd = (input && input.cwd) || process.cwd();

  // Tier 0: ALWAYS ensure the ledger exists. Best-effort, never throws.
  let ledger = null;
  try {
    ledger = await ensureLedgerFn(cwd);
  } catch {
    try { ledger = await readLedgerFn(cwd); } catch { ledger = null; }
  }
  const candidateCount = ledger && Array.isArray(ledger.candidates) ? ledger.candidates.length : 0;

  // Board summary (existing behavior), degrade silently on any failure.
  let say = null;
  let boardPresent = false;
  try { boardPresent = hasBoard(cwd); } catch { boardPresent = false; }
  if (boardPresent) {
    try { say = await runSummary(cwd); } catch { say = null; }
  }

  // Compose. Stay silent (return null) only when there's nothing meaningful.
  const parts = [];
  if (say && typeof say === 'string' && say.trim()) parts.push(`GitHub board status: ${say.trim()}`);
  if (candidateCount > 0) parts.push(`github-boards ledger: ${candidateCount} candidate(s) not yet on the board.`);
  if (parts.length === 0) return null;
  return { additionalContext: parts.join(' ') };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/hooks.ledger.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Patch the existing SessionStart tests to inject inert ledger deps**

The new `decide()` calls the real `ensureLedger` whenever ledger deps aren't injected. The existing SessionStart tests in `tests/hooks.test.mjs` pass fake absolute cwds (`/some/project`, `/p`), which would now trigger a real `mkdir`+`writeFile` of `ledger.json` at the drive root. Give every `sessionStartDecide(...)` call in `tests/hooks.test.mjs` (the SessionStart section, ~lines 91-145 — there are five calls) inert ledger deps so it stays hermetic. Add these two keys to each call's deps object:

```js
      ensureLedger: async () => ({ candidates: [] }),
      readLedger: async () => ({ candidates: [] }),
```

For example, the "board.json present" case becomes:

```js
  const d = await sessionStartDecide(
    { cwd: '/some/project' },
    {
      hasBoard: () => true,
      runSummary: async () => fakeSay,
      ensureLedger: async () => ({ candidates: [] }),
      readLedger: async () => ({ candidates: [] }),
    }
  );
```

And the compact two-call case becomes:

```js
  const dNull = await sessionStartDecide(
    { cwd: '/p' }, { hasBoard: () => true, runSummary: async () => null, ensureLedger: async () => ({ candidates: [] }), readLedger: async () => ({ candidates: [] }) }
  );
  const dBlank = await sessionStartDecide(
    { cwd: '/p' }, { hasBoard: () => true, runSummary: async () => '   ', ensureLedger: async () => ({ candidates: [] }), readLedger: async () => ({ candidates: [] }) }
  );
```

Run: `node --test tests/hooks.test.mjs`
Expected: all existing hook tests pass, and no `.github-boards/` directory is created outside a temp dir.

- [ ] **Step 6: Run the full suite + confirm existing hook tests still pass**

Run: `npm test`
Expected: all pass (including the existing `tests/hooks.test.mjs`).

- [ ] **Step 7: Commit**

```bash
git add hooks/SessionStart/load-board.mjs tests/hooks.ledger.test.mjs tests/hooks.test.mjs
git commit -m "feat(hooks): SessionStart ensures the intent ledger (Tier 0)"
```

---

## Task 8: Back-compat + example config

Confirm existing configs without the new optional fields still load, and document the new fields in the committed example.

**Files:**
- Modify: `board.example.json`
- Test: `tests/config-backcompat.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/config-backcompat.test.mjs`:

```js
// tests/config-backcompat.test.mjs — new optional fields don't break the loaders
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { loadConfig as loadVerbConfig } from '../scripts/lib/config.mjs';
import { loadConfig as loadEngineConfig } from '../scripts/board.mjs';

const cfg = {
  owner: 'Deocracy', ownerType: 'Organization', projectNumber: 7, projectId: 'PVT_x',
  repo: 'Deocracy/demo', stageFieldId: 'PVTSSF_x', stageOptions: { Ideas: 'o1' },
  preset: 'build', routing: { agent: 'agent:go', human: 'needs-claude' },
  projectUrl: 'https://x/7', pushPolicy: 'on-approval', pullCadence: 'session-start',
};

test('verb loadConfig tolerates the new optional fields and passes them through', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-bc-'));
  const p = join(dir, 'board.json');
  await writeFile(p, JSON.stringify(cfg), 'utf8');
  const loaded = await loadVerbConfig(p);
  assert.equal(loaded.pushPolicy, 'on-approval');
  assert.equal(loaded.preset.name, 'build');
});

test('engine loadConfig tolerates the new optional fields', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-bc-'));
  const p = join(dir, 'board.json');
  await writeFile(p, JSON.stringify(cfg), 'utf8');
  const loaded = loadEngineConfig(p);
  assert.equal(loaded.projectUrl, 'https://x/7');
  assert.equal(loaded.pullCadence, 'session-start');
});
```

- [ ] **Step 2: Run the test to verify it passes immediately** (both loaders already ignore unknown keys)

Run: `node --test tests/config-backcompat.test.mjs`
Expected: PASS (2 tests). If it FAILS, a loader is rejecting unknown keys — fix the loader to ignore them, then re-run.

- [ ] **Step 3: Document the new fields in `board.example.json`**

Add the three fields after `routing` in `board.example.json`:

```json
  "routing": {
    "agent": "agent:go",
    "human": "needs-claude"
  },
  "projectUrl": "https://github.com/orgs/your-org/projects/23",
  "pushPolicy": "on-approval",
  "pullCadence": "session-start"
```

- [ ] **Step 4: Commit**

```bash
git add board.example.json tests/config-backcompat.test.mjs
git commit -m "test(config): back-compat for new optional board.json fields + example"
```

---

## Task 9: Live integration smoke (gated)

A real end-to-end run against GitHub, **skipped unless `GBS_LIVE=1`** so normal `npm test` stays hermetic. It bootstraps a throwaway board, asserts the binding via the read path, then tears it down.

**Files:**
- Test: `tests/live-bootstrap.test.mjs` (new)

- [ ] **Step 1: Write the gated test**

Create `tests/live-bootstrap.test.mjs`:

```js
// tests/live-bootstrap.test.mjs — LIVE smoke. Skipped unless GBS_LIVE=1.
// Requires: gh authed with `project` scope, run inside a git repo with a GitHub remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { bootstrap } from '../scripts/board-manager.mjs';
import { detectRepo } from '../scripts/lib/repo-detect.mjs';
import { writeBoardConfig } from '../scripts/lib/config-writer.mjs';
import * as eng from '../scripts/board.mjs';

const LIVE = process.env.GBS_LIVE === '1';

test('LIVE: bootstrap creates a board, doctor sees it, then teardown', { skip: !LIVE ? 'set GBS_LIVE=1 to run' : false }, async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-live-'));
  const boardPath = join(dir, 'board.json');
  const title = `gbs-smoke-${process.pid}`;

  // Build the real engine adapter the same way the CLI does.
  const flagsFor = (opts = {}) => ({ staged: !!opts.staged, json: false });
  const engine = {
    getOwnerId: (login) => eng.getOwnerId(login),
    findProjectByTitle: (l, t, ti) => eng.findProjectByTitle(l, t, ti),
    findStageFieldByName: (p, n) => eng.findStageFieldByName(p, n),
    createProject: (o, ti, opts = {}) => eng.createProject(flagsFor(opts), o, ti),
    createStageField: (p, lanes, opts = {}) => eng.createStageField(flagsFor(opts), p, lanes),
    ensureLabels: (r, labs, opts = {}) => eng.ensureLabels(flagsFor(opts), r, labs),
  };

  let cfg;
  try {
    const r = await bootstrap({
      engine, staged: false, dir, detectRepo, title, preset: 'build',
      writeConfig: (c) => writeBoardConfig(boardPath, c), existingConfig: null,
    });
    assert.equal(r.committed, true);
    cfg = r.config;
    assert.ok(cfg.projectId.startsWith('PVT_'));
    assert.ok(cfg.stageFieldId.startsWith('PVTSSF_'));

    // read-path verification: the Stage field resolves with all 6 lanes
    const field = eng.getStageField(cfg);
    assert.equal(field.options.length, 6);
  } finally {
    // teardown: delete the throwaway project (best-effort)
    if (cfg && cfg.projectId) {
      try {
        eng.graphqlVars('mutation($id:ID!){ deleteProjectV2(input:{projectId:$id}){ clientMutationId } }', { id: cfg.projectId });
      } catch (e) { console.error('teardown failed (delete manually):', cfg.projectUrl, e.message); }
    }
  }
});
```

- [ ] **Step 2: Confirm it skips by default**

Run: `npm test`
Expected: the live test reports as skipped; all other tests pass.

- [ ] **Step 3: Run it live once, manually, to prove the real path**

Run: `GBS_LIVE=1 node --test tests/live-bootstrap.test.mjs`
Expected: PASS — a `gbs-smoke-<pid>` project is created, asserted, then deleted. (On Windows PowerShell: `$env:GBS_LIVE=1; node --test tests/live-bootstrap.test.mjs`.)
If it fails on a GraphQL shape, fix the offending op in `board.mjs` (the unit tests cover staged behavior; this is where real syntax is proven) and re-run.

- [ ] **Step 4: Commit**

```bash
git add tests/live-bootstrap.test.mjs
git commit -m "test(live): gated end-to-end bootstrap smoke with teardown"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all tests pass (the 115 existing + the new unit tests; live test skipped).

- [ ] **Step 2: Run doctor against a bootstrapped board (optional, live)**

Run (live): provision via `GBS_LIVE=1 node --test tests/live-bootstrap.test.mjs` is self-cleaning; for a manual check, run `node scripts/board-manager.mjs bootstrap` in a scratch repo, then `node scripts/board.mjs doctor`.
Expected: doctor reports `project-access PASS` and `stage-options PASS` (after you set the view group-by in the browser, which doctor lists as the remaining manual step).

- [ ] **Step 3: Final commit if anything was adjusted**

```bash
git add -A
git commit -m "chore(m1): final verification pass"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** C1 provisioning → Tasks 4–6, 9. Intent ledger (I6) → Tasks 1, 7. board.json writer → Task 3. Policy fields stored-not-enforced → Tasks 3, 8. SessionStart Tier-0 → Task 7. Idempotency/resumability (§6) → Task 5 (resume + adopt). Browser-only view step honored → Tasks 5, 6, 9. Testing (§7) → Tasks 1–9. All §2 in-scope items map to a task. ✓
- **Placeholder scan:** every code/test step contains full, drop-in code — no "TBD"/"add error handling"/"similar to" references, and no illustrative/dead lines (the earlier stray `const { parsed }` was removed; the CLI uses a single `parseCliArgs`). ✓
- **Type consistency:** op names match across engine (`getOwnerId`/`findProjectByTitle`/`findStageFieldByName`/`createProject`/`createStageField`/`ensureLabels`), the mock, `makeRealEngine`, and `bootstrap` callsites. Return shapes (`{projectId,projectNumber,url}`, `{stageFieldId,options:[{label,optionId}]}`, `{ownerId,ownerType}`) are consistent between definition (Task 4) and consumption (Task 5). Ledger shape consistent across Tasks 1/5/7. ✓
- **Resumability (post adversarial-verification):** `bootstrap` persists the complete binding once; idempotency comes from `existingConfig` (a complete prior `board.json`) plus the adopt-by-title path (`findProjectByTitle`/`findStageFieldByName`) — NOT from local checkpoint writes. The commit test asserts a single write. ✓
- **GraphQL shapes:** the provisioning mutations were independently verified against the live GitHub GraphQL API (a reviewer did a real `createProjectV2Field` create/delete round-trip — `name`+`color`+`description` are all required, `GRAY` is valid, empty `description` accepted). The live `createProjectV2Field` path is still only *exercised* by the gated smoke (Task 9), which MUST be run once with `GBS_LIVE=1` before declaring M1 done. ✓
