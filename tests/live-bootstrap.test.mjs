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
