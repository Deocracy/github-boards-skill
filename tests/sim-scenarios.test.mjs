// tests/sim-scenarios.test.mjs — the crash atlas (spec §5) + composition
// stories (§6). Every crash is injected at a REACHABLE seam; recovery always
// happens in a NEW session through the real verbs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/sim-world.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';

async function seededWorld(titles = ['Wire retry']) {
  const w = await makeWorld();
  await w.ops.seedTodo(titles);
  await w.ops.pipelineSync();
  await w.ops.mapAll();
  return w;
}

test('A1: ledger write dies after createIssue — refs never persist; board still gets exactly ONE card', async () => {
  const w = await seededWorld();
  const rep = await w.ops.crashedPromote('A1');
  assert.equal(rep.report.partial.length, 1, 'the item must report partial');
  // persisted truth: candidate has NO refs; the created issue exists OFF-board
  let ledger = await readLedger(w.dir);
  assert.equal(ledger.candidates[0].promotion ?? null, null);
  assert.equal((await w.engine.listItems()).items.length, 0, 'nothing reached the board');

  await w.newSession(); // crashed session over; world must be recoverable
  // recovery: re-promote files a fresh issue and lands ONE card; the original
  // issue is off-board garbage (documented accepted loss — reconcile is
  // board-scoped and structurally cannot see it).
  const rep2 = await w.ops.promoteAll();
  assert.equal(rep2.report.promoted.length, 1);
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 1, 'exactly one card despite the orphan issue');
  ledger = await readLedger(w.dir);
  assert.equal(ledger.candidates[0].status, 'promoted');
  assert.ok(ledger.candidates[0].promotion.itemId, 'recovered refs point at the fresh card');
  assert.equal(ledger.candidates[0].promotion.issueNumber, items[0].issueNumber, 'ledger refs match the board card');
  assert.equal(items[0].stageLabel, 'Ideas');
  assert.deepEqual(items[0].labels, ['agent:go']);
  await w.checkInvariants();
});

test('A2: addIssueToBoard dies — refs persisted off-board; reconcile sees CLEAN (board-scoped); promote resumes the SAME issue', async () => {
  const w = await seededWorld();
  await w.ops.crashedPromote('A2');
  const ledger = await readLedger(w.dir);
  assert.ok(ledger.candidates[0].promotion.issueNumber, 'refs persisted before the crash');
  assert.equal(ledger.candidates[0].promotion.itemId ?? null, null);

  await w.newSession();
  const { reconcileScan } = await import('../scripts/board-manager.mjs');
  const scan = await reconcileScan({ engine: w.engine, config: w.config, dir: w.dir });
  assert.ok(scan.drift.clean, 'off-board partial is invisible to board-scoped reconcile — by design');
  const rep2 = await w.ops.promoteAll();
  assert.equal(rep2.report.promoted.length, 1);
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].issueNumber, 1, 'the ORIGINAL issue was resumed, not re-created');
  assert.equal(items[0].stageLabel, 'Ideas');
  assert.deepEqual(items[0].labels, ['agent:go']);
  await w.checkInvariants();
});

test('A3: setStage dies — card on board laneless; resume completes stage+labels on the same card', async () => {
  const w = await seededWorld();
  await w.ops.crashedPromote('A3');
  const before = (await w.engine.listItems()).items;
  assert.equal(before.length, 1);
  assert.equal(before[0].stageLabel, null);

  await w.newSession();
  const { reconcileScan } = await import('../scripts/board-manager.mjs');
  const scan = await reconcileScan({ engine: w.engine, config: w.config, dir: w.dir });
  assert.equal(scan.drift.resumePending.length, 1, 'on-board partial IS classified resume-pending');
  const rep2 = await w.ops.promoteAll();
  assert.equal(rep2.report.promoted.length, 1);
  const after = (await w.engine.listItems()).items;
  assert.equal(after.length, 1, 'no second card');
  assert.equal(after[0].stageLabel, 'Ideas');
  assert.deepEqual(after[0].labels, ['agent:go']);
  await w.checkInvariants();
});

test('A3b: setLabels dies — staged but labelless; resume is a safe idempotent completion', async () => {
  const w = await seededWorld();
  await w.ops.crashedPromote('A3b');
  assert.deepEqual((await w.engine.listItems()).items[0].labels, []);
  await w.newSession();
  const { reconcileScan } = await import('../scripts/board-manager.mjs');
  const scan = await reconcileScan({ engine: w.engine, config: w.config, dir: w.dir });
  assert.equal(scan.drift.resumePending.length, 1, 'on-board staged-but-labelless partial is classified resume-pending');
  await w.ops.promoteAll();
  const items = (await w.engine.listItems()).items;
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].labels, ['agent:go']);
  await w.checkInvariants();
});

test('A4: batch splits — item 1 promoted once, item 2 crashes at create; re-run completes only item 2', async () => {
  const w = await seededWorld(['First card', 'Second card']);
  const rep = await w.ops.crashedPromote('A4');
  assert.equal(rep.report.promoted.length, 1);
  assert.equal(rep.report.partial.length, 1);

  await w.newSession();
  const rep2 = await w.ops.promoteAll();
  assert.equal(rep2.report.promoted.length, 1, 'only the crashed item promotes');
  assert.ok(rep2.report.skipped.some((s) => s.reason === 'already promoted'), 'item 1 skipped, not re-filed');
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.stageLabel === 'Ideas' && i.labels.includes('agent:go')));
  await w.checkInvariants();
});
