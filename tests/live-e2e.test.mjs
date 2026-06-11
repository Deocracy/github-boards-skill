// tests/live-e2e.test.mjs — the ONE full-story live pass. Skipped unless
// GBS_LIVE=1. DO NOT set GBS_LIVE=1 in automated/subagent/CI runs — this
// creates and deletes REAL GitHub resources. Operator instructions: docs/LIVE-RUNBOOK.md.
//
// STANDING RULE: this file is written once and NEVER run by implementers or
// reviewers. The only allowed execution is `node --test tests/live-e2e.test.mjs`
// WITHOUT GBS_LIVE set, which must show exactly 1 skipped test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
// Imports mirrored from live-bootstrap.test.mjs + live-promote.test.mjs conventions:
import { bootstrap } from '../scripts/board-manager.mjs';
import { detectRepo } from '../scripts/lib/repo-detect.mjs';
import { writeBoardConfig } from '../scripts/lib/config-writer.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import * as eng from '../scripts/board.mjs';

const LIVE = process.env.GBS_LIVE === '1';

test(
  'LIVE E2E: bootstrap -> sync/map/promote one card -> move -> reconcile clean -> snapshot diff/invert -> teardown',
  { skip: !LIVE ? 'set GBS_LIVE=1 to run (see docs/LIVE-RUNBOOK.md)' : false, timeout: 300_000 },
  async () => {
    // Lazy-import the verbs that are only needed in the live path to keep the
    // module graph identical to the other live tests.
    const {
      syncRecord, promoteApply, move, reconcileScan,
      snapshotTake, snapshotDiff, snapshotInvert,
    } = await import('../scripts/board-manager.mjs');
    const { readLedger, writeLedger } = await import('../scripts/lib/ledger.mjs');
    const { applyProposals } = await import('../scripts/lib/mapper.mjs');

    // ── Setup: temp dir + engine (live-bootstrap.test.mjs conventions) ────────
    const dir = mkdtempSync(join(os.tmpdir(), 'gbs-live-e2e-'));
    const boardPath = join(dir, 'board.json');
    const title = `gbs-e2e-${process.pid}`;

    // Build the real engine adapter exactly as live-bootstrap.test.mjs does.
    const flagsFor = (opts = {}) => ({
      staged: !!opts.staged, json: false, labels: null, identity: 'pat',
    });
    let loadedCfg;   // eng-level config (eng.loadConfig)
    let verbCfg;     // verb-level config (loadConfig from lib/config.mjs)
    const engine = {
      listItems: () => eng.listItems(loadedCfg),
      listItemsWithBodies: () => eng.listItems(loadedCfg, { withBodies: true }),
      getStageField: () => eng.getStageField(loadedCfg),
      createIssue: (t, b, opts = {}) => {
        const f = flagsFor(opts);
        f.labels = (opts.labels || []).join(',') || null;
        return eng.createIssue(loadedCfg, f, t, b);
      },
      addIssueToBoard: (u, opts = {}) => eng.addIssueToBoard(loadedCfg, flagsFor(opts), u),
      setStage: (id, lane, opts = {}) => eng.setStage(loadedCfg, flagsFor(opts), id, lane),
      setLabels: (n, labs, opts = {}) => eng.setLabels(loadedCfg, flagsFor(opts), n, (labs || []).join(',')),
      comment: (n, body, opts = {}) => eng.comment(loadedCfg, flagsFor(opts), n, body),
      // bootstrap-only helpers (same as live-bootstrap.test.mjs)
      getOwnerId: (login) => eng.getOwnerId(login),
      findProjectByTitle: (l, t, ti) => eng.findProjectByTitle(l, t, ti),
      findStageFieldByName: (p, n) => eng.findStageFieldByName(p, n),
      createProject: (o, ti, opts = {}) => eng.createProject(flagsFor(opts), o, ti),
      createStageField: (p, lanes, opts = {}) => eng.createStageField(flagsFor(opts), p, lanes),
      ensureLabels: (r, labs, opts = {}) => eng.ensureLabels(flagsFor(opts), r, labs),
    };

    // Track every created resource so teardown has a full manifest even on failure.
    const created = { projectId: null, projectUrl: null, issues: [] };

    try {
      // ── 1. Bootstrap a throwaway board ──────────────────────────────────────
      const r = await bootstrap({
        engine, staged: false, dir, detectRepo, title, preset: 'build',
        writeConfig: (c) => writeBoardConfig(boardPath, c), existingConfig: null,
      });
      assert.equal(r.committed, true);
      const cfg = r.config;
      assert.ok(cfg.projectId.startsWith('PVT_'));
      assert.ok(cfg.stageFieldId.startsWith('PVTSSF_'));
      created.projectId  = cfg.projectId;
      created.projectUrl = cfg.projectUrl;

      // Wire up the configs that the verb-level ops need (live-promote.test.mjs pattern).
      loadedCfg = eng.loadConfig(boardPath);
      verbCfg   = await loadConfig(boardPath);

      // ── 2. Seed one TODO card through the real pipeline ──────────────────────
      writeFileSync(join(dir, 'TODO.md'), '- [ ] E2E smoke card', 'utf8');
      const syncResult = await syncRecord({
        dir, config: verbCfg, extracted: [{ title: 'E2E smoke card', source: 'TODO.md' }],
      });
      assert.equal(syncResult.report.added.length, 1, 'syncRecord must add the new candidate');

      const ledger = await readLedger(dir);
      const candidate = ledger.candidates[0];
      assert.ok(candidate, 'ledger must have one candidate after sync');

      const firstLane = Object.keys(verbCfg.stageOptions)[0];
      const { ledger: mapped } = applyProposals(ledger, [{
        candidateId: candidate.id, kind: 'card', title: 'E2E smoke card',
        lane: firstLane, owner: 'agent', confidence: 0.95, rationale: 'e2e',
      }], verbCfg);
      await writeLedger(dir, mapped);

      const ap = await promoteApply(null, { engine, config: verbCfg, staged: false, dir });
      assert.equal(ap.report.promoted.length, 1, 'promoteApply must promote 1 card');
      const issueNumber = ap.report.promoted[0].issueNumber;
      assert.ok(issueNumber, 'promoted card must have an issue number');
      created.issues.push(issueNumber);

      // ledger reflects the promotion
      const afterLedger = await readLedger(dir);
      assert.equal(afterLedger.candidates[0].status, 'promoted');

      // ── 3. Take baseline snapshot ────────────────────────────────────────────
      await snapshotTake('e2e-baseline', { engine, config: verbCfg, staged: false, dir });

      // ── 4. Live move to the second lane ─────────────────────────────────────
      const lanes = Object.keys(verbCfg.stageOptions);
      const targetLane = lanes[1] ?? lanes[0];
      await move(issueNumber, targetLane, { engine, config: verbCfg, staged: false, dir });

      // ── 5. Reconcile — must be clean after a normal move ────────────────────
      const scan = await reconcileScan({ engine, config: verbCfg, dir });
      assert.ok(scan.drift.clean, `reconcile must be clean: ${scan.say}`);

      // ── 6. Snapshot diff + invert (read-only assertions) ────────────────────
      const d = await snapshotDiff('latest', null, { engine, config: verbCfg, staged: false, dir });
      assert.equal(d.diff.moved.length, 1, 'diff must report exactly 1 moved card');

      const inv = await snapshotInvert('latest', null, { engine, config: verbCfg, staged: false, dir });
      assert.equal(inv.ops.length, 1, 'invert must propose exactly 1 inverse move (read-only)');
      assert.equal(inv.ops[0].op, 'move');

    } finally {
      // ── Teardown ─────────────────────────────────────────────────────────────
      // Mirror live-bootstrap.test.mjs: delete the throwaway project (best-effort).
      // On any failure, print the full resource manifest for manual cleanup.
      try {
        if (created.projectId) {
          eng.graphqlVars(
            'mutation($id:ID!){ deleteProjectV2(input:{projectId:$id}){ clientMutationId } }',
            { id: created.projectId },
          );
        }
      } catch (e) {
        console.error(
          'LIVE E2E TEARDOWN FAILED — clean up by hand:',
          JSON.stringify(created),
          `(${e.message})`,
        );
        console.error('  Project URL:', created.projectUrl);
        console.error('  Issues to close:', created.issues);
      }
    }
  },
);
