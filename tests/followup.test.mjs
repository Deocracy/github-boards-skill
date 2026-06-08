// tests/followup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followup } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const followupCfg = () => ({
  routing: { agent: 'agent:go', human: 'needs-claude' },
  preset: { lanes: [{ name: 'Ideas', terminal: false }, { name: 'Shipped', terminal: true }] },
});

test('followup files a child card linked to its parent (create -> add -> stage -> label)', async () => {
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_50', number: 50, url: 'u50', contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_50' }),
    setStage: () => ({ ok: true }),
    setLabels: () => ({ ok: true }),
  });
  const ctx = { engine, config: followupCfg(), staged: false };
  const r = await followup(9, { title: 'Write tests' }, ctx);

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue', 'addIssueToBoard', 'setStage', 'setLabels']);

  const createCall = engine.calls.find((c) => c.op === 'createIssue');
  assert.equal(createCall.args[0], 'Write tests');
  assert.match(createCall.args[1], /Follow-up to #9/);

  // default owner is agent -> agent routing label
  const labelCall = engine.calls.find((c) => c.op === 'setLabels');
  assert.deepEqual(labelCall.args[1], ['agent:go']);

  // default lane is the first non-terminal lane
  const stageCall = engine.calls.find((c) => c.op === 'setStage');
  assert.equal(stageCall.args[1], 'Ideas');

  assert.match(r.say, /Filed follow-up #50 'Write tests'/);
  assert.equal(r.committed, true);
  assert.deepEqual(r.created, { number: 50, url: 'u50', owner: 'agent' });
});

test('followup honors an explicit owner and existing body', async () => {
  const engine = makeMockEngine({
    createIssue: () => ({ issueNodeId: 'I_51', number: 51, url: 'u51', contentType: 'Issue' }),
    addIssueToBoard: () => ({ itemId: 'IT_51' }),
    setStage: () => ({ ok: true }),
    setLabels: () => ({ ok: true }),
  });
  const ctx = { engine, config: followupCfg(), staged: false };
  await followup(9, { title: 'Escalate', body: 'context here', owner: 'human' }, ctx);

  const createCall = engine.calls.find((c) => c.op === 'createIssue');
  assert.match(createCall.args[1], /context here/);
  assert.match(createCall.args[1], /Follow-up to #9/);

  const labelCall = engine.calls.find((c) => c.op === 'setLabels');
  assert.deepEqual(labelCall.args[1], ['needs-claude']);
});

test('followup in staged mode previews by title without committing', async () => {
  const engine = makeMockEngine({
    createIssue: () => ({ staged: true, wouldRun: {} }),
    addIssueToBoard: () => ({ staged: true, wouldRun: {} }),
    setStage: () => ({ staged: true, wouldRun: {} }),
    setLabels: () => ({ staged: true, wouldRun: {} }),
  });
  const ctx = { engine, config: followupCfg(), staged: true };
  const r = await followup(9, { title: 'Write tests' }, ctx);

  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['createIssue', 'addIssueToBoard', 'setStage', 'setLabels']);
  for (const call of engine.calls) {
    assert.equal(call.args.at(-1)?.staged, true, `${call.op} passed { staged:true }`);
  }
  assert.equal(r.committed, false);
  assert.match(r.say, /Would file follow-up 'Write tests' \(Claude's queue\)/);
});
