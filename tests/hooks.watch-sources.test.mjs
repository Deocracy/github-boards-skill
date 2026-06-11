// tests/hooks.watch-sources.test.mjs — M3c PostToolUse decide() behavior
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../hooks/PostToolUse/watch-sources.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const PROFILES_FIXTURE = [
  { name: 'superpowers', watch: ['docs/superpowers/plans/**/*.md'] },
  { name: 'generic', watch: ['TODO.md'] },
];

function deps(overrides = {}) {
  return {
    getProfiles: async () => PROFILES_FIXTURE,
    readAnnounced: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    writeAnnounced: async () => {},
    ...overrides,
  };
}

const input = (file_path, session_id = 's1', cwd = '/work') => ({
  session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Write',
  tool_input: { file_path },
});

test('watched file, first time this session -> factual note naming the file + sync verbs', async () => {
  const r = await decide(input('/work/TODO.md'), deps());
  assert.ok(r, 'expected a note');
  assert.match(r.additionalContext, /TODO\.md/);
  assert.match(r.additionalContext, /sync scan/);
  assert.match(r.additionalContext, /sync record/);
});

test('same file, same session, already announced -> silent', async () => {
  const r = await decide(input('/work/TODO.md'), deps({
    readAnnounced: async () => ({ sessionId: 's1', files: ['TODO.md'] }),
  }));
  assert.equal(r, null);
});

test('same file, NEW session id -> announces again', async () => {
  const r = await decide(input('/work/TODO.md', 's2'), deps({
    readAnnounced: async () => ({ sessionId: 's1', files: ['TODO.md'] }),
  }));
  assert.ok(r && /TODO\.md/.test(r.additionalContext));
});

test('writeAnnounced is called with the updated file list', async () => {
  let written = null;
  await decide(input('/work/docs/superpowers/plans/p.md'), deps({
    readAnnounced: async () => ({ sessionId: 's1', files: ['TODO.md'] }),
    writeAnnounced: async (cwd, data) => { written = data; },
  }));
  assert.deepEqual(written, { sessionId: 's1', files: ['TODO.md', 'docs/superpowers/plans/p.md'] });
});

test('unwatched path -> silent', async () => {
  assert.equal(await decide(input('/work/src/index.js'), deps()), null);
});

test('path outside the repo -> silent', async () => {
  assert.equal(await decide(input('/elsewhere/TODO.md'), deps()), null);
});

test('missing tool_input / missing path field -> silent', async () => {
  assert.equal(await decide({ session_id: 's1', cwd: '/work' }, deps()), null);
  assert.equal(await decide({ session_id: 's1', cwd: '/work', tool_input: {} }, deps()), null);
  assert.equal(await decide({ session_id: 's1', cwd: '/work', tool_input: { file_path: 42 } }, deps()), null);
});

test('NotebookEdit notebook_path is honored', async () => {
  const r = await decide({
    session_id: 's1', cwd: '/work', tool_name: 'NotebookEdit',
    tool_input: { notebook_path: '/work/TODO.md' },
  }, deps());
  assert.ok(r && /TODO\.md/.test(r.additionalContext));
});

test('getProfiles throwing -> silent (degrade)', async () => {
  assert.equal(await decide(input('/work/TODO.md'), deps({ getProfiles: async () => { throw new Error('fs'); } })), null);
});

test('readAnnounced returning garbage -> still announces (treated as fresh)', async () => {
  const r = await decide(input('/work/TODO.md'), deps({ readAnnounced: async () => 'garbage' }));
  assert.ok(r && /TODO\.md/.test(r.additionalContext));
});

test('writeAnnounced throwing -> note still returned (duplicate later beats noise now)', async () => {
  const r = await decide(input('/work/TODO.md'), deps({ writeAnnounced: async () => { throw new Error('fs'); } }));
  assert.ok(r && /TODO\.md/.test(r.additionalContext));
});

test('note reads as a factual statement, not an imperative system command', async () => {
  const r = await decide(input('/work/TODO.md'), deps());
  assert.match(r.additionalContext, /^github-boards: watched source file changed/);
});

test('repo-root file whose NAME starts with ".." is not misclassified as outside the repo', async () => {
  const r = await decide({
    session_id: 's1', cwd: '/work', tool_name: 'Write',
    tool_input: { file_path: '/work/..weird.md' },
  }, deps({ getProfiles: async () => [{ name: 'generic', watch: ['..weird.md'] }] }));
  assert.ok(r && /\.\.weird\.md/.test(r.additionalContext));
});

test('hooks.json registers the PostToolUse watch-sources hook with the right matcher', () => {
  const cfg = JSON.parse(readFileSync(join(repoRoot, 'hooks', 'hooks.json'), 'utf8'));
  const entries = cfg.hooks.PostToolUse;
  assert.ok(Array.isArray(entries), 'PostToolUse entries missing');
  const entry = entries.find((e) => (e.hooks || []).some((h) => (h.args || []).join(' ').includes('watch-sources.mjs')));
  assert.ok(entry, 'watch-sources.mjs not registered');
  assert.equal(entry.matcher, 'Write|Edit|MultiEdit|NotebookEdit');
});

test('DRIFT GUARD: the note suggests verbs that actually exist in the CLI help', async () => {
  const r = await decide(input('/work/TODO.md'), deps());
  const help = readFileSync(join(repoRoot, 'scripts', 'board-manager.mjs'), 'utf8');
  for (const verb of ['sync scan', 'sync record']) {
    assert.match(r.additionalContext, new RegExp(verb));
    assert.ok(help.includes(verb), `CLI help no longer documents '${verb}' — the hook note is orphaned`);
  }
});
