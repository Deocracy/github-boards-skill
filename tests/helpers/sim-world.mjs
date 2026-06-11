// tests/helpers/sim-world.mjs — the M6 simulation world.
//
// One stateful mock board + one temp repo dir + REAL verbs only. Crash windows
// are produced exclusively at reachable seams: one-shot engine-op throws
// (failNext — how network death presents to the verb layer) and ledger-path
// sabotage (how fs death presents to writeLedger). Persisted state is NEVER
// hand-mutated (MEMORY: reachable states only).
import { mkdtempSync, mkdirSync, rmdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { makeMockEngine } from './mock-engine.mjs';

export const WORLD_CFG = {
  stageOptions: { Ideas: 'o1', Building: 'o2', Review: 'o3' },
  routing: { agent: 'agent:go', human: 'needs-claude' },
  preset: { lanes: [{ name: 'Ideas' }, { name: 'Building' }, { name: 'Review' }] },
  rules: { promoteConfidenceBelow: 0.8 },
  snapshots: { keep: 50 },
};

export async function makeWorld({ config } = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'gbs-sim-'));
  const cfg = config || WORLD_CFG;

  // ---- board state (mutated ONLY via engine ops + the two GitHub-UI backdoors)
  const issues = [];            // {number, url, issueNodeId, title, body}
  let n = 0;
  const stages = new Map();     // itemId -> lane
  const labels = new Map();     // issueNumber -> string[]
  const onBoard = new Set();    // issueNumber
  const archived = new Set();   // issueNumber (GitHub-UI archive: off listItems)

  // ---- fault state (declared BEFORE engine overrides so createIssue can close over faults)
  const fail = new Map();       // op -> {countdown}
  function maybeFail(op) {
    const f = fail.get(op);
    if (!f) return;
    f.countdown -= 1;
    if (f.countdown <= 0) {
      fail.delete(op);
      throw new Error(`injected: ${op} died`);
    }
  }

  // ---- ledger-path fault helpers (declared here so createIssue override can see faults)
  const ledgerPath = join(dir, '.github-boards', 'ledger.json');
  const ledgerBak = join(dir, '.github-boards', 'ledger.json.bak');
  const faults = {
    sabotageLedgerOnce() {
      // a DIRECTORY at the file path -> next writeFile throws (EISDIR/EPERM)
      if (existsSync(ledgerPath)) renameSync(ledgerPath, ledgerBak);
      mkdirSync(ledgerPath, { recursive: true });
    },
    repairLedger() {
      rmdirSync(ledgerPath);
      if (existsSync(ledgerBak)) renameSync(ledgerBak, ledgerPath);
    },
    sabotageSnapshotsDirOnce() {
      mkdirSync(join(dir, '.github-boards'), { recursive: true });
      writeFileSync(join(dir, '.github-boards', 'snapshots'), 'not a dir', 'utf8');
    },
  };

  // ---- A1 arming flag (plain closure var — lets createIssue arm the sabotage
  //      after the ledger has been read by promoteApply, without hanging state on w)
  let _armA1 = false;

  const itemsView = (withBodies) => issues
    .filter((i) => onBoard.has(i.number) && !archived.has(i.number))
    .map((i) => ({
      itemId: `item-${i.number}`, contentType: 'Issue', issueNumber: i.number, title: i.title,
      state: 'OPEN', repo: 'o/r',
      stageLabel: stages.get(`item-${i.number}`) ?? null,
      labels: labels.get(i.number) ?? [],
      ...(withBodies ? { body: i.body ?? '', issueUrl: i.url } : {}),
    }));

  const engine = makeMockEngine({
    createIssue: async (title, body) => {
      maybeFail('createIssue');
      n += 1;
      const issue = { number: n, url: `https://github.com/o/r/issues/${n}`, issueNodeId: `node${n}`, title, body };
      issues.push(issue);
      if (_armA1) {
        _armA1 = false;
        faults.sabotageLedgerOnce(); // the very next writeLedger (refs persist) dies
      }
      return issue;
    },
    addIssueToBoard: async (url) => {
      maybeFail('addIssueToBoard');
      const num = Number(url.split('/').pop());
      onBoard.add(num);
      return { itemId: `item-${num}` };
    },
    setStage: async (itemId, lane) => { maybeFail('setStage'); stages.set(itemId, lane); return { ok: true }; },
    setLabels: async (issueNumber, ls) => {
      maybeFail('setLabels');
      labels.set(issueNumber, [...new Set([...(labels.get(issueNumber) || []), ...ls])]);
      return { ok: true };
    },
    removeLabels: async (issueNumber, ls) => {
      maybeFail('removeLabels');
      labels.set(issueNumber, (labels.get(issueNumber) || []).filter((l) => !ls.includes(l)));
      return { ok: true };
    },
    comment: async () => { maybeFail('comment'); return { ok: true }; },
    listItems: () => ({ items: itemsView(false), count: itemsView(false).length }),
    listItemsWithBodies: () => ({ items: itemsView(true), count: itemsView(true).length }),
  });

  /** One-shot fault: the (onCall)th future call of `op` throws. */
  engine.failNext = (op, { onCall = 1 } = {}) => { fail.set(op, { countdown: onCall }); };

  // ---- GitHub-UI backdoors (real humans can do these in the browser; the
  // verbs cannot — they exist so scenarios/soak can exercise vanished/retitled)
  const board = {
    archiveCard: (num) => { archived.add(num); },
    retitle: (num, title) => { const i = issues.find((x) => x.number === num); if (i) i.title = title; },
  };

  return {
    dir,
    config: cfg,
    engine,
    board,
    faults,
    _internal: { issues, stages, labels, onBoard, archived },
    // _armA1 accessor for crashedPromote (Tasks 2+)
    get _armA1() { return _armA1; },
    set _armA1(v) { _armA1 = v; },
  };
}
