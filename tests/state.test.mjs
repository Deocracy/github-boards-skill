// tests/state.test.mjs — unit tests for scripts/lib/state.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { readState, writeState, diff } from '../scripts/lib/state.mjs';

// ---------------------------------------------------------------------------
// readState / writeState
// ---------------------------------------------------------------------------

test('readState returns null for a fresh temp dir (no file)', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-state-'));
  const result = await readState(dir);
  assert.equal(result, null);
});

test('writeState then readState round-trips the snapshot', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-state-'));
  const snapshot = {
    seenAt: '2026-01-01T00:00:00.000Z',
    items: {
      1: { lane: 'Building', labels: ['agent:go'], owner: 'agent' },
      2: { lane: 'Review', labels: ['needs-claude'], owner: 'human' },
    },
  };
  const written = await writeState(dir, snapshot);
  assert.ok(written.endsWith('state.json'), `expected path ending in state.json, got: ${written}`);

  const loaded = await readState(dir);
  assert.deepEqual(loaded, snapshot);
});

test('writeState creates the .github-boards directory if it does not exist', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-state-'));
  const snapshot = { seenAt: new Date().toISOString(), items: {} };
  await writeState(dir, snapshot);
  const loaded = await readState(dir);
  assert.deepEqual(loaded, snapshot);
});

test('readState throws a clear error on malformed JSON', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-state-'));
  await mkdir(join(dir, '.github-boards'), { recursive: true });
  await writeFile(join(dir, '.github-boards', 'state.json'), '{ bad json', 'utf8');
  await assert.rejects(
    () => readState(dir),
    (e) => {
      assert.ok(e.message.includes('malformed JSON'), `unexpected message: ${e.message}`);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// diff — pure function
// ---------------------------------------------------------------------------

test('diff: with prevItems={}, everything in curr is added', () => {
  const curr = {
    1: { lane: 'Ideas', labels: [], owner: null },
    2: { lane: 'Building', labels: [], owner: 'agent' },
  };
  const result = diff({}, curr);
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.removed, []);
  assert.equal(result.added.length, 2);
  assert.ok(result.added.includes(1));
  assert.ok(result.added.includes(2));
});

test('diff: with prevItems=null, everything in curr is added', () => {
  const curr = { 5: { lane: 'Review', labels: [], owner: 'human' } };
  const result = diff(null, curr);
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.added, [5]);
});

test('diff detects a lane move (moved has {number, from, to})', () => {
  const prev = { 3: { lane: 'Building', labels: [], owner: 'agent' } };
  const curr = { 3: { lane: 'Review', labels: [], owner: 'agent' } };
  const result = diff(prev, curr);
  assert.equal(result.moved.length, 1);
  assert.deepEqual(result.moved[0], { number: 3, from: 'Building', to: 'Review' });
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
});

test('diff detects a new card (added) and a removed card (removed)', () => {
  const prev = {
    1: { lane: 'Ideas', labels: [], owner: null },
    2: { lane: 'Building', labels: [], owner: 'agent' },
  };
  const curr = {
    1: { lane: 'Ideas', labels: [], owner: null },
    3: { lane: 'Review', labels: [], owner: 'human' },
  };
  const result = diff(prev, curr);
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.added, [3]);
  assert.deepEqual(result.removed, [2]);
});

test('diff: unchanged card (same lane) is not in moved/added/removed', () => {
  const prev = { 7: { lane: 'Done', labels: [], owner: null } };
  const curr = { 7: { lane: 'Done', labels: [], owner: null } };
  const result = diff(prev, curr);
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
});
