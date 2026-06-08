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

test('put in staged mode previews without committing and says "Would file"', async () => {
  const engine = makeMockEngine({
    createIssue: () => ({ staged: true, wouldRun: { op: 'gh issue create' } }),
    addIssueToBoard: () => ({ staged: true, wouldRun: { op: 'addProjectV2ItemById' } }),
    setStage: () => ({ staged: true, wouldRun: { op: 'updateProjectV2ItemFieldValue' } }),
    setLabels: () => ({ staged: true, wouldRun: { op: 'gh issue edit --add-label' } }),
  });
  const ctx = { engine, config: { routing: { agent: 'agent:go', human: 'needs-claude' }, stageOptions: { Intake: 'o1' } }, staged: true };
  const r = await put([{ title: 'Submit form', owner: 'human', lane: 'Intake' }], ctx);

  // The engine ops are STILL called in staged mode (the engine returns a plan, writes nothing)
  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue', 'addIssueToBoard', 'setStage', 'setLabels']);

  // Each write op was passed a staged flag.
  for (const call of engine.calls) {
    const opts = call.args.at(-1);
    assert.equal(opts?.staged, true, `${call.op} should be passed { staged:true }`);
  }

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
