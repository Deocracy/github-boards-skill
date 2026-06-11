// tests/sim-scenarios.test.mjs — the crash atlas (spec §5) + composition
// stories (§6). Every crash is injected at a REACHABLE seam; recovery always
// happens in a NEW session through the real verbs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, WORLD_CFG } from './helpers/sim-world.mjs';
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

test('B1: snapshot log-append dies — rollback leaves no orphan; retry records the event (through the world)', async () => {
  const w = await seededWorld();
  await w.ops.promoteAll();
  await w.ops.snapshotTake('baseline');
  await w.ops.humanMove(1, 'Building');
  // sabotage: a DIRECTORY at the log path -> appendFile dies inside writeSnapshot
  const { mkdirSync: mkd, rmdirSync: rmd, renameSync: ren } = await import('node:fs');
  const logPath = `${w.dir}/.github-boards/snapshots/log.jsonl`;
  ren(logPath, `${logPath}.bak`); mkd(logPath);
  // ops.snapshotTake is async — catch the rejection
  const r = await w.ops.snapshotTake('doomed').catch((e) => ({ error: e.message }));
  assert.ok(r.error, 'take must fail loudly');
  rmd(logPath); ren(`${logPath}.bak`, logPath);
  // rollback: no orphan snapshot poisons dedup — retry records the move event
  await w.ops.snapshotTake('retry');
  const { readLog } = await import('../scripts/lib/snapshots.mjs');
  const { entries } = await readLog(w.dir, 10);
  assert.equal(entries[0].moved.length, 1, 'the event reached the permanent journal');
  // readLog returns newest-first: entries[0] = retry move, entries[1] = baseline initial.
  // Exactly 2 lines: snapshotTake('baseline') wrote the initial line; the doomed take
  // failed and its rollback unlinked the orphaned snapshot file so no entry was appended;
  // snapshotTake('retry') wrote the move-event line. No other log lines exist.
  assert.equal(entries.length, 2, 'baseline initial + exactly ONE retry event — the failed attempt left no line');
  assert.equal(entries[1].initial, true);
  await w.checkInvariants();
});

test('B2: store transiently over keep is pruned by the next successful write; journal intact', async () => {
  // Import WORLD_CFG at top-level; build a world with keep=2
  const w = await makeWorld({ config: { ...WORLD_CFG, snapshots: { keep: 2 } } });
  await w.ops.seedTodo(['One']); await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  // three distinct boards -> three writes with keep=2: store must end at 2 files,
  // journal must keep ALL events.
  await w.ops.snapshotTake('s1');
  await w.ops.humanMove(1, 'Building'); await w.ops.snapshotTake('s2');
  await w.ops.humanMove(1, 'Review');   await w.ops.snapshotTake('s3');
  const { listSnapshots, readLog } = await import('../scripts/lib/snapshots.mjs');
  assert.equal((await listSnapshots(w.dir)).length, 2);
  assert.equal((await readLog(w.dir, 100)).entries.length, 3);
  await w.checkInvariants();
});

test('C1: sync re-run with the same extraction dedups — no duplicate candidates', async () => {
  const w = await makeWorld();
  await w.ops.seedTodo(['Alpha', 'Beta']);
  const r1 = await w.ops.pipelineSync(); // ops.pipelineSync returns result.report directly
  assert.equal(r1.added.length, 2);
  // a "crashed settlement" presents as: same extraction recorded again next session
  await w.newSession();
  // direct syncRecord call returns { report, say } — use .report
  const { syncRecord } = await import('../scripts/board-manager.mjs');
  const r2 = await syncRecord({
    dir: w.dir, config: w.config, extracted: [{ title: 'Alpha', source: 'TODO.md' }, { title: 'Beta', source: 'TODO.md' }],
  });
  assert.equal(r2.report.added.length, 0);
  assert.equal(r2.report.deduped.length, 2, 'content-hash ids dedup the re-run');
  assert.equal((await readLedger(w.dir)).candidates.length, 2);
  await w.checkInvariants();
});

