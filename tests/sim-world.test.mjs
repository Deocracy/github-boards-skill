// tests/sim-world.test.mjs — the harness must not be trusted untested: mock
// semantics, fault one-shots, and (Task 3) a deliberate invariant violation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/sim-world.mjs';

test('world board: setLabels is ADDITIVE, removeLabels subtractive (route depends on it)', async () => {
  const w = await makeWorld();
  const issue = await w.engine.createIssue('Card A', 'body');
  await w.engine.setLabels(issue.number, ['agent:go']);
  await w.engine.setLabels(issue.number, ['bug']);
  await w.engine.removeLabels(issue.number, ['agent:go']);
  await w.engine.addIssueToBoard(issue.url, {});
  const { items } = await w.engine.listItems();
  assert.deepEqual([...items[0].labels].sort(), ['bug']);
});

test('world board: archiveCard hides from listItems; retitle is visible', async () => {
  const w = await makeWorld();
  const a = await w.engine.createIssue('Card A', '');
  const b = await w.engine.createIssue('Card B', '');
  await w.engine.addIssueToBoard(a.url, {});
  await w.engine.addIssueToBoard(b.url, {});
  w.board.retitle(a.number, 'Card A renamed');
  w.board.archiveCard(b.number);
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Card A renamed');
});

test('world board: listItemsWithBodies carries the issue body (cid markers live there)', async () => {
  const w = await makeWorld();
  const a = await w.engine.createIssue('Card A', 'hello <!-- marker -->');
  await w.engine.addIssueToBoard(a.url, {});
  const { items } = await w.engine.listItemsWithBodies();
  assert.match(items[0].body, /<!-- marker -->/);
});

test('faults: failNext fires exactly once, then clears', async () => {
  const w = await makeWorld();
  w.engine.failNext('setStage');
  const a = await w.engine.createIssue('Card A', '');
  const it = await w.engine.addIssueToBoard(a.url, {});
  await assert.rejects(() => w.engine.setStage(it.itemId, 'Ideas', {}), /injected: setStage/);
  await w.engine.setStage(it.itemId, 'Ideas', {}); // second call succeeds
  const { items } = await w.engine.listItems();
  assert.equal(items[0].stageLabel, 'Ideas');
});

test('faults: failNext onCall targets the Nth call (batch windows)', async () => {
  const w = await makeWorld();
  w.engine.failNext('createIssue', { onCall: 2 });
  await w.engine.createIssue('first', '');                       // call 1 fine
  await assert.rejects(() => w.engine.createIssue('second', ''), /injected: createIssue/);
  await w.engine.createIssue('third', '');                       // cleared
});

test('faults: sabotageLedgerOnce makes the NEXT ledger write fail, then auto-repairs', async () => {
  const w = await makeWorld();
  const { writeLedger, readLedger } = await import('../scripts/lib/ledger.mjs');
  await writeLedger(w.dir, { candidates: [] }); // ledger exists
  w.faults.sabotageLedgerOnce();
  await assert.rejects(() => writeLedger(w.dir, { candidates: [] }));
  w.faults.repairLedger();
  await writeLedger(w.dir, { candidates: [{ id: 'x', title: 't', status: 'pending' }] });
  assert.equal((await readLedger(w.dir)).candidates.length, 1);
});

test('ops: full pipeline round — seedTodo -> pipelineSync -> mapAll -> promoteAll lands cards', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['Wire retry', 'Decide hosting']);
  const rec = await w.ops.pipelineSync();
  assert.equal(rec.added.length, 2);
  await w.ops.mapAll();
  const rep = await w.ops.promoteAll();
  assert.equal(rep.report.promoted.length, 2);
  const { items } = await w.engine.listItems();
  assert.deepEqual(items.map((i) => i.title).sort(), ['Decide hosting', 'Wire retry']);
  assert.ok(items.every((i) => i.stageLabel === 'Ideas' && i.labels.includes('agent:go')));
});

