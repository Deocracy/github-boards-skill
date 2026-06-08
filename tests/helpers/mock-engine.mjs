// tests/helpers/mock-engine.mjs
// A fake of the engine surface (Phase 1 exports). Records calls; returns canned data.
export function makeMockEngine(overrides = {}) {
  const calls = [];
  const rec = (op) => (...args) => { calls.push({ op, args }); return (overrides[op]?.(...args)); };
  return {
    calls,
    listItems:      rec('listItems'),
    getStageField:  rec('getStageField'),
    createIssue:    rec('createIssue'),
    addIssueToBoard:rec('addIssueToBoard'),
    setLabels:      rec('setLabels'),
    removeLabels:   rec('removeLabels'),
    comment:        rec('comment'),
    setStage:       rec('setStage'),
  };
}
