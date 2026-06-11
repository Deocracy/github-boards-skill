// tests/live-reconcile.test.mjs — operator-gated live smoke for the ONE new
// live surface in M4a: listItems({withBodies:true}) against a real board.
// Set GBS_LIVE=1 to run. NEVER run in automated/subagent sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LIVE = process.env.GBS_LIVE === '1';

test('live: listItems withBodies returns body + issueUrl per issue item', { skip: !LIVE ? 'set GBS_LIVE=1 to run' : false }, async () => {
  const eng = await import('../scripts/board.mjs');
  const cfg = eng.loadConfig(undefined); // default board.json resolution
  const { items } = eng.listItems(cfg, { withBodies: true });
  assert.ok(Array.isArray(items));
  for (const it of items) {
    if (it.contentType === 'Issue') {
      assert.notEqual(it.body, undefined, 'withBodies items must carry body');
      assert.notEqual(it.issueUrl, undefined, 'withBodies items must carry issueUrl');
    }
  }
});
