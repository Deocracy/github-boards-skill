// tests/sync-verb.test.mjs — M3b sync scan/record verbs + fs helpers (temp dirs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { presentDetectDirs, expandWatch, hashWatched, syncScan } from '../scripts/board-manager.mjs';
import { detectProfiles } from '../scripts/lib/sources.mjs';
import { ensureLedger, readLedger, writeLedger } from '../scripts/lib/ledger.mjs';

const tmp = () => mkdtempSync(join(os.tmpdir(), 'gbs-sync-'));

/** Lay down a small repo: superpowers plans dir + root TODO.md. */
function seedRepo(dir) {
  mkdirSync(join(dir, 'docs', 'superpowers', 'plans'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'superpowers', 'plans', 'p1.md'), '# Plan\n### Task 1: Build the thing\n- [ ] step', 'utf8');
  writeFileSync(join(dir, 'docs', 'superpowers', 'plans', 'notes.txt'), 'not markdown', 'utf8');
  writeFileSync(join(dir, 'TODO.md'), '- [ ] fix the roof\n- [x] done thing', 'utf8');
}

test('presentDetectDirs: reports only the profile detect dirs that exist', () => {
  const dir = tmp();
  seedRepo(dir);
  assert.deepEqual(presentDetectDirs(dir), ['docs/superpowers']);
});

test('expandWatch: literal paths + <base>/**/*.<ext> globs -> sorted repo-relative POSIX paths', async () => {
  const dir = tmp();
  seedRepo(dir);
  const files = await expandWatch(dir, ['docs/superpowers/plans/**/*.md', 'TODO.md', 'MISSING.md']);
  assert.deepEqual(files, ['TODO.md', 'docs/superpowers/plans/p1.md']); // .txt + missing excluded; forward slashes
});

test('expandWatch: nested subdirectories are walked', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'docs', 'superpowers', 'plans', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'superpowers', 'plans', 'sub', 'deep.md'), 'x', 'utf8');
  const files = await expandWatch(dir, ['docs/superpowers/plans/**/*.md']);
  assert.deepEqual(files, ['docs/superpowers/plans/sub/deep.md']);
});

test('hashWatched: hashes every watched file, attributing first-match profile (specific before generic)', async () => {
  const dir = tmp();
  seedRepo(dir);
  const profiles = detectProfiles(presentDetectDirs(dir), null);
  const hashes = await hashWatched(dir, profiles);
  assert.deepEqual(Object.keys(hashes).sort(), ['TODO.md', 'docs/superpowers/plans/p1.md']);
  assert.equal(hashes['docs/superpowers/plans/p1.md'].profile, 'superpowers');
  assert.equal(hashes['TODO.md'].profile, 'generic');
  assert.match(hashes['TODO.md'].hash, /^[0-9a-f]{12}$/);
});

test('hashWatched: a file matched by two profiles is attributed once, to the earlier profile', async () => {
  const dir = tmp();
  seedRepo(dir);
  // user glob overlaps the superpowers watch set via the generic profile
  const profiles = detectProfiles(presentDetectDirs(dir), { sources: { watch: ['docs/superpowers/plans/**/*.md'] } });
  const hashes = await hashWatched(dir, profiles);
  assert.equal(hashes['docs/superpowers/plans/p1.md'].profile, 'superpowers'); // not generic
});

test('syncScan: first scan flags every watched file; manifest carries hints', async () => {
  const dir = tmp();
  seedRepo(dir);
  const { manifest, say } = await syncScan({ dir, config: null });
  assert.deepEqual(
    manifest.changedFiles.map((f) => f.path).sort(),
    ['TODO.md', 'docs/superpowers/plans/p1.md'],
  );
  assert.deepEqual(manifest.profiles.map((p) => p.name).sort(), ['generic', 'superpowers']);
  assert.match(say, /2 changed source file/);
});

test('syncScan: read-only — never creates or writes the ledger', async () => {
  const dir = tmp();
  seedRepo(dir);
  await syncScan({ dir, config: null });
  assert.equal(await readLedger(dir), null); // no ledger side effect
});

test('syncScan: files whose hash matches ledger.sources are not flagged', async () => {
  const dir = tmp();
  seedRepo(dir);
  const first = await syncScan({ dir, config: null });
  assert.equal(first.manifest.changedFiles.length, 2); // sanity: both flagged initially
  // pre-seed ledger.sources with the CURRENT hash of TODO.md
  const hashes = await hashWatched(dir, detectProfiles(presentDetectDirs(dir), null));
  const ledger = await ensureLedger(dir);
  ledger.sources = { 'TODO.md': { hash: hashes['TODO.md'].hash, syncedAt: 't', profile: 'generic' } };
  await writeLedger(dir, ledger);

  const second = await syncScan({ dir, config: null });
  assert.deepEqual(second.manifest.changedFiles.map((f) => f.path), ['docs/superpowers/plans/p1.md']);
});

test('syncScan: nothing watched exists -> empty manifest, friendly say, not an error', async () => {
  const dir = tmp(); // bare dir: no plans, no TODO.md
  const { manifest, say } = await syncScan({ dir, config: null });
  assert.deepEqual(manifest, { changedFiles: [], profiles: [] });
  assert.match(say, /unchanged|no source/i);
});

test('syncScan: config.sources.disable suppresses a profile end-to-end', async () => {
  const dir = tmp();
  seedRepo(dir);
  const { manifest } = await syncScan({ dir, config: { sources: { disable: ['superpowers'] } } });
  assert.deepEqual(manifest.changedFiles.map((f) => f.path), ['TODO.md']);
});
