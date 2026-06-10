// tests/ledger.test.mjs — unit tests for scripts/lib/ledger.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { ensureLedger, readLedger, appendCandidate, setIntent, candidateId } from '../scripts/lib/ledger.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-ledger-'));

test('readLedger returns null for a fresh temp dir (no file)', async () => {
  assert.equal(await readLedger(tmp()), null);
});

test('ensureLedger creates a default ledger and is idempotent', async () => {
  const dir = tmp();
  const l1 = await ensureLedger(dir);
  assert.equal(l1.ledgerVersion, 1);
  assert.deepEqual(l1.candidates, []);
  assert.equal(l1.intent.wantsBoard, null);
  assert.equal(l1.intent.boundBoard, null);
  assert.equal(l1.intent.pushPolicy, 'on-approval');
  assert.equal(l1.intent.pullCadence, 'session-start');
  // second call must not reset it (idempotent): mutate, re-ensure, mutation survives
  await appendCandidate(dir, { title: 'keep me' });
  const l2 = await ensureLedger(dir);
  assert.equal(l2.candidates.length, 1);
});

test('candidateId is a stable 12-char hash, case/space-insensitive', () => {
  const a = candidateId('Fix the bug');
  const b = candidateId('  fix the bug ');
  assert.equal(a, b);
  assert.equal(a.length, 12);
});

test('appendCandidate adds a candidate with defaults and persists', async () => {
  const dir = tmp();
  await appendCandidate(dir, { title: 'Submit form', source: 'superpowers:brainstorming' });
  const l = await readLedger(dir);
  assert.equal(l.candidates.length, 1);
  const c = l.candidates[0];
  assert.equal(c.title, 'Submit form');
  assert.equal(c.source, 'superpowers:brainstorming');
  assert.equal(c.status, 'candidate');
  assert.equal(c.suggestedLane, null);
  assert.equal(c.suggestedOwner, null);
  assert.ok(c.id && c.addedAt);
});

test('appendCandidate dedups by content-hash (same title appended twice -> one)', async () => {
  const dir = tmp();
  await appendCandidate(dir, { title: 'Same task' });
  await appendCandidate(dir, { title: ' same task ' });
  const l = await readLedger(dir);
  assert.equal(l.candidates.length, 1);
});

test('setIntent merges into intent and persists', async () => {
  const dir = tmp();
  await setIntent(dir, { wantsBoard: true, boundBoard: { projectNumber: 7, projectUrl: 'u' } });
  const l = await readLedger(dir);
  assert.equal(l.intent.wantsBoard, true);
  assert.deepEqual(l.intent.boundBoard, { projectNumber: 7, projectUrl: 'u' });
  assert.equal(l.intent.pushPolicy, 'on-approval'); // untouched default preserved
});

test('readLedger throws a clear error on malformed JSON', async () => {
  const dir = tmp();
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(dir, '.github-boards'), { recursive: true });
  await writeFile(join(dir, '.github-boards', 'ledger.json'), '{ bad', 'utf8');
  await assert.rejects(() => readLedger(dir), (e) => e.message.includes('malformed JSON'));
});

test('fresh ledger carries an empty sources map (M3b change-detection state)', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-ledger-src-'));
  const l = await ensureLedger(dir);
  assert.deepEqual(l.sources, {});
});
