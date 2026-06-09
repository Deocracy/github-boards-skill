// tests/repo-detect.test.mjs — unit tests for scripts/lib/repo-detect.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRepo, RepoDetectError } from '../scripts/lib/repo-detect.mjs';

test('detectRepo parses owner/name/nameWithOwner from gh JSON', () => {
  const runner = () => JSON.stringify({
    name: 'github-boards-skill',
    nameWithOwner: 'Deocracy/github-boards-skill',
    owner: { id: 'O_1', login: 'Deocracy' },
  });
  const r = detectRepo(runner);
  assert.deepEqual(r, {
    owner: 'Deocracy',
    repo: 'github-boards-skill',
    nameWithOwner: 'Deocracy/github-boards-skill',
  });
});

test('detectRepo falls back to owner/name when nameWithOwner is absent', () => {
  const runner = () => JSON.stringify({ name: 'r', owner: { login: 'o' } });
  assert.equal(detectRepo(runner).nameWithOwner, 'o/r');
});

test('detectRepo throws RepoDetectError on missing owner/name', () => {
  const runner = () => JSON.stringify({ owner: {} });
  assert.throws(() => detectRepo(runner), (e) => e instanceof RepoDetectError && e.refusal === true);
});

test('detectRepo throws RepoDetectError on unparseable output', () => {
  const runner = () => 'not json';
  assert.throws(() => detectRepo(runner), (e) => e instanceof RepoDetectError);
});
