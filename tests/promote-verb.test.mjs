// tests/promote-verb.test.mjs — promote verb behavior against the mock engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { promotePlan, promoteApply } from '../scripts/board-manager.mjs';
import { ensureLedger, writeLedger, readLedger } from '../scripts/lib/ledger.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-promote-'));
const CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2', Shipped: 'o3' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  rules: { promoteConfidenceBelow: 0.8 },
};

// Seed a ledger with exactly the given candidate objects.
async function seed(dir, candidates) {
  const l = await ensureLedger(dir);
  l.candidates = candidates;
  await writeLedger(dir, l);
}

const mappedCard = (over = {}) => ({ id: 'aaaaaaaaaaaa', title: 'Wire auth', note: 'auth context', source: 'manual', kind: 'card', suggestedLane: 'Building', suggestedOwner: 'agent', confidence: 0.95, status: 'mapped', addedAt: 't', ...over });

const mappedComment = (over = {}) => ({ id: 'dddddddddddd', title: 'note', note: 'see spec', kind: 'comment', commentTarget: 12, confidence: 0.9, status: 'mapped', addedAt: 't', ...over });

test('promotePlan classifies the ledger read-only and reports counts', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard(), mappedCard({ id: 'bbbbbbbbbbbb', title: 'Lowconf', confidence: 0.4 })]);
  const r = await promotePlan({ dir, config: CFG });
  assert.equal(r.plan.confident.length, 1);
  assert.equal(r.plan.uncertain.length, 1);
  assert.match(r.say, /1 confident/);
  // read-only: ledger untouched
  const after = await readLedger(dir);
  assert.equal(after.candidates[0].status, 'mapped');
});

test('promote apply --staged previews only: createIssue(staged) + comment(staged), NO board writes, ledger unchanged', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard(), mappedComment()]);
  const engine = makeMockEngine({
    createIssue: () => ({ staged: true, wouldRun: { op: 'gh issue create' } }),
    comment: () => ({ staged: true, wouldRun: { op: 'gh issue comment' } }),
  });
  const r = await promoteApply(null, { engine, config: CFG, staged: true, dir });

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue', 'comment']); // confident card, then confident comment
  assert.ok(!ops.includes('addIssueToBoard'), 'no addIssueToBoard on a nonexistent staged issue');
  assert.ok(!ops.includes('setStage'));
  assert.ok(!ops.includes('setLabels'));
  // createIssue passed { staged:true }
  assert.equal(engine.calls[0].args.at(-1)?.staged, true);
  // report + say
  assert.equal(r.report.wouldCreate.length, 1);
  assert.equal(r.report.wouldComment.length, 1);
  assert.match(r.say, /staged — nothing written/);
  // ledger untouched
  const after = await readLedger(dir);
  assert.equal(after.candidates[0].status, 'mapped');
  assert.equal(after.candidates[1].status, 'mapped');
});

test('promote apply commits a confident card: create->add->stage->label, marker in body, ledger promoted', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard()]);
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_1', number: 41, url: 'https://x/41', contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_1' }),
  });
  const r = await promoteApply(null, { engine, config: CFG, staged: false, dir });

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue', 'addIssueToBoard', 'setStage', 'setLabels']);

  // marker stamped into the issue body (createIssue's 2nd positional arg)
  const createCall = engine.calls.find((c) => c.op === 'createIssue');
  assert.match(createCall.args[1], /gboards:cid=aaaaaaaaaaaa/);
  assert.match(createCall.args[1], /auth context/); // note preserved

  // stage uses the mapped lane; labels use the owner routing label
  assert.equal(engine.calls.find((c) => c.op === 'setStage').args[1], 'Building');
  assert.match(engine.calls.find((c) => c.op === 'setLabels').args.join(' '), /agent:go/);

  // ledger updated with refs
  const after = (await readLedger(dir)).candidates[0];
  assert.equal(after.status, 'promoted');
  assert.equal(after.promotion.issueNumber, 41);
  assert.equal(after.promotion.itemId, 'IT_1');
  assert.equal(r.report.promoted.length, 1);
});

test('promote apply commits a confident comment via engine.comment(commentTarget, text)', async () => {
  const dir = tmp();
  await seed(dir, [mappedComment()]);
  const engine = makeMockEngine({ comment: () => ({ commentUrl: 'https://x/12#c1' }) });
  const r = await promoteApply(null, { engine, config: CFG, staged: false, dir });

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['comment']); // no issue creation for a comment
  const commentCall = engine.calls[0];
  assert.equal(commentCall.args[0], 12);          // commentTarget
  assert.equal(commentCall.args[1], 'see spec');  // text from note

  const after = (await readLedger(dir)).candidates[0];
  assert.equal(after.status, 'promoted');
  assert.equal(after.promotion.commentTarget, 12);
  assert.equal(r.report.promoted.length, 1);
});

