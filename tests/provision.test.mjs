// tests/provision.test.mjs — staged-mode + helper tests for board.mjs provisioning ops
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createStageField, ensureLabels, buildGraphqlInput } from '../scripts/board.mjs';

const staged = { staged: true, json: false };

test('createProject in staged mode returns the planned mutation, writes nothing', () => {
  const r = createProject(staged, 'O_owner', 'my-repo board');
  assert.equal(r.staged, true);
  assert.equal(r.wouldRun.op, 'createProjectV2');
  assert.equal(r.wouldRun.ownerId, 'O_owner');
  assert.equal(r.wouldRun.title, 'my-repo board');
});

test('createStageField in staged mode plans the field + all lane options', () => {
  const r = createStageField(staged, 'PVT_1', ['Ideas', 'Building', 'Shipped']);
  assert.equal(r.staged, true);
  assert.equal(r.wouldRun.op, 'createProjectV2Field');
  assert.equal(r.wouldRun.name, 'Stage');
  assert.deepEqual(r.wouldRun.options, ['Ideas', 'Building', 'Shipped']);
});

test('ensureLabels in staged mode plans the labels, writes nothing', () => {
  const r = ensureLabels(staged, 'o/r', ['agent:go', 'needs-claude']);
  assert.equal(r.staged, true);
  assert.equal(r.wouldRun.op, 'gh label create');
  assert.deepEqual(r.wouldRun.labels, ['agent:go', 'needs-claude']);
});

test('buildGraphqlInput produces a {query, variables} JSON body string', () => {
  const body = buildGraphqlInput('query($l:String!){x}', { l: 'Deocracy' });
  const parsed = JSON.parse(body);
  assert.equal(parsed.query, 'query($l:String!){x}');
  assert.deepEqual(parsed.variables, { l: 'Deocracy' });
});
