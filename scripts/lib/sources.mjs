// scripts/lib/sources.mjs — M3b source-adapter PURE core.
//
// The LLM is the parser; this module is the deterministic harness around it.
// No fs, no network — callers (board-manager.mjs) pass data in:
//   contentHash(text)                       — sha256/12 (same style as candidateId)
//   detectProfiles(presentDirs, config)     — presence-based profile activation
//   diffSources(currentHashes, ledgerSources) — which watched files changed
//   buildManifest(changed, profiles)        — the packet Claude extracts from
//   validateExtraction(items)               — fail-closed gate on what Claude wrote

import { createHash } from 'node:crypto';
import { PROFILES } from './profiles.mjs';

/**
 * 12-hex-char content hash (mirrors ledger.candidateId's shape).
 * @param {string} text
 * @returns {string}
 */
export function contentHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

/**
 * Activate profiles by presence + config. Order preserved (generic last).
 * config.sources = { watch?: string[] (extra globs, generic only), disable?: string[] }.
 * Malformed/absent sources block -> presence defaults (back-compat).
 * @param {string[]} presentDirs  repo-relative dirs that exist (caller checks fs)
 * @param {object|null} config    raw board.json (or null — no board yet)
 * @returns {object[]} active profiles (copies; generic.watch may be extended)
 */
export function detectProfiles(presentDirs, config) {
  const src = config && config.sources && typeof config.sources === 'object' && !Array.isArray(config.sources)
    ? config.sources : {};
  const disabled = new Set(Array.isArray(src.disable) ? src.disable : []);
  const extra = Array.isArray(src.watch) ? src.watch : [];
  const present = new Set(presentDirs || []);

  const active = [];
  for (const p of PROFILES) {
    if (disabled.has(p.name)) continue;
    if (p.detect !== null && !present.has(p.detect)) continue;
    const watch = p.name === 'generic' ? [...p.watch, ...extra] : [...p.watch];
    active.push({ ...p, watch });
  }
  return active;
}
