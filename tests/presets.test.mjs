// tests/presets.test.mjs — TDD: preset loader unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPreset, laneNames } from '../scripts/lib/presets.mjs';

test('loads a bundled preset and lists lane names in order', async () => {
  const p = await loadPreset('build');
  assert.equal(p.name, 'build');
  assert.deepEqual(laneNames(p).slice(0, 2), ['Ideas', 'Researching']);
});

test('unknown preset fails closed', async () => {
  await assert.rejects(() => loadPreset('nope'));
});

test('laneNames returns all lane names in order', async () => {
  const p = await loadPreset('build');
  assert.deepEqual(laneNames(p), ['Ideas', 'Researching', 'Building', 'Review', 'Shipped', 'Rejected (learnings kept)']);
});

test('grants preset loads with correct name and kind', async () => {
  const p = await loadPreset('grants');
  assert.equal(p.name, 'grants');
  assert.equal(p.kind, 'non-software');
  assert.ok(laneNames(p).includes('Intake'));
});
