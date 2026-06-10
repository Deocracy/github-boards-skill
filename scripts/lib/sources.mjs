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

/**
 * Which watched files changed since the last sync?
 * A file in ledgerSources but NOT in currentHashes (deleted upstream) is left
 * alone — neither bucket; reconciling deletions is M4's job.
 * @param {Record<string,{hash:string,profile:string}>} currentHashes
 * @param {Record<string,{hash:string}>|null} ledgerSources
 * @returns {{changed:{path:string,profile:string,hash:string}[], unchanged:string[]}}
 */
export function diffSources(currentHashes, ledgerSources) {
  const prior = ledgerSources && typeof ledgerSources === 'object' ? ledgerSources : {};
  const changed = [];
  const unchanged = [];
  for (const [path, cur] of Object.entries(currentHashes || {})) {
    if (prior[path] && prior[path].hash === cur.hash) unchanged.push(path);
    else changed.push({ path, profile: cur.profile, hash: cur.hash });
  }
  return { changed, unchanged };
}

/**
 * The extraction packet Claude reads. Profiles are trimmed to what the LLM
 * needs (name, hints, doneSignals) and filtered to those with changed files.
 * @param {{path:string,profile:string}[]} changed
 * @param {object[]} profiles  active profiles (detectProfiles output)
 * @returns {{changedFiles:{path:string,profile:string}[], profiles:{name,hints,doneSignals}[]}}
 */
export function buildManifest(changed, profiles) {
  const used = new Set((changed || []).map((c) => c.profile));
  return {
    changedFiles: (changed || []).map(({ path, profile }) => ({ path, profile })),
    profiles: (profiles || [])
      .filter((p) => used.has(p.name))
      .map(({ name, hints, doneSignals }) => ({ name, hints, doneSignals })),
  };
}
