// tests/config-writer.test.mjs — unit tests for scripts/lib/config-writer.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { writeBoardConfig } from '../scripts/lib/config-writer.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';

const fullCfg = () => ({
  owner: 'Deocracy',
  ownerType: 'Organization',
  projectNumber: 7,
  projectId: 'PVT_x',
  repo: 'Deocracy/github-boards-skill',
  stageFieldId: 'PVTSSF_x',
  stageOptions: { Ideas: 'o1', Shipped: 'o2' },
  preset: 'build',
  routing: { agent: 'agent:go', human: 'needs-claude' },
  projectUrl: 'https://github.com/orgs/Deocracy/projects/7',
  pushPolicy: 'on-approval',
  pullCadence: 'session-start',
});

test('writeBoardConfig writes a board.json that loadConfig round-trips', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-cfgw-'));
  const path = join(dir, 'board.json');
  await writeBoardConfig(path, fullCfg());
  const loaded = await loadConfig(path);
  assert.equal(loaded.projectId, 'PVT_x');
  assert.equal(loaded.stageFieldId, 'PVTSSF_x');
  assert.deepEqual(loaded.stageOptions, { Ideas: 'o1', Shipped: 'o2' });
  assert.equal(loaded.preset.name, 'build'); // loadConfig resolves the preset object
});

test('writeBoardConfig refuses a config missing required keys', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-cfgw-'));
  const path = join(dir, 'board.json');
  const bad = fullCfg();
  delete bad.projectId;
  await assert.rejects(() => writeBoardConfig(path, bad), (e) => /projectId/.test(e.message));
});
