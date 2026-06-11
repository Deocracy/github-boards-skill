// tests/reconcile-verb.test.mjs — M4a reconcile verbs against the mock engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { makeMockEngine } from './helpers/mock-engine.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-reconcile-'));

test('mock engine records listItemsWithBodies like every other op', async () => {
  const engine = makeMockEngine({ listItemsWithBodies: () => ({ items: [], count: 0 }) });
  const r = await engine.listItemsWithBodies();
  assert.deepEqual(r, { items: [], count: 0 });
  assert.deepEqual(engine.calls.map((c) => c.op), ['listItemsWithBodies']);
});

test('WIRING: board.mjs listItems supports withBodies (body+url in the Issue fragment, conditional)', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'board.mjs'), 'utf8');
  assert.ok(src.includes('withBodies'), 'listItems has no withBodies option');
  assert.match(src, /body url/, 'Issue fragment never gains body url');
});

test('WIRING: makeRealEngine exposes listItemsWithBodies and the DI contract documents it', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'board-manager.mjs'), 'utf8');
  assert.match(src, /listItemsWithBodies:\s*\(\)\s*=>\s*eng\.listItems\(cfg,\s*\{\s*withBodies:\s*true\s*\}\)/);
  assert.match(src, /engine\.listItemsWithBodies\(\)/, 'DI contract header missing the new op');
});
