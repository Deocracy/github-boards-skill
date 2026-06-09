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
