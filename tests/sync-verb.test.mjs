// tests/sync-verb.test.mjs — M3b sync scan/record verbs + fs helpers (temp dirs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { presentDetectDirs, expandWatch, hashWatched, syncScan, syncRecord } from '../scripts/board-manager.mjs';
import { detectProfiles } from '../scripts/lib/sources.mjs';
import { ensureLedger, readLedger, writeLedger, appendCandidate } from '../scripts/lib/ledger.mjs';

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

const EXTRACT = [
  { title: 'Build the thing', note: 'from p1.md Task 1', source: 'docs/superpowers/plans/p1.md#task-1' },
  { title: 'fix the roof', source: 'TODO.md' },
];

test('syncRecord: appends candidates with provenance, then updates ledger.sources hashes', async () => {
  const dir = tmp();
  seedRepo(dir);
  const { report, say } = await syncRecord({ dir, config: null, extracted: EXTRACT });
  assert.equal(report.added.length, 2);
  assert.equal(report.deduped.length, 0);

  const ledger = await readLedger(dir);
  assert.equal(ledger.candidates.length, 2);
  const cand = ledger.candidates.find((c) => c.title === 'Build the thing');
  assert.equal(cand.status, 'candidate');
  assert.equal(cand.source, 'docs/superpowers/plans/p1.md#task-1');
  assert.equal(cand.note, 'from p1.md Task 1');

  // sources hashes were written for ALL watched files (scan -> record settles the set)
  assert.ok(ledger.sources['TODO.md'].hash.match(/^[0-9a-f]{12}$/));
  assert.ok(ledger.sources['docs/superpowers/plans/p1.md']);
  assert.equal(ledger.sources['TODO.md'].profile, 'generic');
  assert.match(say, /added 2 candidate/i);
});

test('syncRecord: full-loop idempotency — record then scan = empty; re-record dedupes all', async () => {
  const dir = tmp();
  seedRepo(dir);
  await syncRecord({ dir, config: null, extracted: EXTRACT });

  const rescan = await syncScan({ dir, config: null });
  assert.equal(rescan.manifest.changedFiles.length, 0); // layer 2

  const again = await syncRecord({ dir, config: null, extracted: EXTRACT });
  assert.equal(again.report.added.length, 0);            // layer 1
  assert.equal(again.report.deduped.length, 2);
  assert.equal((await readLedger(dir)).candidates.length, 2);
});

test('syncRecord: done items skipped (reported), never appended', async () => {
  const dir = tmp();
  seedRepo(dir);
  const { report } = await syncRecord({ dir, config: null, extracted: [
    { title: 'done thing', source: 'TODO.md', done: true },
    { title: 'live thing', source: 'TODO.md' },
  ] });
  assert.deepEqual(report.skippedDone, [{ title: 'done thing', source: 'TODO.md' }]);
  assert.equal(report.added.length, 1);
  const titles = (await readLedger(dir)).candidates.map((c) => c.title);
  assert.deepEqual(titles, ['live thing']);
});

test('syncRecord: fail-closed — one invalid item refuses the WHOLE run, ledger untouched', async () => {
  const dir = tmp();
  seedRepo(dir);
  await assert.rejects(
    () => syncRecord({ dir, config: null, extracted: [
      { title: 'good item', source: 'TODO.md' },
      { title: '', source: 'TODO.md' },          // invalid
    ] }),
    /refused/,
  );
  assert.equal(await readLedger(dir), null); // zero appends, no ledger created
});

test('syncRecord: non-array extraction refused the same way', async () => {
  const dir = tmp();
  await assert.rejects(() => syncRecord({ dir, config: null, extracted: { not: 'array' } }), /refused/);
});

test('syncRecord: crash window — appended but hashes not updated -> rescan re-flags, re-record dedupes clean', async () => {
  const dir = tmp();
  seedRepo(dir);
  await syncRecord({ dir, config: null, extracted: EXTRACT });

  // simulate the crash: wipe the hash bookkeeping, keep the candidates
  const ledger = await readLedger(dir);
  ledger.sources = {};
  await writeLedger(dir, ledger);

  const rescan = await syncScan({ dir, config: null });
  assert.equal(rescan.manifest.changedFiles.length, 2);  // re-flagged

  const redo = await syncRecord({ dir, config: null, extracted: EXTRACT });
  assert.equal(redo.report.added.length, 0);
  assert.equal(redo.report.deduped.length, 2);            // no duplicate candidates
  assert.equal((await readLedger(dir)).candidates.length, 2);
});

test('syncRecord: dedup against candidates added via `ledger add` too (same content hash)', async () => {
  const dir = tmp();
  seedRepo(dir);
  await ensureLedger(dir);
  await appendCandidate(dir, { title: 'fix the roof', source: 'manual' });
  const { report } = await syncRecord({ dir, config: null, extracted: [{ title: 'fix the roof', source: 'TODO.md' }] });
  assert.equal(report.added.length, 0);
  assert.equal(report.deduped.length, 1);
});

test('syncScan: unsupported user glob is surfaced as ignored, never crashes', async () => {
  const dir = tmp();
  seedRepo(dir);
  const { manifest, say } = await syncScan({ dir, config: { sources: { watch: ['docs/*.md', 42] } } });
  assert.equal(manifest.ignoredPatterns.length, 2);
  assert.deepEqual(manifest.ignoredPatterns.map((i) => i.pattern), ['docs/*.md', '42']);
  assert.match(say, /2 unsupported watch pattern\(s\) ignored/);
});

test('syncScan: no ignored patterns -> manifest shape unchanged (no ignoredPatterns key)', async () => {
  const dir = tmp();
  seedRepo(dir);
  const { manifest } = await syncScan({ dir, config: null });
  assert.equal(manifest.ignoredPatterns, undefined);
});

test('syncRecord: changed file NOT covered by the extraction stays flagged (fail-closed) and is reported', async () => {
  const dir = tmp();
  seedRepo(dir); // TODO.md + docs/superpowers/plans/p1.md both change-flagged
  const { report, say } = await syncRecord({ dir, config: null, extracted: [
    { title: 'fix the roof', source: 'TODO.md' }, // covers TODO.md only
  ] });
  assert.deepEqual(report.uncovered, ['docs/superpowers/plans/p1.md']);
  assert.match(say, /1 changed file\(s\) not covered/);
  const rescan = await syncScan({ dir, config: null });
  assert.deepEqual(rescan.manifest.changedFiles.map((f) => f.path), ['docs/superpowers/plans/p1.md']);
});

test('syncRecord: a done-only extraction still covers (settles) its file', async () => {
  const dir = tmp();
  seedRepo(dir);
  const { report } = await syncRecord({ dir, config: null, extracted: [
    { title: 'fix the roof', source: 'TODO.md' },
    { title: 'finished plan task', source: 'docs/superpowers/plans/p1.md#task-1', done: true },
  ] });
  assert.deepEqual(report.uncovered, []);
  const rescan = await syncScan({ dir, config: null });
  assert.equal(rescan.manifest.changedFiles.length, 0);
});
