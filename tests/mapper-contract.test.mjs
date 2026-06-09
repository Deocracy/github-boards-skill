// tests/mapper-contract.test.mjs — structural smoke for the contract + SKILL wiring
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('mapper-contract.md exists and documents the proposal schema + escalation triggers', async () => {
  const md = await readFile(resolve(root, 'skills/github-boards/references/mapper-contract.md'), 'utf8');
  for (const token of ['candidateId', 'kind', 'needsDecision', 'mergeWith', 'split', 'escalat', 'confidence']) {
    assert.ok(md.includes(token), `contract must mention "${token}"`);
  }
});

test('SKILL.md references the mapper contract and the map verb', async () => {
  const md = await readFile(resolve(root, 'skills/github-boards/SKILL.md'), 'utf8');
  assert.ok(md.includes('mapper-contract.md'), 'SKILL.md must point to the contract');
  assert.ok(/\bmap\b/.test(md), 'SKILL.md must mention the map verb');
});
