// tests/sim-soak.test.mjs — seeded random walks over the op vocabulary with
// invariants checked after EVERY step. Deterministic: fixed seeds, inline LCG.
// A failure prints seed + step + full trace — replayable verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/sim-world.mjs';
import { reconcileScan } from '../scripts/board-manager.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';

const SEEDS = [0xC0FFEE, 0xBADF00D, 0x5EED, 0xA11CE];
const STEPS = 120;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Weighted op table. Each op must be safe to attempt in ANY world state
 *  (no-op gracefully when preconditions are absent). */
function buildOps(w, rnd) {
  let todoN = 0;
  const cards = async () => (await w.engine.listItems()).items;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const lanes = Object.keys(w.config.stageOptions);
  return [
    { w: 3, name: 'seed+sync', run: async () => { todoN += 1; await w.ops.seedTodo([`Task ${todoN}-${Math.floor(rnd() * 1e6)}`]); await w.ops.pipelineSync(); } },
    { w: 2, name: 'mapAll', run: () => w.ops.mapAll() },
    { w: 2, name: 'promoteAll', run: () => w.ops.promoteAll() },
    // NOTE: crashedPromote draws exclude 'A1'/'A4' — A1's ledger sabotage + repair
    // inside a random walk risks repairing over states other ops created; A4 needs
    // >=2 pending candidates. Both are covered by their dedicated scenarios in
    // sim-scenarios.test.mjs; the soak exercises the engine-seam windows only.
    // Precondition guard: only arm a fault when there is at least one mapped
    // candidate; if promoteApply short-circuits (nothing to do) the fault leaks
    // to the next op that uses the same engine method — a world-wiring hazard.
    { w: 1, name: 'crashedPromote', run: async () => {
        const ledger = (await readLedger(w.dir)) || { candidates: [] };
        const hasMapped = (ledger.candidates || []).some((c) => c.status === 'mapped');
        if (!hasMapped) return;
        await w.ops.crashedPromote(pick(['A2', 'A3', 'A3b']));
      } },
    { w: 4, name: 'humanMove', run: async () => { const c = await cards(); if (c.length) await w.ops.humanMove(pick(c).issueNumber, pick(lanes)); } },
    { w: 2, name: 'humanFlip', run: async () => { const c = await cards(); if (c.length) await w.ops.humanFlip(pick(c).issueNumber); } },
    { w: 1, name: 'archive', run: async () => { const c = await cards(); if (c.length > 1) w.board.archiveCard(pick(c).issueNumber); } },
    { w: 1, name: 'retitle', run: async () => { const c = await cards(); if (c.length) w.board.retitle(pick(c).issueNumber, `Renamed ${Math.floor(rnd() * 1e6)}`); } },
    { w: 3, name: 'newSession', run: () => w.newSession() },
    { w: 1, name: 'snapshotTake', run: () => w.ops.snapshotTake(null) },
    { w: 1, name: 'reconcile', run: async () => {
        // keep-everything decisions: safe in any state (uncertain -> keep).
        // Real decisions shape is {[candidateId]: {action: 'keep'}} as proven
        // by resolveReconcileDecisions in scripts/lib/reconcile.mjs.
        const { drift } = await reconcileScan({ engine: w.engine, config: w.config, dir: w.dir });
        if (drift.clean) return;
        const decisions = Object.fromEntries(
          drift.uncertain.map((u) => [u.candidateId ?? u.id, { action: 'keep' }]),
        );
        await w.ops.reconcileScanHeal(decisions);
      } },
  ];
}

for (const seed of SEEDS) {
  test(`soak seed=0x${seed.toString(16).toUpperCase()}: ${STEPS} steps, invariants after every step`, async () => {
    const w = await makeWorld();
    const rnd = lcg(seed);
    const ops = buildOps(w, rnd);
    const totalW = ops.reduce((a, o) => a + o.w, 0);
    const trace = [];
    for (let step = 0; step < STEPS; step++) {
      let roll = rnd() * totalW;
      const op = ops.find((o) => (roll -= o.w) < 0) || ops[ops.length - 1];
      trace.push(op.name);
      try {
        await op.run();
        await w.checkInvariants();
      } catch (e) {
        // The trace is replayable only by re-running the SAME SEED end-to-end:
        // ops draw randomness from the LCG AFTER the selection roll, so partial
        // re-runs diverge from step N even when the prefix appears identical.
        throw new Error(
          `SOAK FAILURE seed=0x${seed.toString(16)} step=${step} op=${op.name}\n` +
          `trace: ${trace.join(' -> ')}\n${e.stack || e.message}`,
        );
      }
    }
    // Post-loop invariants: same seed context as the loop above — a failure here
    // is also replayable only by re-running the full seed end-to-end.
    await w.checkInvariants();
  });
}
