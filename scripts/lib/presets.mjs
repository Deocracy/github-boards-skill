// scripts/lib/presets.mjs — preset loader + lane-name utilities.
//
// Presets live at <repo-root>/presets/<name>.json.
// loadPreset(name) rejects (fail-closed) on unknown/missing preset.
// laneNames(preset) maps preset.lanes[].name in order.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// presets/ is two levels up from scripts/lib/
const PRESETS_DIR = resolve(__dirname, '..', '..', 'presets');

/**
 * Load a bundled preset by name.
 * @param {string} name  Preset name (e.g. 'build', 'grants')
 * @returns {Promise<object>} Parsed preset object
 * @throws If the preset file does not exist or is not valid JSON
 */
export async function loadPreset(name) {
  if (!name || typeof name !== 'string') {
    throw new Error(`loadPreset: name must be a non-empty string, got ${JSON.stringify(name)}`);
  }
  const path = resolve(PRESETS_DIR, `${name}.json`);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    throw new Error(`Unknown preset "${name}": no file at ${path} (${e.code || e.message})`);
  }
  let preset;
  try {
    preset = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Preset "${name}" at ${path} is not valid JSON: ${e.message}`);
  }
  return preset;
}

/**
 * Return the lane names from a preset in order.
 * @param {object} preset  A loaded preset object
 * @returns {string[]}
 */
export function laneNames(preset) {
  if (!preset || !Array.isArray(preset.lanes)) return [];
  return preset.lanes.map((l) => l.name);
}

/**
 * Pure coverage check: every preset lane must appear as a key in stageOptions.
 * Returns { ok: boolean, missing: string[] }.
 * This is intentionally synchronous and side-effect-free — safe to call from doctor.
 *
 * @param {object} preset       A loaded preset object (from loadPreset)
 * @param {object} stageOptions The board.json stageOptions map { label -> optionId }
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkPresetCoverage(preset, stageOptions) {
  const names = laneNames(preset);
  const configKeys = new Set(Object.keys(stageOptions || {}));
  const missing = names.filter((n) => !configKeys.has(n));
  return { ok: missing.length === 0, missing };
}
