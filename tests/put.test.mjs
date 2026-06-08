// tests/put.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { put } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

test('put files a human task: create -> add -> stage -> label, report-back', async () => {
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_1', number: 41, url: 'u', contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_1' }),
  });
  const ctx = { engine, config: { routing: { agent: 'agent:go', human: 'needs-claude' }, stageOptions: { Intake: 'o1' } }, staged: false };
  const r = await put([{ title: 'Submit form', owner: 'human', lane: 'Intake' }], ctx);
  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue', 'addIssueToBoard', 'setStage', 'setLabels']);
  assert.match(engine.calls.at(-1).args.join(' '), /needs-claude/);
  assert.match(r.say, /On your plate/);
  assert.equal(r.committed, true);
});

test('put in staged mode previews via createIssue ONLY (no downstream ops on a null issue) and says "Would file"', async () => {
  // Corrected contract (a live `put --staged` caught the old one): in staged
  // mode there is NO real issue, so put must NOT chain addIssueToBoard/setStage/
  // setLabels on a nonexistent issue (the real engine null-derefs on issueUrl.match
  // before its stagedGuard). It previews by calling ONLY createIssue per task.
  const engine = makeMockEngine({
    createIssue: () => ({ staged: true, wouldRun: { op: 'gh issue create' } }),
  });
  const ctx = { engine, config: { routing: { agent: 'agent:go', human: 'needs-claude' }, stageOptions: { Intake: 'o1' } }, staged: true };
  const r = await put([{ title: 'Submit form', owner: 'human', lane: 'Intake' }], ctx);

  // ONLY createIssue is called in staged mode — the downstream ops are skipped.
  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue']);
  assert.ok(!ops.includes('addIssueToBoard'), 'must NOT call addIssueToBoard on a nonexistent staged issue');
  assert.ok(!ops.includes('setStage'), 'must NOT call setStage on a nonexistent staged issue');
  assert.ok(!ops.includes('setLabels'), 'must NOT call setLabels on a nonexistent staged issue');

  // createIssue was passed { staged:true } so the engine previews + validates.
  assert.equal(engine.calls[0].args.at(-1)?.staged, true, 'createIssue should be passed { staged:true }');

  assert.equal(r.committed, false);
  assert.match(r.say, /Would file/);
});

test('put defaults: body="", owner=human, lane=defaultLane; agent task gets agent label', async () => {
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_2', number: 7, url: 'u7', contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_7' }),
  });
  const ctx = {
    engine,
    config: {
      routing: { agent: 'agent:go', human: 'needs-claude' },
      stageOptions: { Ideas: 'o1' },
      preset: { lanes: [{ name: 'Ideas', terminal: false }, { name: 'Shipped', terminal: true }] },
    },
    staged: false,
  };
  const r = await put([{ title: 'Investigate', owner: 'agent' }], ctx);

  // createIssue called with body '' (second positional arg)
  const createCall = engine.calls.find((c) => c.op === 'createIssue');
  assert.equal(createCall.args[1], '');

  // setStage called with the default lane 'Ideas'
  const stageCall = engine.calls.find((c) => c.op === 'setStage');
  assert.equal(stageCall.args[1], 'Ideas');

  // agent task labelled with the agent routing label
  const labelCall = engine.calls.find((c) => c.op === 'setLabels');
  assert.match(labelCall.args.join(' '), /agent:go/);

  // report-back: 1 card on agent's queue, 0 on human plate
  assert.match(r.say, /Claude's queue: 1/);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].owner, 'agent');
});

test('put files multiple cards and reports a combined queue split', async () => {
  let n = 100;
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: `I_${n}`, number: n++, url: `u${n}`, contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_x' }),
  });
  const ctx = { engine, config: { routing: { agent: 'agent:go', human: 'needs-claude' }, stageOptions: { Intake: 'o1' } }, staged: false };
  const r = await put(
    [
      { title: 'H1', owner: 'human', lane: 'Intake' },
      { title: 'A1', owner: 'agent', lane: 'Intake' },
      { title: 'H2', owner: 'human', lane: 'Intake' },
    ],
    ctx
  );
  assert.equal(r.created.length, 3);
  assert.match(r.say, /Filed 3 card\(s\)/);
  assert.match(r.say, /On your plate: 2/);
  assert.match(r.say, /Claude's queue: 1/);
});
