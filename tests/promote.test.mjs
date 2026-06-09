// tests/promote.test.mjs — pure unit tests for lib/promote.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cidMarker, parseCid } from '../scripts/lib/promote.mjs';

test('cidMarker/parseCid round-trip', () => {
  const cid = 'a1b2c3d4e5f6';
  const marker = cidMarker(cid);
  assert.equal(marker, `<!-- gboards:cid=${cid} -->`);
  assert.equal(parseCid(`Some body text\n\n${marker}`), cid);
});

test('parseCid returns null when no marker present', () => {
  assert.equal(parseCid('plain body, no marker'), null);
  assert.equal(parseCid(''), null);
  assert.equal(parseCid('<!-- unrelated comment -->'), null);
});