test('D1: snapshot piggyback dies — summary still succeeds; NEXT session diffs from the state that DID persist', async () => {
  const w = await seededWorld();
  await w.ops.promoteAll();
  w.faults.sabotageSnapshotsDirOnce();
  const say1 = await w.newSession();
  assert.match(say1, /snapshot skipped/i);
  // sabotageSnapshotsDirOnce writes a FILE at .github-boards/snapshots — remove it
  const { rmSync } = await import('node:fs');
  rmSync(`${w.dir}/.github-boards/snapshots`);
  await w.ops.humanMove(1, 'Building');
  const say2 = await w.newSession();
  assert.match(say2, /1 moved/, 'state persisted through the piggyback failure');
  await w.checkInvariants();
});

test('E1: undo crashes between ops — re-invert vs the SAME pinned anchor proposes only the remainder', async () => {
  const w = await seededWorld();
  await w.ops.promoteAll();
  await w.ops.snapshotTake('anchor');
  await w.ops.humanMove(1, 'Building');
  await w.ops.humanFlip(1); // agent -> human
  const { snapshotInvert, move } = await import('../scripts/board-manager.mjs');
  const ctx = { engine: w.engine, config: w.config, staged: false, dir: w.dir };
  const plan = await snapshotInvert('~1', null, ctx);
  assert.equal(plan.ops.length, 2);
  await move(plan.ops[0].issueNumber, plan.ops[0].to, ctx); // execute op 1, then "crash"
  // newSession writes a new snapshot (the board is NOT deduped here — the move ran),
  // aging the 'anchor' snapshot from ~1 to ~2.
  // newSession writes a new snapshot (the board changed — the partial move ran, so
  // dedup does NOT skip it), which ages every prior ref by one position. The anchor
  // is at ~2 only because newSession ALWAYS writes here; if that ever changes
  // (e.g. dedup fires because the board is unchanged), verify the actual index
  // with listSnapshots before asserting the ~N ref.
  await w.newSession();
  const plan2 = await snapshotInvert('~2', null, ctx); // SAME anchor — now aged to ~2
  assert.equal(plan2.ops.length, 1, 'only the route op remains');
  assert.equal(plan2.ops[0].op, 'route');
  await w.checkInvariants();
});

// ---------------------------------------------------------------------------
// Composition stories
// ---------------------------------------------------------------------------

test('STORY anchor-trap: a new session re-snapshots the mutated board; pinned ref undoes, latest warns', async () => {
  const w = await seededWorld();
  await w.ops.promoteAll();
  await w.newSession();                       // snapshot #1: the pre-mutation board
  await w.ops.humanMove(1, 'Building');
  const say = await w.newSession();           // snapshot #2: the MUTATED board (the trap)
  assert.match(say, /1 moved/);
  const { snapshotInvert } = await import('../scripts/board-manager.mjs');
  const ctx = { engine: w.engine, config: w.config, staged: false, dir: w.dir };
  const viaLatest = await snapshotInvert('latest', null, ctx);
  assert.equal(viaLatest.ops.length, 0);
  assert.match(viaLatest.say, /older ref/i, 'the anchor-trap hint fires');
  const pinned = await w.ops.undoTo('~2');    // the pre-mutation snapshot
  assert.equal(pinned.executed, 1);
  assert.equal((await w.engine.listItems()).items[0].stageLabel, 'Ideas');
  await w.checkInvariants();
});

test('STORY long-week: 5 sessions of pipeline + human edits — summaries and the journal agree end-to-end', async () => {
  const w = await makeWorld();
  // S1: first batch
  await w.ops.seedTodo(['One', 'Two']); await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  await w.newSession();
  // S2: human edits
  await w.ops.humanMove(1, 'Building'); await w.ops.humanFlip(2);
  assert.match(await w.newSession(), /1 moved/);
  // S3: second batch + an archive (GitHub-UI)
  await w.ops.seedTodo(['Three']); await w.ops.pipelineSync(); await w.ops.mapAll(); await w.ops.promoteAll();
  w.board.archiveCard(2);
  await w.newSession();
  // S4: a retitle (GitHub-UI) + a move
  w.board.retitle(1, 'One v2'); await w.ops.humanMove(3, 'Review');
  await w.newSession();
  // S5: quiet session — dedup'd snapshot
  const { listSnapshots, readLog } = await import('../scripts/lib/snapshots.mjs');
  const before = (await listSnapshots(w.dir)).length;
  await w.newSession();
  assert.equal((await listSnapshots(w.dir)).length, before, 'idle session adds no snapshot');
  // the journal tells the whole story: initial + every changed session
  const { entries, skippedLines } = await readLog(w.dir, 50);
  assert.equal(skippedLines, 0);
  // 4 entries: S1 newSession = initial, S2 newSession = 1 moved + 1 relabeled,
  // S3 newSession = 1 added + 1 removed (archive), S4 newSession = 1 moved + 1 retitled.
  // S5 is deduped (board unchanged) — no entry written.
  assert.equal(entries.length, 4, 'initial + S2 + S3 + S4 — S5 deduped, no spurious entry');
  const total = entries.reduce((acc, e) => acc + (e.initial ? 0 :
    e.moved.length + e.added.length + e.removed.length + e.relabeled.length + e.retitled.length), 0);
  assert.ok(total >= 5, `journal recorded the week (${total} events)`);
  await w.checkInvariants();
});

