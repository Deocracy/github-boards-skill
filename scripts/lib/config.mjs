// scripts/lib/config.mjs — board.json config loader with preset merge.
//
// Single responsibility: read + validate board.json, resolve the preset via
// loadPreset, default routing if absent, return a merged config object.
//
// Required keys: projectId, stageFieldId, stageOptions, preset.
// Returns: { ...rawConfig, preset: <loaded preset object>, routing }

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPreset } from './presets.mjs';

const DEFAULT_ROUTING = { agent: 'agent:go', human: 'needs-claude' };

/**
 * Load and validate a board.json config file, resolving the preset.
 *
 * @param {string} path  Path to board.json (relative or absolute)
 * @returns {Promise<object>} Merged config: { projectId, stageFieldId, stageOptions, routing, preset, ...rest }
 * @throws If required keys are missing, preset is unknown, or file is unreadable
 */
export async function loadConfig(path) {
  if (!path || typeof path !== 'string') {
    throw new Error('loadConfig: path must be a non-empty string');
  }

  // Resolve relative paths from cwd (consistent with how tests pass fixture paths)
  const absPath = resolve(process.cwd(), path);

  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (e) {
    throw new Error(`config not found at ${absPath}: ${e.code || e.message}`);
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config at ${absPath} is not valid JSON: ${e.message}`);
  }

  // Validate required keys (fail-closed)
  for (const k of ['projectId', 'stageFieldId', 'stageOptions']) {
    if (cfg[k] === undefined) {
      throw new Error(`config missing required key '${k}' in ${absPath}`);
    }
  }

  // Validate types
  for (const k of ['projectId', 'stageFieldId']) {
    if (typeof cfg[k] !== 'string' || cfg[k].trim() === '') {
      throw new Error(`config.${k} must be a non-empty string`);
    }
  }
  if (
    cfg.stageOptions === null ||
    typeof cfg.stageOptions !== 'object' ||
    Array.isArray(cfg.stageOptions) ||
    Object.keys(cfg.stageOptions).length === 0
  ) {
    throw new Error(`config.stageOptions must be a non-empty object of { label: optionId }`);
  }

  // Resolve preset (required — throws if unknown or absent)
  if (!cfg.preset || typeof cfg.preset !== 'string') {
    throw new Error(`config missing required key 'preset' (must be a preset name string) in ${absPath}`);
  }
  const preset = await loadPreset(cfg.preset);

  // Default routing if absent
  const routing = cfg.routing && typeof cfg.routing === 'object' && !Array.isArray(cfg.routing)
    ? cfg.routing
    : { ...DEFAULT_ROUTING };

  return {
    ...cfg,
    preset,
    routing,
  };
}
