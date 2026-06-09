// tests/hooks.ledger.test.mjs — SessionStart decide() ledger behavior
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../hooks/SessionStart/load-board.mjs';

const baseDeps = {
  hasBoard: () => false,
  runSummary: async () => null,
  ensureLedger: async () => ({ candidates: [] }),
  readLedger: async () => ({ candidates: [] }),
};

test('decide always calls ensureLedger with the cwd', async () => {
  let calledWith = null;
  await decide({ cwd: '/work' }, { ...baseDeps, ensureLedger: async (d) => { calledWith = d; return { candidates: [] }; } });
  assert.equal(calledWith, '/work');
});

test('decide returns null when no board and zero candidates (anti-spam)', async () => {
  const r = await decide({ cwd: '/work' }, baseDeps);
  assert.equal(r, null);
});

test('decide injects a ledger note when there are candidates but no board', async () => {
  const r = await decide({ cwd: '/work' }, { ...baseDeps, ensureLedger: async () => ({ candidates: [1, 2] }) });
  assert.ok(r && /2 candidate/.test(r.additionalContext));
});

test('decide injects board status when a board summary is available', async () => {
  const r = await decide({ cwd: '/work' }, { ...baseDeps, hasBoard: () => true, runSummary: async () => 'Since last time: 1 moved' });
  assert.ok(r && /Since last time: 1 moved/.test(r.additionalContext));
});

test('decide never throws if ensureLedger throws (degrades silently)', async () => {
  const r = await decide({ cwd: '/work' }, { ...baseDeps, ensureLedger: async () => { throw new Error('fs'); } });
  assert.equal(r, null);
});
