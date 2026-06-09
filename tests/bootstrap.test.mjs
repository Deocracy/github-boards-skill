// tests/bootstrap.test.mjs — bootstrap + ledger verb tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { bootstrap, ledger } from '../scripts/board-manager.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-boot-'));
const detect = () => ({ owner: 'Deocracy', repo: 'demo', nameWithOwner: 'Deocracy/demo' });

function happyEngine() {
  return makeMockEngine({
    getOwnerId: () => ({ ownerId: 'O_1', ownerType: 'Organization' }),
    findProjectByTitle: () => null,
    findStageFieldByName: () => null,
    createProject: () => ({ projectId: 'PVT_1', projectNumber: 9, url: 'https://x/9' }),
    createStageField: () => ({ stageFieldId: 'PVTSSF_1', options: [
      { label: 'Ideas', optionId: 'o1' }, { label: 'Researching', optionId: 'o2' },
      { label: 'Building', optionId: 'o3' }, { label: 'Review', optionId: 'o4' },
      { label: 'Shipped', optionId: 'o5' }, { label: 'Rejected (learnings kept)', optionId: 'o6' },
    ] }),
    ensureLabels: () => ({ created: ['agent:go', 'needs-claude'] }),
  });
}

test('bootstrap --staged previews the plan and performs NO engine writes', async () => {
  const engine = happyEngine();
  const writes = [];
  const r = await bootstrap({
    engine, staged: true, dir: tmp(),
    detectRepo: detect, writeConfig: (c) => writes.push(c), preset: 'build', existingConfig: null,
  });
  assert.equal(r.committed, false);
  assert.equal(r.staged, true);
  assert.match(r.say, /Would bootstrap/);
  assert.equal(engine.calls.length, 0, 'staged mode must not call the engine');
  assert.equal(writes.length, 0, 'staged mode must not write config');
});

test('bootstrap commit: full create chain in order, write-as-you-go, ledger bound', async () => {
  const engine = happyEngine();
  const dir = tmp();
  const writes = [];
  const r = await bootstrap({
    engine, staged: false, dir,
    detectRepo: detect, writeConfig: (c) => writes.push({ ...c }), preset: 'build', existingConfig: null,
  });
  const ops = engine.calls.map((c) => c.op);
  assert.deepEqual(ops, ['getOwnerId', 'findProjectByTitle', 'createProject', 'findStageFieldByName', 'createStageField', 'ensureLabels']);
  assert.equal(r.committed, true);
  // persisted exactly once, with the complete binding
  assert.equal(writes.length, 1);
  const finalCfg = writes.at(-1);
  assert.equal(finalCfg.projectId, 'PVT_1');
  assert.equal(finalCfg.stageFieldId, 'PVTSSF_1');
  assert.equal(finalCfg.ownerType, 'Organization');
  assert.equal(finalCfg.pushPolicy, 'on-approval');
  assert.equal(finalCfg.stageOptions.Ideas, 'o1');
  // ledger bound
  const l = await readLedger(dir);
  assert.equal(l.intent.wantsBoard, true);
  assert.equal(l.intent.boundBoard.projectNumber, 9);
  // browser-only reminder present
  assert.match(r.say, /group by Stage/i);
});

test('bootstrap resumes from a partial board.json (project done, field missing)', async () => {
  const engine = happyEngine();
  const r = await bootstrap({
    engine, staged: false, dir: tmp(),
    detectRepo: detect, writeConfig: () => {}, preset: 'build',
    existingConfig: { projectId: 'PVT_OLD', projectNumber: 3, projectUrl: 'u', owner: 'Deocracy', repo: 'Deocracy/demo', preset: 'build', routing: { agent: 'agent:go', human: 'needs-claude' } },
  });
  const ops = engine.calls.map((c) => c.op);
  assert.ok(!ops.includes('createProject'), 'must NOT recreate an existing project');
  assert.ok(ops.includes('createStageField'), 'must still create the missing field');
  assert.equal(r.config.projectId, 'PVT_OLD');
});

test('bootstrap adopts an existing same-title project and its Stage field', async () => {
  const engine = makeMockEngine({
    getOwnerId: () => ({ ownerId: 'O_1', ownerType: 'Organization' }),
    findProjectByTitle: () => ({ projectId: 'PVT_FOUND', projectNumber: 12, url: 'u12' }),
    findStageFieldByName: () => ({ stageFieldId: 'PVTSSF_FOUND', options: [{ label: 'Ideas', optionId: 'o1' }] }),
    ensureLabels: () => ({ created: [] }),
  });
  const r = await bootstrap({
    engine, staged: false, dir: tmp(),
    detectRepo: detect, writeConfig: () => {}, preset: 'build', existingConfig: null,
  });
  const ops = engine.calls.map((c) => c.op);
  assert.ok(!ops.includes('createProject'), 'must adopt, not create project');
  assert.ok(!ops.includes('createStageField'), 'must adopt, not create field');
  assert.equal(r.config.projectId, 'PVT_FOUND');
  assert.equal(r.config.stageFieldId, 'PVTSSF_FOUND');
});

test('ledger verb: add then show', async () => {
  const dir = tmp();
  const added = await ledger('add', 'Investigate dedup', { dir, source: 'test' });
  assert.match(added.say, /Added candidate/);
  const shown = await ledger('show', null, { dir });
  assert.match(shown.say, /1 candidate/);
  assert.match(shown.say, /no board bound/);
});
