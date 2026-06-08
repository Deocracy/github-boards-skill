// tests/engine.exports.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../scripts/board.mjs';
test('engine exports its ops as functions', () => {
  for (const op of ['listItems','getStageField','createIssue','addIssueToBoard','setLabels','comment','setStage'])
    assert.equal(typeof engine[op], 'function', `missing export: ${op}`);
});