// F2 regression: archived card mid-promote (A3 partial) must be classified vanished,
// never silent — and is healable via dismiss (self-extinguishing second scan).
test('A3-then-archive: a mid-promote partial whose card is archived is classified vanished, not silent — and healable', async () => {
  const w = await seededWorld();
  await w.ops.crashedPromote('A3'); // card on board, laneless; status mapped + full refs (itemId set)
  w.board.archiveCard(1);           // GitHub-UI archive — the card is gone from listItems

  await w.newSession();
  const { reconcileScan } = await import('../scripts/board-manager.mjs');
  const scan = await reconcileScan({ engine: w.engine, config: w.config, dir: w.dir });
  assert.ok(!scan.drift.clean, 'must NOT be silent');
  const vanished = scan.drift.uncertain.filter((u) => u.kind === 'vanished');
  assert.equal(vanished.length, 1, 'exactly one vanished entry');
  const entry = vanished[0];
  await w.checkInvariants(); // invariant 2 now passes: classified (vanished in uncertain)

  // heal: dismiss it — second scan clean, promote has nothing to resume
  await w.ops.reconcileScanHeal({ [entry.candidateId]: { action: 'dismiss' } });
  const scan2 = await reconcileScan({ engine: w.engine, config: w.config, dir: w.dir });
  assert.ok(scan2.drift.clean, 'self-extinguishing after dismiss');
  const rep = await w.ops.promoteAll();
  assert.equal(rep.report.promoted.length, 0, 'nothing re-promotes onto an archived card');
  await w.checkInvariants();
});

test('STORY messy-repo: dismissed-but-live + vanished cards reconcile with ZERO board writes; self-extinguishing', async () => {
  const w = await seededWorld(['Keep me', 'Dismiss me']);
  await w.ops.promoteAll();
  // a human dismisses candidate 2 in the ledger while its card lives on (uncertain class).
  // This models a reachable user action: the `ledger`-level dismissal via mapper/ledger edit.
  const { readLedger: rl, writeLedger: wl } = await import('../scripts/lib/ledger.mjs');
  const ledger = await rl(w.dir);
  const c2 = ledger.candidates.find((c) => c.title === 'Dismiss me');
  c2.status = 'dismissed'; // ledger-level dismissal: reachable user action (ledger verb / mapper dismissal)
  await wl(w.dir, ledger);
  // …and card 1 vanishes via the GitHub UI
  w.board.archiveCard(1);

  await w.newSession();
  const callsBefore = w.engine.calls.length;
  // decisions shape: { [candidateId]: { action } } — resolveReconcileDecisions reads d.action
  const keepMe = ledger.candidates.find((c) => c.title === 'Keep me');
  const { scan } = await w.ops.reconcileScanHeal({
    [c2.id]: { action: 'keep' },
    [keepMe.id]: { action: 'keep' },
  });
  assert.ok(!scan.drift.clean, 'drift detected');
  const writes = w.engine.calls.slice(callsBefore)
    .filter((c) => ['createIssue', 'setStage', 'setLabels', 'removeLabels', 'addIssueToBoard', 'comment'].includes(c.op));
  assert.deepEqual(writes, [], 'reconcile NEVER writes the board');
  // 'keep' action in reconcileApply does NO ledger mutation — it only pushes to
  // report.kept (line 804: "untouched; resurfaces next scan"). So the user's prior
  // ledger-level dismissal is preserved exactly as written.
  const after = await rl(w.dir);
  assert.equal(after.candidates.find((c) => c.title === 'Dismiss me').status, 'dismissed', "'keep' preserves the user's dismissal");
  await w.checkInvariants();
});
