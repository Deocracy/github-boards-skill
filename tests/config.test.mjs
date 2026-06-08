// tests/config.test.mjs — TDD: config loader unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../scripts/lib/config.mjs';

// --- fail-closed paths ---

test('fails closed without stageFieldId', async () => {
  await assert.rejects(() => loadConfig('tests/fixtures/no-stage.json'));
});

test('fails closed without projectId', async () => {
  await assert.rejects(() => loadConfig('tests/fixtures/no-projectid.json'));
});

test('fails closed without stageOptions', async () => {
  await assert.rejects(() => loadConfig('tests/fixtures/no-stage-options.json'));
});

test('fails closed with unknown preset', async () => {
  await assert.rejects(() => loadConfig('tests/fixtures/unknown-preset.json'));
});

test('fails closed on missing file', async () => {
  await assert.rejects(() => loadConfig('tests/fixtures/does-not-exist.json'));
});

// --- happy path ---

test('loadConfig returns required shape with correct values', async () => {
  const cfg = await loadConfig('tests/fixtures/valid-board.json');
  assert.equal(cfg.projectId, 'PVT_test123');
  assert.equal(cfg.stageFieldId, 'PVTSSF_test456');
  assert.ok(cfg.stageOptions && typeof cfg.stageOptions === 'object', 'stageOptions present');
  assert.ok(cfg.routing && typeof cfg.routing === 'object', 'routing present');
  assert.ok(cfg.preset && typeof cfg.preset === 'object', 'preset resolved to object');
});

test('loadConfig defaults routing when absent', async () => {
  const cfg = await loadConfig('tests/fixtures/valid-board.json');
  assert.equal(cfg.routing.agent, 'agent:go');
  assert.equal(cfg.routing.human, 'needs-claude');
});

test('loadConfig resolves preset to a full preset object', async () => {
  const cfg = await loadConfig('tests/fixtures/valid-board.json');
  assert.equal(cfg.preset.name, 'build');
  assert.ok(Array.isArray(cfg.preset.lanes));
});
