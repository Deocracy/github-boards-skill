// scripts/lib/mapper.mjs — the M2 mapper's PURE core.
//
// The mapper itself is the LLM; this module is the deterministic harness that
// (a) prepares the LLM's input packet and (b) validates + applies the LLM's
// proposals back onto the ledger, fail-closed. No network, no board.

import { createHash } from 'node:crypto';

const DEFAULT_RULES = {
  maxLanes: 8,
  useTags: false,
  defaultOwner: 'human',
  granularity: 'fine',
  escalateConfidenceBelow: 0.6,
  escalateBatchOver: 12,
};

/**
 * Merge a board.json `rules` block over the defaults. A missing/!object rules
 * value yields the defaults (back-compat with M1 configs).
 * @param {object|null} config
 * @returns {object} resolved rules
 */
export function resolveRules(config) {
  const raw = config && config.rules;
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { ...DEFAULT_RULES, ...r };
}