test('ops: newSession runs REAL summary (snapshot piggyback included) and returns the say', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  const say1 = await w.newSession();
  assert.match(say1, /First look|Since last time/);
  const { listSnapshots } = await import('../scripts/lib/snapshots.mjs');
  assert.equal((await listSnapshots(w.dir)).length, 1); // piggyback wrote the snapshot
  await w.ops.humanMove(1, 'Building');
  const say2 = await w.newSession();
  assert.match(say2, /1 moved/);
});

test('ops: humanFlip routes through the REAL route verb (escalation comment on ->human)', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.ops.humanFlip(1); // agent -> human
  const { items } = await w.engine.listItems();
  assert.deepEqual(items[0].labels.sort(), ['needs-claude']);
  assert.ok(w.engine.calls.some((c) => c.op === 'comment'), 'route->human escalates via comment');
});

test('ops: undoTo executes the inverse plan via real move/route and is sound (re-invert empty)', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.ops.snapshotTake('baseline');
  await w.ops.humanMove(1, 'Building');
  await w.ops.humanFlip(1);
  const r = await w.ops.undoTo('~1');
  assert.equal(r.executed, 2);
  const { items } = await w.engine.listItems();
  assert.equal(items[0].stageLabel, 'Ideas');
  assert.deepEqual(items[0].labels.sort(), ['agent:go']);
});

test('checkInvariants: clean world passes; deliberate duplicate-cid violation throws (non-vacuous)', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.newSession();
  await w.checkInvariants(); // must not throw

  // Backdoor (test-only): clone card 1 with the SAME cid marker body onto the board.
  const src = w._internal.issues[0];
  const dupe = await w.engine.createIssue(src.title + ' (dupe)', src.body);
  await w.engine.addIssueToBoard(dupe.url, {});
  await assert.rejects(() => w.checkInvariants(), /no-duplicate-cards/);
});

test('checkInvariants: journal regression (line count shrinks) throws', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.newSession();
  await w.checkInvariants(); // primes the monotonic counter
  const { writeFileSync: wf } = await import('node:fs');
  wf(`${w.dir}/.github-boards/snapshots/log.jsonl`, '', 'utf8'); // truncate (test-only backdoor)
  await assert.rejects(() => w.checkInvariants(), /journal-integrity/);
});

test('checkInvariants: resume-pending candidates must be classifiable, not lost', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll();
  await w.ops.crashedPromote('A3'); // refs persisted, itemId set, setStage failed — resume-pending
  // A crashed A3 state is LEGAL: the candidate has refs, status is not 'promoted', not 'dismissed'.
  // checkInvariants must pass (classifiable) — not throw.
  await w.checkInvariants();
});

test('checkInvariants: A2 crash state (refs persisted, card never reached board) is LEGAL — invisible to reconcile, promote resumes', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll();
  await w.ops.crashedPromote('A2'); // addIssueToBoard died
  await w.checkInvariants();        // must NOT throw — legal resumable state
  await w.ops.promoteAll();         // resume completes on the SAME issue
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].issueNumber, 1, 'resumed, not re-created');
  await w.checkInvariants();
});

// F3 regression: an unconsumed armed fault (e.g. A3 partial whose resume skips
// addIssueToBoard, leaving an A2 fault unarmed) must NOT leak onto the next op.
test('crashedPromote: an unconsumed armed fault is cleared — never leaks onto later ops', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['One']);
  await w.ops.pipelineSync(); await w.ops.mapAll();
  await w.ops.crashedPromote('A3');  // partial: refs full, card on board, setStage died
  await w.ops.crashedPromote('A2');  // resume path skips addIssueToBoard -> fault unconsumed
  await w.ops.promoteAll();          // must NOT die of an injected leak
  const { items } = await w.engine.listItems();
  assert.equal(items.length, 1);
  await w.checkInvariants();
});
