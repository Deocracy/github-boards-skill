// scripts/lib/promote.mjs — M3a promotion PURE core.
//
// Classifies mapped/needs-decision ledger candidates into promotion buckets,
// resolves pre-gathered human decisions, and stamps/parses the durable
// candidateId body marker. No network, no board, no ledger I/O — board-manager's
// `promote` verb owns those side effects.

import { resolveRules } from './mapper.mjs';

// candidateId (and splitChildId) are always 12 lowercase-hex chars.
const MARKER_RE = /<!--\s*gboards:cid=([0-9a-f]{12})\s*-->/;

/**
 * The durable external-id marker stamped into a promoted issue's body.
 * @param {string} cid  a 12-hex candidateId
 * @returns {string}
 */
export function cidMarker(cid) {
  return `<!-- gboards:cid=${cid} -->`;
}

/**
 * Extract the candidateId from an issue body, or null if absent.
 * @param {string} body
 * @returns {string|null}
 */
export function parseCid(body) {
  const m = MARKER_RE.exec(String(body || ''));
  return m ? m[1] : null;
}
