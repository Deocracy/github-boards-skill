// tests/rules-backcompat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../scripts/lib/mapper.mjs';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { loadConfig } from '../scripts/lib/config.mjs';

test('a board.json with no rules block still loads and yields default rules', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-rules-'));
  const p = join(dir, 'board.json');
  await writeFile(p, JSON.stringify({
    projectId: 'PVT_x', stageFieldId: 'PVTSSF_x', stageOptions: { Ideas: 'o1' },
    preset: 'build', routing: { agent: 'agent:go', human: 'needs-claude' },
  }), 'utf8');
  const loaded = await loadConfig(p);
  assert.equal(resolveRules(loaded).maxLanes, 8); // default
});

test('a board.json WITH a rules block passes it through to resolveRules', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-rules-'));
  const p = join(dir, 'board.json');
  await writeFile(p, JSON.stringify({
    projectId: 'PVT_x', stageFieldId: 'PVTSSF_x', stageOptions: { Ideas: 'o1' },
    preset: 'build', routing: { agent: 'agent:go', human: 'needs-claude' },
    rules: { maxLanes: 5, granularity: 'coarse' },
  }), 'utf8');
  const loaded = await loadConfig(p);
  const r = resolveRules(loaded);
  assert.equal(r.maxLanes, 5);
  assert.equal(r.granularity, 'coarse');
});

test('resolveRules default includes promoteConfidenceBelow 0.8', () => {
  assert.equal(resolveRules(null).promoteConfidenceBelow, 0.8);
  assert.equal(resolveRules({ rules: { promoteConfidenceBelow: 0.5 } }).promoteConfidenceBelow, 0.5);
});
