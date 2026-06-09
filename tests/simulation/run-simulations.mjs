// tests/simulation/run-simulations.mjs — GATED mapper simulation harness.
//
// Runs each scenario fixture through the LLM mapper N times via `claude -p`,
// grading with the pure functions in score.mjs. SKIPPED unless GBS_SIM=1, so
// `npm test` and automated runs never make model calls.
//
// Usage (manual only): GBS_SIM=1 N=5 node tests/simulation/run-simulations.mjs
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { prepareInput } from '../../scripts/lib/mapper.mjs';
import { checkRuleAdherence, scoreConsistency, checkIdempotency } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.GBS_SIM === '1';
const N = Number(process.env.N || 5);

// Build the mapper prompt: contract + input packet, instruct JSON-only output.
async function mapperPrompt(packet) {
  const contract = await readFile(resolve(HERE, '../../skills/github-boards/references/mapper-contract.md'), 'utf8');
  return `${contract}\n\n## INPUT PACKET\n\`\`\`json\n${JSON.stringify(packet, null, 2)}\n\`\`\`\n\n` +
    `Output ONLY a JSON array of proposals (no prose, no code fence).`;
}

function runMapperOnce(prompt) {
  const r = spawnSync('claude', ['-p', prompt, '--output-format', 'text'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`claude -p failed: ${(r.stderr || '').trim()}`);
  const text = (r.stdout || '').trim();
  const start = text.indexOf('['); const end = text.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error(`no JSON array in mapper output: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

test('mapper simulation across scenarios', { skip: !LIVE ? 'set GBS_SIM=1 to run (makes real model calls)' : false }, async () => {
  const dir = resolve(HERE, 'scenarios');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const sc = JSON.parse(await readFile(resolve(dir, f), 'utf8'));
    const ledger = { ledgerVersion: 1, intent: {}, candidates: sc.candidates };
    const packet = prepareInput(ledger, sc.config, sc.session);
    const prompt = await mapperPrompt(packet);

    const runs = [];
    for (let i = 0; i < N; i++) runs.push(runMapperOnce(prompt));

    const adherence = runs.map((r) => checkRuleAdherence(r, sc.config));
    const adhereRate = adherence.filter((a) => a.ok).length / runs.length;
    const consistency = scoreConsistency(runs);
    const idempotent = runs.every((r) => checkIdempotency(ledger, r, sc.config));

    console.log(`[${sc.name}] adherence=${adhereRate.toFixed(2)} consistency=${consistency.toFixed(2)} idempotent=${idempotent}`);
    // Soft gates (report, don't hard-fail an exploratory sim): warn on low scores.
    if (adhereRate < 1) console.warn(`  WARN: ${(1 - adhereRate) * runs.length} run(s) violated rules`);
    if (consistency < 0.6) console.warn(`  WARN: low consistency`);
  }
});
