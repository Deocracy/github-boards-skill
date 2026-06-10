// tests/sources.test.mjs — pure core for M3b source adapters
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES } from '../scripts/lib/profiles.mjs';
import { contentHash, detectProfiles } from '../scripts/lib/sources.mjs';

test('PROFILES ships superpowers, gsd, generic — generic LAST (first-match-wins attribution)', () => {
  assert.deepEqual(PROFILES.map((p) => p.name), ['superpowers', 'gsd', 'generic']);
});

test('every profile is data-only with the full shape', () => {
  for (const p of PROFILES) {
    assert.equal(typeof p.name, 'string');
    assert.ok(p.detect === null || typeof p.detect === 'string');
    assert.ok(Array.isArray(p.watch) && p.watch.length > 0);
    assert.equal(typeof p.hints, 'string');
    assert.ok(p.hints.length > 20, `${p.name} hints should be real guidance`);
    assert.ok(Array.isArray(p.doneSignals) && p.doneSignals.length > 0);
  }
});

test('generic has no detect dir (always active); the skill profiles do', () => {
  const byName = Object.fromEntries(PROFILES.map((p) => [p.name, p]));
  assert.equal(byName.generic.detect, null);
  assert.equal(byName.superpowers.detect, 'docs/superpowers');
  assert.equal(byName.gsd.detect, '.planning');
});

test('contentHash: 12 hex chars, stable, content-sensitive', () => {
  const h = contentHash('hello');
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.equal(h, contentHash('hello'));
  assert.notEqual(h, contentHash('hello!'));
});

test('detectProfiles: presence-based — only profiles whose detect dir exists (+ generic)', () => {
  const active = detectProfiles(['docs/superpowers'], null);
  assert.deepEqual(active.map((p) => p.name), ['superpowers', 'generic']);
});

test('detectProfiles: no detect dirs -> generic only', () => {
  assert.deepEqual(detectProfiles([], null).map((p) => p.name), ['generic']);
});

test('detectProfiles: both skills present -> three profiles, generic still last', () => {
  const active = detectProfiles(['docs/superpowers', '.planning'], null);
  assert.deepEqual(active.map((p) => p.name), ['superpowers', 'gsd', 'generic']);
});

test('detectProfiles: config.sources.disable suppresses a detected profile', () => {
  const active = detectProfiles(['docs/superpowers', '.planning'], { sources: { disable: ['gsd'] } });
  assert.deepEqual(active.map((p) => p.name), ['superpowers', 'generic']);
});

test('detectProfiles: config.sources.watch globs are added to the GENERIC profile only', () => {
  const active = detectProfiles([], { sources: { watch: ['notes/**/*.md'] } });
  const generic = active.find((p) => p.name === 'generic');
  assert.ok(generic.watch.includes('notes/**/*.md'));
  assert.ok(generic.watch.includes('TODO.md')); // defaults kept
});

test('detectProfiles: malformed sources block tolerated (back-compat)', () => {
  assert.deepEqual(detectProfiles([], { sources: 'nope' }).map((p) => p.name), ['generic']);
  assert.deepEqual(detectProfiles([], {}).map((p) => p.name), ['generic']);
});
