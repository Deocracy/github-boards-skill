// tests/helpers/mock-engine.mjs
// A fake of the engine surface (Phase 1 exports). Records calls; returns canned data.
//
// Input-validation realism: the real engine's addIssueToBoard runs
// `issueUrl.match(...)` and getIssue BEFORE its stagedGuard, and setStage acts on
// a real itemId. A live `put --staged` test caught that the create-chain verbs
// were passing a NULL issueUrl/itemId into these ops (no real issue exists in
// staged mode), which null-derefs in the real engine. The old mock silently
// accepted nulls and masked the bug. We now mirror the engine's pre-guard
// validation so unit tests reproduce that class of null-chaining bug.
export function makeMockEngine(overrides = {}) {
  const calls = [];
  const rec = (op) => (...args) => { calls.push({ op, args }); return (overrides[op]?.(...args)); };
  // Wrap a recorder with an argument guard that throws (like the real engine)
  // when the load-bearing id is falsy/wrong-typed.
  const guarded = (op, guard) => (...args) => { guard(...args); return rec(op)(...args); };
  return {
    calls,
    listItems:      rec('listItems'),
    getStageField:  rec('getStageField'),
    createIssue:    rec('createIssue'),
    addIssueToBoard: guarded('addIssueToBoard', (issueUrl) => {
      if (!issueUrl || typeof issueUrl !== 'string') {
        throw new Error('addIssueToBoard: invalid issueUrl');
      }
    }),
    setLabels:      rec('setLabels'),
    removeLabels:   rec('removeLabels'),
    comment:        rec('comment'),
    setStage:       guarded('setStage', (itemId) => {
      if (!itemId) {
        throw new Error('setStage: invalid itemId');
      }
    }),
  };
}
