// tests/config-backcompat.test.mjs — new optional fields don't break the loaders
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { loadConfig as loadVerbConfig } from '../scripts/lib/config.mjs';
import { loadConfig as loadEngineConfig } from '../scripts/board.mjs';

const cfg = {
  owner: 'Deocracy', ownerType: 'Organization', projectNumber: 7, projectId: 'PVT_x',
  repo: 'Deocracy/demo', stageFieldId: 'PVTSSF_x', stageOptions: { Ideas: 'o1' },
  preset: 'build', routing: { agent: 'agent:go', human: 'needs-claude' },
  projectUrl: 'https://x/7', pushPolicy: 'on-approval', pullCadence: 'session-start',
};

test('verb loadConfig tolerates the new optional fields and passes them through', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-bc-'));
  const p = join(dir, 'board.json');
  await writeFile(p, JSON.stringify(cfg), 'utf8');
  const loaded = await loadVerbConfig(p);
  assert.equal(loaded.pushPolicy, 'on-approval');
  assert.equal(loaded.preset.name, 'build');
});

test('engine loadConfig tolerates the new optional fields', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-bc-'));
  const p = join(dir, 'board.json');
  await writeFile(p, JSON.stringify(cfg), 'utf8');
  const loaded = loadEngineConfig(p);
  assert.equal(loaded.projectUrl, 'https://x/7');
  assert.equal(loaded.pullCadence, 'session-start');
});
