// tests/hooks.sources.test.mjs — SessionStart decide() M3b source-note behavior
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../hooks/SessionStart/load-board.mjs';

const baseDeps = {
  hasBoard: () => false,
  runSummary: async () => null,
  ensureLedger: async () => ({ candidates: [] }),
  readLedger: async () => ({ candidates: [] }),
  scanSources: async () => 0,
};

test('decide injects a sources note when watched files changed', async () => {
  const r = await decide({ cwd: '/work' }, { ...baseDeps, scanSources: async () => 3 });
  assert.ok(r && /3 source file\(s\) changed since last sync/.test(r.additionalContext));
});

test('decide stays silent when nothing changed and nothing else to say (anti-spam)', async () => {
  const r = await decide({ cwd: '/work' }, baseDeps);
  assert.equal(r, null);
});

test('decide combines sources note with the existing ledger note', async () => {
  const r = await decide({ cwd: '/work' }, {
    ...baseDeps,
    ensureLedger: async () => ({ candidates: [1, 2] }),
    scanSources: async () => 1,
  });
  assert.ok(/2 candidate/.test(r.additionalContext));
  assert.ok(/1 source file/.test(r.additionalContext));
});

test('decide degrades silently when scanSources throws', async () => {
  const r = await decide({ cwd: '/work' }, { ...baseDeps, scanSources: async () => { throw new Error('fs'); } });
  assert.equal(r, null);
});

test('scanSources receives the cwd', async () => {
  let calledWith = null;
  await decide({ cwd: '/work' }, { ...baseDeps, scanSources: async (d) => { calledWith = d; return 0; } });
  assert.equal(calledWith, '/work');
});
