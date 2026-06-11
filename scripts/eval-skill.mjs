#!/usr/bin/env node
// scripts/eval-skill.mjs — GATED LLM scenario evals for the github-boards skill.
// Grades verb selection: would a model reading SKILL.md pick the right verb for
// each evals/scenarios.json fixture? ADVISORY — tune the prose, not the fixtures.
//
// SAFETY: refuses without GBS_EVAL=1 (operator-only; each scenario is a real
// model call). NEVER wire this into npm test, CI, or any automated loop.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.GBS_EVAL !== '1') {
  console.error('eval-skill: refusing to run — set GBS_EVAL=1 (operator-only; this makes real model calls).');
  process.exit(1);
}

const MODEL = process.env.GBS_EVAL_MODEL || 'haiku';
let scenarios;
try {
  scenarios = JSON.parse(readFileSync(join(ROOT, 'evals', 'scenarios.json'), 'utf8'));
} catch (e) {
  console.error(`eval-skill: cannot read evals/scenarios.json (${e.message})`);
  process.exit(1);
}
const skill = readFileSync(join(ROOT, 'skills', 'github-boards', 'SKILL.md'), 'utf8');

const results = [];
for (const s of scenarios) {
  const prompt = [
    'You are an AI coding assistant. The following skill is installed:',
    '--- SKILL ---',
    skill,
    '--- END SKILL ---',
    `The user says: ${JSON.stringify(s.say)}`,
    'If this message should trigger one of the skill\'s board verbs, name the verb.',
    'Answer with ONLY compact JSON, nothing else:',
    '{"verb": "<first word of the verb: queue|put|move|reject|route|followup|reshape|summary|bootstrap|ledger|map|promote|sync|reconcile|snapshot>", "args": "<sub-verb/args or empty>"}',
    'or {"verb": null} if no board verb applies.',
  ].join('\n');

  const r = spawnSync('claude', ['-p', '--output-format', 'text', '--model', MODEL], {
    input: prompt,
    encoding: 'utf8',
    shell: process.platform === 'win32', // .cmd shim
    timeout: 120000,
  });
  if (r.error || r.status === null) {
    console.error(`eval-skill: failed to run the claude CLI (${r.error ? r.error.message : 'timeout'}) — is it installed and on PATH?`);
    process.exit(1);
  }
  let got = '(unparseable)';
  let args = '';
  try {
    const m = (r.stdout || '').match(/\{[^]*?\}/);
    const parsed = JSON.parse(m ? m[0] : '{}');
    got = 'verb' in parsed ? parsed.verb : '(unparseable)';
    args = typeof parsed.args === 'string' ? parsed.args : '';
  } catch { /* counted as a failure below */ }
  let pass = got === s.expectVerb;
  if (pass && s.expectArgs) pass = args.includes(s.expectArgs);
  results.push({ id: s.id, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${s.id}  expected=${JSON.stringify(s.expectVerb)}${s.expectArgs ? `+${s.expectArgs}` : ''}  got=${JSON.stringify(got)}${args ? ` args=${JSON.stringify(args)}` : ''}`);
}

const passed = results.filter((x) => x.pass).length;
console.log(`\nScorecard: ${passed}/${results.length} — advisory; tune SKILL.md prose, not the scenarios.`);
