// tests/skill-evals.test.mjs — deterministic drift gates: the CLI's --help is
// the source of truth; the prose surfaces (SKILL.md, /board, AGENTS.md) must
// cover it, keep their promises, and stay mirrored. These gates exist because
// the prose once went two milestones stale without anything failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const help = execFileSync(process.execPath, [join(ROOT, 'scripts', 'board-manager.mjs'), '--help'], { encoding: 'utf8' });
const verbTokens = [...new Set(
  help.split('\n')
    .map((l) => /^ {2}([a-z][\w-]*)\b/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]),
)];

const skill = read('skills/github-boards/SKILL.md');
const command = read('commands/board.md');
const agents = read('AGENTS.md');

/** SKILL.md body = everything after the closing frontmatter fence. */
function bodyOf(md) {
  const m = /^---\n[^]*?\n---\n/.exec(md);
  if (!m) throw new Error('no frontmatter found');
  return md.slice(m[0].length).replace(/^\s+/, '');
}

test('gates meta: the help parser finds a sane verb count', () => {
  assert.ok(verbTokens.length >= 12, `only ${verbTokens.length} verb tokens parsed from --help (${verbTokens.join(', ')}) — parser or help format drifted`);
});

test('every CLI verb is documented in SKILL.md', () => {
  const missing = verbTokens.filter((v) => !skill.includes('`' + v));
  assert.deepEqual(missing, [], `SKILL.md is missing CLI verb(s): ${missing.join(', ')}`);
});

test('every CLI verb is documented in commands/board.md', () => {
  const missing = verbTokens.filter((v) => !command.includes('`' + v));
  assert.deepEqual(missing, [], `commands/board.md is missing CLI verb(s): ${missing.join(', ')}`);
});

test('critical verb+sub pairs appear in SKILL.md', () => {
  const pairs = ['map prepare', 'map record', 'promote plan', 'promote apply', 'sync scan', 'sync record',
    'reconcile scan', 'reconcile apply', 'snapshot take', 'snapshot list', 'snapshot diff', 'snapshot log', 'snapshot invert'];
  const missing = pairs.filter((p) => !skill.includes(p));
  assert.deepEqual(missing, [], `SKILL.md is missing pair(s): ${missing.join(', ')}`);
});

test('the six hard rules survive (sentinels)', () => {
  const sentinels = ['Preview before every write', 'Report back', 'Owner ≠ author', 'stays claimed',
    'Never attempt board view configuration', 'Fail closed'];
  const missing = sentinels.filter((s) => !skill.includes(s));
  assert.deepEqual(missing, [], `hard-rule sentinel(s) missing: ${missing.join(' | ')}`);
});

test('frontmatter trigger phrases survive', () => {
  const fmMatch = /^---\n([^]*?)\n---\n/.exec(skill);
  assert.ok(fmMatch, 'SKILL.md has no frontmatter');
  const fm = fmMatch[1];
  const phrases = ['put this on the board', "what's on my plate", 'what is Claude working on',
    'promote the backlog', 'sync my TODOs onto the board', 'heal the ledger',
    'what changed this week', 'what did the board look like before', 'undo what happened since'];
  const missing = phrases.filter((p) => !fm.includes(p));
  assert.deepEqual(missing, [], `trigger phrase(s) missing from frontmatter: ${missing.join(' | ')}`);
});

test('AGENTS.md mirrors the SKILL.md body byte-identically', () => {
  const marker = '<!-- BEGIN MIRROR -->\n';
  const idx = agents.indexOf(marker);
  assert.ok(idx >= 0, 'AGENTS.md is missing the <!-- BEGIN MIRROR --> marker');
  const mirrored = agents.slice(idx + marker.length).replace(/^\s+/, '');
  assert.equal(mirrored, bodyOf(skill), 'AGENTS.md mirror has drifted from the SKILL.md body — re-copy it');
});

test('references/ links in SKILL.md resolve to real files', () => {
  const refs = [...new Set([...skill.matchAll(/references\/[\w-]+\.md/g)].map((m) => m[0]))];
  assert.ok(refs.length >= 2, `expected at least 2 references/ links, found ${refs.length}`);
  for (const r of refs) {
    assert.ok(existsSync(join(ROOT, 'skills', 'github-boards', r)), `SKILL.md links ${r} but the file does not exist`);
  }
});

test('evals/scenarios.json is valid and covers negatives', () => {
  const sc = JSON.parse(read('evals/scenarios.json'));
  assert.ok(Array.isArray(sc) && sc.length >= 15, `expected >=15 scenarios, found ${sc.length}`);
  assert.ok(sc.filter((s) => s.expectVerb === null).length >= 3, 'need >=3 negative scenarios (expectVerb: null)');
  for (const s of sc) {
    assert.ok(s.id && typeof s.say === 'string' && 'expectVerb' in s, `malformed scenario: ${JSON.stringify(s)}`);
  }
});

test('eval runner refuses without GBS_EVAL=1 (the gate is the enforcement)', () => {
  const env = { ...process.env };
  delete env.GBS_EVAL;
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'eval-skill.mjs')], { encoding: 'utf8', env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /GBS_EVAL=1/);
});
