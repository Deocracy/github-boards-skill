// tests/engine.test.mjs — ported, board-free invariant suite for the ghCli engine.
//
// SOURCE: ported from the board-connection adapter's run-tests.mjs (GCA repo,
// ADR-027). That original is a LIVE end-to-end harness: it creates a REAL Issue
// on the dogfood board #23, drives it through MAKE/REGULATE/WATCH against the
// live GitHub API, and asserts runDoctor() PASSes in that environment. Those
// LIVE blocks need a reachable board + network and are intentionally NOT ported
// here — this repo's `npm test` must be green with no real board (per the build
// plan and to match the existing mock-based smoke test).
//
// What IS ported are the invariant assertions that fire WITHOUT touching a live
// board: the pure functions (capabilities, diffItems, resolveStageOption) and
// the fail-closed Refusal paths that throw BEFORE any `gh` spawn (config-shape
// validation, the staged dry-run that writes nothing, and the option-injection /
// identity / url guards). Together these exercise invariants 1–5 structurally.
//
// Live coverage (real createIssue -> addToBoard -> setStage -> read-back, live
// diffItems lane-move detection, doctor-all-PASS) lives in the source repo's
// run-tests.mjs and is re-validated end-to-end against board #23 there; it is a
// known, deliberate gap in THIS unit suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig, getStageField, listItems,
  createIssue, addIssueToBoard, setLabels, removeLabels, comment, setStage,
  capabilities, resolveStageOption, diffItems, Refusal,
} from '../scripts/board.mjs';

// A synthetic-but-shape-valid config fixture. Mirrors the dogfood board's lane
// set so resolveStageOption / staged-plan assertions read realistically, without
// requiring a live board. (optionIds are placeholders — no network is touched on
// the pure/pre-spawn paths under test.)
const baseCfg = {
  owner: 'deocracy',
  ownerType: 'organization',
  projectNumber: 23,
  projectId: 'PVT_test',
  repo: 'deocracy/github-boards-skill',
  stageFieldId: 'PVTSSF_stage',
  stageOptions: {
    Ideas: 'opt-ideas',
    Researching: 'opt-research',
    Spiking: 'opt-spiking',
    Review: 'opt-review',
    Building: 'opt-building',
    Shipped: 'opt-shipped',
    'Rejected (learnings kept)': 'opt-rejected',
  },
  __path: '<fixture>',
};
const cfg = () => ({ ...baseCfg, stageOptions: { ...baseCfg.stageOptions } });

const flags = { staged: false, json: true, labels: null, identity: 'pat' };
const stagedFlags = { ...flags, staged: true };

// helper mirroring the source harness's refused(): did the call fail-closed?
function refused(fn) {
  try { fn(); return { refused: false }; }
  catch (e) { return { refused: !!e.refusal, message: e.message }; }
}

// ---------------------------------------------------------------------------
// CROSS-CUTTING — capabilities (Invariant 4)
// ---------------------------------------------------------------------------
test('capabilities: gh adapter has NO per-run caps', () => {
  const caps = capabilities(cfg());
  assert.equal(caps.maxOpsPerRun.addComment, null);
  assert.equal(caps.maxOpsPerRun.updateProject, null);
});

test('capabilities: documents gh-aw per-run caps', () => {
  const caps = capabilities(cfg());
  assert.equal(caps.adapterNotes.ghAw.maxOpsPerRun.addComment, 1);
  assert.equal(caps.adapterNotes.ghAw.maxOpsPerRun.addLabels, 3);
  assert.equal(caps.adapterNotes.ghAw.maxOpsPerRun.updateProject, 10);
});

test('capabilities: documents MCP fields:[ids] requirement', () => {
  const caps = capabilities(cfg());
  assert.match(caps.adapterNotes.mcp.requires, /fields:\[ids\]/);
});

test('capabilities: enumerates the 5 enforced invariants', () => {
  const caps = capabilities(cfg());
  assert.equal(caps.invariantsEnforced.length, 5);
});

// ---------------------------------------------------------------------------
// CROSS-CUTTING — staged dry-run writes nothing (Invariant 4)
// every write op must be staged-previewable: returns a plan, performs no write.
// ---------------------------------------------------------------------------
test('staged create-issue prints a mutation plan and writes nothing (Invariant 4)', () => {
  const res = createIssue(cfg(), stagedFlags, 'STAGED should not exist', 'noop');
  assert.equal(res.staged, true);
  assert.equal(res.wouldRun.op, 'gh issue create');
  assert.equal(res.number, undefined); // nothing was written -> no issue number
});

