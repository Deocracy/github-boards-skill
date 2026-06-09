// scripts/lib/config-writer.mjs — persist board.json (the loader is read-only).
//
// writeBoardConfig validates the minimum binding keys before writing so a
// half-built config never lands on disk in a shape loadConfig would later
// reject. Used by the bootstrap verb's write-as-you-go resumability.

import { writeFile } from 'node:fs/promises';

const REQUIRED = ['owner', 'projectNumber', 'projectId', 'repo', 'stageFieldId', 'stageOptions', 'preset', 'routing'];

/**
 * @param {string} path  absolute path to board.json
 * @param {object} cfg   the binding config
 * @returns {Promise<string>} the path written
 */
export async function writeBoardConfig(path, cfg) {
  for (const k of REQUIRED) {
    if (cfg[k] === undefined || cfg[k] === null) {
      throw new Error(`writeBoardConfig: config missing required key '${k}'`);
    }
  }
  if (typeof cfg.projectNumber !== 'number') {
    throw new Error(`writeBoardConfig: projectNumber must be a number, got ${typeof cfg.projectNumber}`);
  }
  if (typeof cfg.stageOptions !== 'object' || Array.isArray(cfg.stageOptions) || Object.keys(cfg.stageOptions).length === 0) {
    throw new Error('writeBoardConfig: stageOptions must be a non-empty object');
  }
  await writeFile(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return path;
}
