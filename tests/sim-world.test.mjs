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