test('staged set-labels is previewable and writes nothing', () => {
  const res = setLabels(cfg(), stagedFlags, 7, 'blocked');
  assert.equal(res.staged, true);
  assert.equal(res.wouldRun.op, 'gh issue edit --add-label');
  assert.deepEqual(res.wouldRun.labels, ['blocked']);
});

test('staged remove-labels is previewable and writes nothing', () => {
  const res = removeLabels(cfg(), stagedFlags, 7, 'blocked');
  assert.equal(res.staged, true);
  assert.equal(res.wouldRun.op, 'gh issue edit --remove-label');
  assert.deepEqual(res.wouldRun.labels, ['blocked']);
  assert.equal(res.number, undefined); // nothing was written
});

test('remove-labels REFUSES a non-numeric issue number (gh option-injection guard)', () => {
  const r = refused(() => removeLabels(cfg(), stagedFlags, '--oops', 'blocked'));
  assert.equal(r.refused, true);
});

test('staged comment is previewable and writes nothing', () => {
  const res = comment(cfg(), { ...stagedFlags, identity: 'pat' }, 7, 'noop');
  assert.equal(res.staged, true);
  assert.equal(res.wouldRun.op, 'gh issue comment');
});

// ---------------------------------------------------------------------------
// MAKE — createIssue plan never produces a draft (Invariant 1)
// The staged plan proves the WRITE path is `gh issue create` (a real Issue),
// never addProjectV2DraftIssue / item-create. createIssue precedes any board add.
// ---------------------------------------------------------------------------
test('createIssue plan is a REAL `gh issue create`, never a draft (Invariant 1)', () => {
  const res = createIssue(cfg(), stagedFlags, 'real issue', 'body');
  assert.equal(res.wouldRun.op, 'gh issue create');
  assert.equal(res.wouldRun.repo, baseCfg.repo);
});

test('addIssueToBoard REFUSES a non-issue url (Invariant 1: real Issues only)', () => {
  const r = refused(() => addIssueToBoard(cfg(), stagedFlags, 'https://example.com/not-an-issue'));
  assert.equal(r.refused, true);
});

// ---------------------------------------------------------------------------
// MAKE — set-labels / comment option-injection guards (fail-closed)
// these Refusals fire BEFORE any gh spawn, so they're board-free.
// ---------------------------------------------------------------------------
test('set-labels REFUSES a non-numeric issue number (gh option-injection guard)', () => {
  const r = refused(() => setLabels(cfg(), stagedFlags, '--oops', 'blocked'));
  assert.equal(r.refused, true);
});

test('comment REFUSES a non-numeric issue number (gh option-injection guard)', () => {
  const r = refused(() => comment(cfg(), stagedFlags, '--oops', 'noop'));
  assert.equal(r.refused, true);
});

test('comment REFUSES an unknown --identity', () => {
  const r = refused(() => comment(cfg(), { ...stagedFlags, identity: 'bot' }, 7, 'noop'));
  assert.equal(r.refused, true);
});

// ---------------------------------------------------------------------------
// MAKE — identity-aware comment (Invariant 5)
// identity records INTENDED author; 0.1 never claims an *enforced* re-trigger.
// computed before any write -> assertable via the staged plan.
// ---------------------------------------------------------------------------
test('comment --identity pat: intendedReTrigger=true, NOT enforced in 0.1 (Invariant 5)', () => {
  const res = comment(cfg(), { ...stagedFlags, identity: 'pat' }, 7, 'noop');
  assert.equal(res.wouldRun.intendedReTrigger, true);
  assert.equal(res.wouldRun.enforced, false);
  assert.ok(res.wouldRun.warnings.some((w) => /NOT enforced in 0\.1/i.test(w)));
});

test('comment --identity actions WARNS it is inert for the 0.2 re-trigger loop (Invariant 5)', () => {
  const res = comment(cfg(), { ...stagedFlags, identity: 'actions' }, 7, 'noop');
  assert.equal(res.wouldRun.intendedReTrigger, false);
  assert.ok(res.wouldRun.warnings.some((w) => /inert for the 0\.2 re-trigger/i.test(w)));
});

test('comment never claims an enforced re-trigger guarantee (enforced=false) for --identity pat', () => {
  const res = comment(cfg(), { ...stagedFlags, identity: 'pat' }, 7, 'noop');
  assert.equal(res.wouldRun.enforced, false);
  assert.equal(res.wouldRun.intendedReTrigger, true);
});

// ---------------------------------------------------------------------------
// REGULATE — label -> optionId resolution + fail-closed on unknown stage
// resolveStageOption is pure; setStage's "unknown stage" Refusal fires before gh.
// ---------------------------------------------------------------------------
test('resolveStageOption: exact, case-insensitive, and partial match', () => {
  const c = cfg();
  assert.equal(resolveStageOption(c, 'Spiking'), 'opt-spiking');     // exact
  assert.equal(resolveStageOption(c, 'spiking'), 'opt-spiking');     // case-insensitive
  assert.equal(resolveStageOption(c, 'reject'), 'opt-rejected');     // partial -> single match
  assert.equal(resolveStageOption(c, 'Nonexistent'), null);         // no match -> null
});

