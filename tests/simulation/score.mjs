// tests/simulation/score.mjs — PURE scoring for the mapper simulation harness.
import { validateProposal, applyProposals, resolveRules } from '../../scripts/lib/mapper.mjs';

/** Every proposal must pass fail-closed validation against the config. */
export function checkRuleAdherence(proposals, config) {
  const rules = resolveRules(config);
  const violations = [];
  for (const p of proposals) {
    const v = validateProposal(p, config, rules);
    if (!v.ok) violations.push({ candidateId: p && p.candidateId, errors: v.errors });
  }
  return { ok: violations.length === 0, violations };
}

/** Fraction of candidates whose lane (or kind) is identical across all runs (1.0 = perfectly stable). */
export function scoreConsistency(runs) {
  if (!runs.length) return 1;
  const ids = new Set(runs.flat().map((p) => p.candidateId));
  if (!ids.size) return 1;
  let agree = 0;
  for (const id of ids) {
    const keys = runs.map((run) => {
      const p = run.find((x) => x.candidateId === id);
      return p ? `${p.kind}:${p.lane ?? ''}` : 'absent';
    });
    if (keys.every((k) => k === keys[0])) agree++;
  }
  return agree / ids.size;
}

/** Applying the same proposals twice yields the same candidate statuses (no churn/dupes). */
export function checkIdempotency(ledger, proposals, config) {
  const once = applyProposals(ledger, proposals, config).ledger;
  // re-running against the already-enriched ledger must change nothing (settled -> rejected)
  const twice = applyProposals(once, proposals, config).ledger;
  return JSON.stringify(statusMap(once)) === JSON.stringify(statusMap(twice));
}

function statusMap(ledger) {
  const m = {};
  for (const c of ledger.candidates) m[c.id] = c.status;
  return m;
}
