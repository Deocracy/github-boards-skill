// tests/doctor-preset.test.mjs — TDD: preset-coverage check unit tests.
// Tests checkPresetCoverage (pure) and verifies runDoctor wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPresetCoverage, loadPreset } from '../scripts/lib/presets.mjs';

// --- pure coverage check ---

test('checkPresetCoverage: ok=true when all preset lanes are covered', () => {
  const preset = {
    name: 'build',
    lanes: [
      { name: 'Ideas' },
      { name: 'Building' },
    ],
  };
  const stageOptions = { Ideas: 'opt1', Building: 'opt2' };
  const result = checkPresetCoverage(preset, stageOptions);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('checkPresetCoverage: FAIL when a preset lane has no matching stageOptions entry', () => {
  const preset = {
    name: 'build',
    lanes: [
      { name: 'Ideas' },
      { name: 'Researching' },
      { name: 'Building' },
    ],
  };
  const stageOptions = { Ideas: 'opt1', Building: 'opt2' };  // Researching missing
  const result = checkPresetCoverage(preset, stageOptions);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['Researching']);
});

test('checkPresetCoverage: reports all missing lanes', () => {
  const preset = {
    name: 'build',
    lanes: [{ name: 'Ideas' }, { name: 'Shipped' }, { name: 'Review' }],
  };
  const stageOptions = { Ideas: 'opt1' };
  const result = checkPresetCoverage(preset, stageOptions);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.sort(), ['Review', 'Shipped'].sort());
});

test('checkPresetCoverage: empty stageOptions = all missing', () => {
  const preset = {
    name: 'build',
    lanes: [{ name: 'Ideas' }, { name: 'Building' }],
  };
  const result = checkPresetCoverage(preset, {});
  assert.equal(result.ok, false);
  assert.equal(result.missing.length, 2);
});

test('checkPresetCoverage: preset with no lanes = ok', () => {
  const preset = { name: 'empty', lanes: [] };
  const result = checkPresetCoverage(preset, { Ideas: 'opt1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

// --- integration: full build preset against a complete stageOptions map ---

test('checkPresetCoverage: full build preset covered by complete stageOptions', async () => {
  const preset = await loadPreset('build');
  const stageOptions = {
    'Ideas': 'opt1',
    'Researching': 'opt2',
    'Building': 'opt3',
    'Review': 'opt4',
    'Shipped': 'opt5',
    'Rejected (learnings kept)': 'opt6',
  };
  const result = checkPresetCoverage(preset, stageOptions);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('checkPresetCoverage: full build preset missing one lane reports it', async () => {
  const preset = await loadPreset('build');
  const stageOptions = {
    'Ideas': 'opt1',
    'Researching': 'opt2',
    'Building': 'opt3',
    'Review': 'opt4',
    // Shipped and Rejected missing
  };
  const result = checkPresetCoverage(preset, stageOptions);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('Shipped'));
  assert.ok(result.missing.includes('Rejected (learnings kept)'));
});
