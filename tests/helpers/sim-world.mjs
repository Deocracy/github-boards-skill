// tests/helpers/sim-world.mjs — the M6 simulation world.
//
// One stateful mock board + one temp repo dir + REAL verbs only. Crash windows
// are produced exclusively at reachable seams: one-shot engine-op throws
// (failNext — how network death presents to the verb layer) and ledger-path
// sabotage (how fs death presents to writeLedger). Persisted state is NEVER
// hand-mutated (MEMORY: reachable states only).
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { makeMockEngine } from './mock-engine.mjs';
import {
  summary, move, route, syncRecord, promoteApply, reconcileScan, reconcileApply,
  snapshotTake as snapshotTakeVerb, snapshotInvert,
} from '../../scripts/board-manager.mjs';
import { readLedger, writeLedger } from '../../scripts/lib/ledger.mjs';
import { applyProposals } from '../../scripts/lib/mapper.mjs';
import { classifyDrift } from '../../scripts/lib/reconcile.mjs';
import { listSnapshots, readLog, resolveKeep } from '../../scripts/lib/snapshots.mjs';
import { readState } from '../../scripts/lib/state.mjs';

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
  let _ledgerSabotaged = false;
  const faults = {
    sabotageLedgerOnce() {
      if (_ledgerSabotaged) throw new Error('sim-world: ledger already sabotaged — repairLedger() first');
      // a DIRECTORY at the file path -> next writeFile throws (EISDIR/EPERM)
      if (existsSync(ledgerPath)) renameSync(ledgerPath, ledgerBak);
      mkdirSync(ledgerPath, { recursive: true });
      _ledgerSabotaged = true;
    },
    repairLedger() {
      if (!_ledgerSabotaged) return;
      rmSync(ledgerPath, { recursive: true, force: true });
      if (existsSync(ledgerBak)) renameSync(ledgerBak, ledgerPath);
      _ledgerSabotaged = false;
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
    listItems: () => { const items = itemsView(false); return { items, count: items.length }; },
    listItemsWithBodies: () => { const items = itemsView(true); return { items, count: items.length }; },
    getStageField: () => ({ id: 'stage-field', options: Object.entries(cfg.stageOptions).map(([name, id]) => ({ name, id })) }),
  });

  /** One-shot fault: the (onCall)th future call of `op` throws. */
  engine.failNext = (op, { onCall = 1 } = {}) => { fail.set(op, { countdown: onCall }); };

  // ---- GitHub-UI backdoors (real humans can do these in the browser; the
  // verbs cannot — they exist so scenarios/soak can exercise vanished/retitled)
  const board = {
    archiveCard: (num) => { archived.add(num); },
    retitle: (num, title) => { const i = issues.find((x) => x.number === num); if (i) i.title = title; },
  };

  const ctx = () => ({ engine, config: cfg, staged: false, dir });

  // ---- invariant closure state
  let lastLogLines = 0;

  /** Throws naming the violated invariant + offending ids. Cheap enough to run
   *  after every soak step. Crashed states are LEGAL states — the invariants
   *  assert classifiability and integrity, not absence of drift. */
  async function checkInvariants() {
    const ledger = (await readLedger(dir)) || { candidates: [] };
    const { items } = await engine.listItemsWithBodies();
    const drift = classifyDrift({ ledger, items, sourceExists: () => true });

    // 1. no-duplicate-cards: one board card per cid marker
    if (drift.duplicates.length) {
      throw new Error(`invariant no-duplicate-cards: duplicate marker group(s): ${JSON.stringify(drift.duplicates)}`);
    }

    // 2. ledger<->board: refs-bearing (itemId set) non-final candidates whose card
    //    REACHED the board must be classified SOMEWHERE — either resume-pending (card
    //    still on board) or as a vanished entry in uncertain (card archived/deleted via
    //    GitHub UI, F2 fix). Off-board partials (A2 window: itemId == null) are
    //    invisible to board-scoped classifyDrift by design — promote's resume recovers.
    const resumeIds = new Set(drift.resumePending.map((r) => r.candidateId ?? r.id));
    const vanishedIds = new Set(
      (drift.uncertain || []).filter((u) => u.kind === 'vanished').map((u) => u.candidateId),
    );
    for (const c of ledger.candidates || []) {
      if (c.promotion && c.promotion.issueNumber != null && c.promotion.itemId != null && c.status !== 'promoted' && c.status !== 'dismissed') {
        if (!resumeIds.has(c.id) && !vanishedIds.has(c.id)) {
          throw new Error(`invariant ledger-board: candidate ${c.id} has live refs (itemId set) but is not classified resume-pending or vanished`);
        }
      }
      if (c.status === 'promoted' && c.promotion && c.promotion.itemId != null) {
        const onBoardNow = items.some((it) => it.itemId === c.promotion.itemId);
        // vanished cards are LEGAL (reconcile's job) — only assert classifiability:
        if (!onBoardNow && drift.clean) {
          throw new Error(`invariant ledger-board: promoted ${c.id} vanished but scan says clean`);
        }
      }
    }

    // 3. journal-integrity: append-only, parseable
    const logPath = join(dir, '.github-boards', 'snapshots', 'log.jsonl');
    const lines = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).length
      : 0;
    if (lines < lastLogLines) {
      throw new Error(`invariant journal-integrity: log shrank from ${lastLogLines} to ${lines} lines`);
    }
    lastLogLines = lines;

    // Also verify skippedLines === 0 (no truncated/unparseable lines at the tail)
    if (existsSync(logPath)) {
      const { skippedLines } = await readLog(dir, Infinity);
      if (skippedLines > 0) {
        throw new Error(`invariant journal-integrity: ${skippedLines} unparseable line(s) in log`);
      }
    }

    // 4. snapshot-store: count <= resolveKeep(config)
    const snaps = await listSnapshots(dir);
    const keep = resolveKeep(cfg);
    if (snaps.length > keep) {
      throw new Error(`invariant snapshot-store: ${snaps.length} snapshots exceed keep=${keep}`);
    }

    // 5. state-honesty: if state.json exists it must be valid JSON (readState throws on malformed)
    await readState(dir); // throws 'state.mjs: malformed JSON in ...' if corrupt
  }

  /** Session boundary: run REAL summary (state write + snapshot piggyback). */
  async function newSession() {
    const r = await summary(ctx());
    return r.say;
  }

  const ops = {
    _pendingTitles: [],

    /** Append TODO lines (the watched source the pipeline ingests). */
    async seedTodo(titles) {
      appendFileSync(join(dir, 'TODO.md'), titles.map((t) => `- [ ] ${t}\n`).join(''), 'utf8');
      ops._pendingTitles.push(...titles);
    },

    /** Record the "LLM extraction" of every seeded-but-unrecorded title.
     *  Returns the report sub-object directly so callers can check .added/.deduped. */
    async pipelineSync() {
      const extracted = ops._pendingTitles.map((t) => ({ title: t, source: 'TODO.md' }));
      ops._pendingTitles = [];
      const result = await syncRecord({ dir, config: cfg, extracted });
      return result.report;
    },

    /** Map every pending candidate (status==='candidate') to a confident agent/Ideas card. */
    async mapAll() {
      const ledger = (await readLedger(dir)) || { candidates: [] };
      const pending = (ledger.candidates || []).filter((c) => c.status === 'candidate');
      if (!pending.length) return { mapped: 0 };
      const proposals = pending.map((c) => ({
        candidateId: c.id, kind: 'card', title: c.title, lane: 'Ideas', owner: 'agent',
        confidence: 0.95, rationale: 'sim',
      }));
      const { ledger: mapped } = applyProposals(ledger, proposals, cfg);
      await writeLedger(dir, mapped);
      return { mapped: proposals.length };
    },

    async promoteAll() { return promoteApply(null, ctx()); },

    /** Crash a promote run at a named window (reachable seams only):
     *  'A1' ledger-write dies right after createIssue (refs never persist)
     *  'A2' addIssueToBoard dies (refs persisted; stage/labels unrun)
     *  'A3' setStage dies (labels unrun)  ·  'A3b' setLabels dies
     *  'A4' second item's createIssue dies (batch split)            */
    async crashedPromote(window) {
      if (window === 'A1') {
        _armA1 = true; // createIssue override fires sabotageLedgerOnce after push
      } else if (window === 'A2') engine.failNext('addIssueToBoard');
      else if (window === 'A3') engine.failNext('setStage');
      else if (window === 'A3b') engine.failNext('setLabels');
      else if (window === 'A4') engine.failNext('createIssue', { onCall: 2 });
      else throw new Error(`unknown crash window ${window}`);
      const rep = await promoteApply(null, ctx());
      if (window === 'A1') faults.repairLedger();
      return rep;
    },

    async humanMove(card, lane) { return move(card, lane, ctx()); },

    async humanFlip(card) {
      const { items } = await engine.listItems();
      const it = items.find((i) => i.issueNumber === card);
      const owner = (it?.labels || []).includes(cfg.routing.agent) ? 'human' : 'agent';
      return route(card, owner, ctx());
    },

    async humanRelabel(card, label) { await engine.setLabels(card, [label]); },

    async reconcileScanHeal(decisions = null) {
      const scan = await reconcileScan(ctx());
      if (scan.drift.clean) return { scan, applied: null };
      const applied = await reconcileApply(decisions, { engine, config: cfg, dir });
      return { scan, applied };
    },

    async snapshotTake(label = null) { return snapshotTakeVerb(label, ctx()); },

    /** Undo to a pinned ref: invert, execute every op, then prove soundness
     *  (re-invert same ref must yield no remaining ops). */
    async undoTo(ref) {
      const plan = await snapshotInvert(ref, null, ctx());
      for (const op of plan.ops) {
        if (op.op === 'move') await move(op.issueNumber, op.to, ctx());
        if (op.op === 'route') await route(op.issueNumber, op.to, ctx());
      }
      const recheck = await snapshotInvert(ref, null, ctx());
      if (recheck.ops.length !== 0) {
        throw new Error(`invariant undo-soundness: ${recheck.ops.length} op(s) remain after undoTo(${ref})`);
      }
      return { plan, executed: plan.ops.length };
    },
  };

  return {
    dir,
    config: cfg,
    engine,
    board,
    faults,
    ops,
    newSession,
    checkInvariants,
    _internal: { issues, stages, labels, onBoard, archived },
    // _armA1 accessor for crashedPromote (Tasks 2+)
    get _armA1() { return _armA1; },
    set _armA1(v) { _armA1 = v; },
  };
}