test('promote apply is idempotent: a re-run over a promoted candidate creates no second issue', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard()]);
  let issueNo = 41;
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_1', number: issueNo++, url: `https://x/${issueNo}`, contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_1' }),
  });
  await promoteApply(null, { engine, config: CFG, staged: false, dir });   // first run -> promotes
  const r2 = await promoteApply(null, { engine, config: CFG, staged: false, dir }); // second run -> no-op

  // createIssue called exactly once across BOTH runs
  assert.equal(engine.calls.filter((c) => c.op === 'createIssue').length, 1);
  assert.equal(r2.report.promoted.length, 0);
  assert.ok(r2.report.skipped.find((s) => s.reason === 'already promoted'));
});

test('promote apply resumes a partial candidate: setStage fails once, re-run finishes without a second createIssue', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard()]);
  let stageCalls = 0;
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_1', number: 41, url: 'https://x/41', contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_1' }),
    setStage: () => { if (stageCalls++ === 0) throw new Error('stage boom'); return { ok: true }; },
  });

  // First run: create + add succeed, setStage throws -> partial, NOT promoted.
  const r1 = await promoteApply(null, { engine, config: CFG, staged: false, dir });
  assert.equal(r1.report.partial.length, 1);
  assert.equal(r1.report.promoted.length, 0);
  let cand = (await readLedger(dir)).candidates[0];
  assert.equal(cand.status, 'mapped');               // NOT promoted
  assert.equal(cand.promotion.issueNumber, 41);      // refs persisted
  assert.equal(cand.promotion.itemId, 'IT_1');

  // Second run: createIssue + addIssueToBoard are SKIPPED (refs present), setStage now succeeds.
  const r2 = await promoteApply(null, { engine, config: CFG, staged: false, dir });
  assert.equal(engine.calls.filter((c) => c.op === 'createIssue').length, 1, 'createIssue must run only once total');
  assert.equal(engine.calls.filter((c) => c.op === 'addIssueToBoard').length, 1, 'addIssueToBoard must run only once total');
  assert.equal(r2.report.promoted.length, 1);
  cand = (await readLedger(dir)).candidates[0];
  assert.equal(cand.status, 'promoted');
});

test('promote apply refuses a bad decisions file before any board write', async () => {
  const dir = tmp();
  // one low-confidence card -> it lands in uncertain
  await seed(dir, [mappedCard({ id: 'bbbbbbbbbbbb', confidence: 0.4 })]);
  const engine = makeMockEngine({});

  // unknown candidateId
  await assert.rejects(
    () => promoteApply({ zzzzzzzzzzzz: { action: 'promote' } }, { engine, config: CFG, staged: false, dir }),
    /refused/);
  // invalid lane override on the real uncertain item
  await assert.rejects(
    () => promoteApply({ bbbbbbbbbbbb: { action: 'promote', lane: 'Nope' } }, { engine, config: CFG, staged: false, dir }),
    /refused/);

  assert.equal(engine.calls.length, 0, 'no engine ops on a refused run');
  // confident bucket was empty here, so the ledger is untouched regardless
  assert.equal((await readLedger(dir)).candidates[0].status, 'mapped');
});

test('promote apply refuses to commit when pushPolicy is manual (no engine calls)', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard()]);
  const engine = makeMockEngine({});
  await assert.rejects(
    () => promoteApply(null, { engine, config: { ...CFG, pushPolicy: 'manual' }, staged: false, dir }),
    /pushPolicy is 'manual'/);
  assert.equal(engine.calls.length, 0);

  // but --staged still previews under manual policy
  const staticEngine = makeMockEngine({ createIssue: () => ({ staged: true }) });
  const r = await promoteApply(null, { engine: staticEngine, config: { ...CFG, pushPolicy: 'manual' }, staged: true, dir });
  assert.equal(r.report.wouldCreate.length, 1);
});

test('promote apply isolates a per-candidate failure: one partial, the other still promoted', async () => {
  const dir = tmp();
  await seed(dir, [mappedCard(), mappedCard({ id: 'bbbbbbbbbbbb', title: 'Second' })]);
  let n = 0;
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: `I_${++n}`, number: 40 + n, url: `https://x/${40 + n}`, contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: `IT_${n}` }),
    setStage: (itemId) => { if (itemId === 'IT_1') throw new Error('stage boom'); return { ok: true }; },
  });
  const r = await promoteApply(null, { engine, config: CFG, staged: false, dir });
  assert.equal(r.report.partial.length, 1);
  assert.equal(r.report.promoted.length, 1);
  const after = await readLedger(dir);
  const first = after.candidates.find((c) => c.id === 'aaaaaaaaaaaa');
  const second = after.candidates.find((c) => c.id === 'bbbbbbbbbbbb');
  assert.equal(first.status, 'mapped');      // failed mid-chain -> not promoted
  assert.equal(second.status, 'promoted');   // isolated success
});