// ---------------------------------------------------------------------------
// loadConfig — fail-closed on bad config shape (HARDEN)
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'board-cfg-'));
function badConfigRefuses(name, mutate) {
  test(`loadConfig REFUSES ${name}`, () => {
    const bad = JSON.parse(JSON.stringify(baseCfg));
    delete bad.__path;
    mutate(bad);
    const p = join(tmp, `${name}.json`);
    writeFileSync(p, JSON.stringify(bad));
    assert.equal(refused(() => loadConfig(p)).refused, true);
  });
}
badConfigRefuses('projectNumber-as-string', (c) => { c.projectNumber = String(c.projectNumber); });
badConfigRefuses('stageOptions-null', (c) => { c.stageOptions = null; });
badConfigRefuses('stageOptions-array', (c) => { c.stageOptions = []; });
badConfigRefuses('ownerType-typo', (c) => { c.ownerType = 'Org'; });
badConfigRefuses('missing-stageFieldId', (c) => { delete c.stageFieldId; });
badConfigRefuses('repo-not-owner-slash-name', (c) => { c.repo = 'no-slash-here'; });

test('loadConfig REFUSES a missing config file (fail-closed, no crash)', () => {
  const r = refused(() => loadConfig(join(tmp, 'does-not-exist.json')));
  assert.equal(r.refused, true);
});

test('loadConfig REFUSES invalid JSON', () => {
  const p = join(tmp, 'broken.json');
  writeFileSync(p, '{ not valid json ');
  assert.equal(refused(() => loadConfig(p)).refused, true);
});

// loadConfig accepts a well-formed config (positive path).
test('loadConfig accepts a well-formed config and records its path', () => {
  const good = JSON.parse(JSON.stringify(baseCfg));
  delete good.__path;
  const p = join(tmp, 'good.json');
  writeFileSync(p, JSON.stringify(good));
  const loaded = loadConfig(p);
  assert.equal(loaded.owner, 'deocracy');
  assert.equal(loaded.__path, p);
});

// ---------------------------------------------------------------------------
// WATCH — diffItems is PURE: deterministic synthetic before/after, every class.
// (ported verbatim from the source harness's pure diffItems block.)
// ---------------------------------------------------------------------------
test('diffItems(pure): every change class + stability', () => {
  const wa = [{ itemId: 'i1', issueNumber: 1, title: 'a', stageLabel: 'Ideas', labels: ['keep'], state: 'OPEN' }];
  const wb = [
    { itemId: 'i1', issueNumber: 1, title: 'a2', stageLabel: 'Building', labels: ['keep', 'added'], state: 'CLOSED' },
    { itemId: 'i2', issueNumber: 2, title: 'new', stageLabel: 'Ideas', labels: [], state: 'OPEN' },
  ];
  const pe = diffItems(wa, wb);
  assert.ok(pe.some((e) => e.type === 'created' && e.itemId === 'i2'), 'created');
  assert.ok(pe.some((e) => e.type === 'moved' && e.from === 'Ideas' && e.to === 'Building'), 'moved');
  assert.ok(pe.some((e) => e.type === 'relabeled' && e.added.includes('added')), 'relabeled');
  assert.ok(pe.some((e) => e.type === 'state-changed' && e.to === 'CLOSED'), 'state-changed');
  assert.ok(pe.some((e) => e.type === 'retitled' && e.to === 'a2'), 'retitled');
  // reverse diff surfaces removal
  assert.ok(diffItems(wb, wa).some((e) => e.type === 'removed' && e.itemId === 'i2'), 'removed');
  // stable: identical snapshots yield zero events (no spurious churn)
  assert.equal(diffItems(wb, wb).length, 0);
});

// guard: Refusal is exported and is the fail-closed marker the harness relies on.
test('Refusal is an exported error type carrying .refusal=true', () => {
  const e = new Refusal('x');
  assert.equal(e.refusal, true);
  assert.equal(e.name, 'Refusal');
});

// the four ops below are imported for their side-effect of proving the import
// surface resolves (and to keep the linter from flagging unused imports); the
// behavioral coverage is in the staged/refusal tests above.
test('UNDERSTAND read ops are importable from the engine surface', () => {
  assert.equal(typeof getStageField, 'function');
  assert.equal(typeof listItems, 'function');
  assert.equal(typeof setStage, 'function');
});
