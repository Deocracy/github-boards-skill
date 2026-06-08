import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reshape } from '../scripts/board-manager.mjs';
import { makeMockEngine } from './helpers/mock-engine.mjs';

test('reshape reports missing lanes + checklist against the build preset', async () => {
  // board only has 2 of the build preset's lanes
  const engine = makeMockEngine({
    getStageField: () => ({ fieldId:'F', fieldName:'Stage', options:[
      { label:'Ideas', optionId:'o1' }, { label:'Building', optionId:'o2' },
    ]}),
  });
  const ctx = { engine, config: {}, staged: false };
  const r = await reshape('build', ctx);
  assert.equal(r.applied, false);
  assert.ok(r.diff.missing.includes('Researching'));
  assert.ok(r.diff.missing.includes('Shipped'));
  assert.ok(r.checklist.some(line => /group by/i.test(line)));   // the UI-only step
  assert.match(r.say, /build/);
  // read-only: only getStageField was called
  assert.deepEqual(engine.calls.map(c => c.op), ['getStageField']);
});

test('reshape says it matches when board has exactly the preset lanes', async () => {
  const buildLanes = ['Ideas','Researching','Building','Review','Shipped','Rejected (learnings kept)'];
  const engine = makeMockEngine({
    getStageField: () => ({ fieldId:'F', fieldName:'Stage',
      options: buildLanes.map((label,i)=>({label, optionId:'o'+i})) }),
  });
  const r = await reshape('build', { engine, config:{}, staged:false });
  assert.equal(r.diff.missing.length, 0);
  assert.match(r.say, /already matches/);
});
