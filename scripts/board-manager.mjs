#!/usr/bin/env node
// board-manager.mjs — the conversational VERB layer.
//
// This module composes the already-built engine (board.mjs) into natural-language
// verbs ("put this on the board", "what's on my plate"). Verbs are dependency-
// injected with a `ctx` object so they unit-test against a MOCK engine; the CLI
// shim at the bottom builds the REAL engine adapter (wrapping board.mjs's exports)
// and dispatches.
//
// THE DI CONTRACT (verbs only ever touch the engine through these methods):
//   engine.listItems()                                  -> { items:[{itemId,issueNumber,title,stageLabel,labels[]}], count }
//   engine.getStageField()                              -> { fieldId, fieldName, options:[{label,optionId}] }
//   engine.createIssue(title, body, {labels,staged})    -> { issueNodeId, number, url, contentType } | { staged, wouldRun }
//   engine.addIssueToBoard(issueUrl, {staged})          -> { itemId } | { staged, wouldRun }
//   engine.setStage(itemId, stageLabel, {staged})       -> { ok } | { staged, wouldRun }
//   engine.setLabels(issueNumber, labels[], {staged})   -> { ok } | { staged, wouldRun }
//   engine.comment(issueNumber, body, {identity,staged})-> { commentUrl, ... } | { staged, wouldRun }
//
// ctx = { engine, config, staged }
//   config = { projectId, stageFieldId, stageOptions, routing:{agent,human}, preset:{name,kind,lanes:[{name,terminal}],...} }

import { pathToFileURL } from 'node:url';

// ===========================================================================
// HELPERS (small + pure-ish, exported for unit testing)
// ===========================================================================

/**
 * The first NON-terminal lane name from config.preset.lanes
 * (e.g. "Ideas" for the build preset, "Intake" for grants). This is where a new
 * card lands when the caller doesn't name a lane.
 * @param {object} config
 * @returns {string}
 */
export function defaultLane(config) {
  const lanes = config?.preset?.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw new Error('defaultLane: config.preset.lanes is missing or empty');
  }
  const lane = lanes.find((l) => !l.terminal);
  if (!lane) {
    throw new Error('defaultLane: preset has no non-terminal lane to default into');
  }
  return lane.name;
}

/**
 * Human-readable queue split, reused by report-backs.
 * @param {number} human  count of human-owned cards
 * @param {number} agent  count of agent-owned cards
 * @returns {string}
 */
export function sayQueues(human, agent) {
  return `On your plate: ${human} card(s). Claude's queue: ${agent} card(s).`;
}

/**
 * Resolve a stable project itemId from an issue number by scanning listItems().
 * Not used by queue/put, but the move/route verbs (next chunk) need it — it lives
 * here as the single shared resolver so every verb agrees on the lookup.
 * @param {object} engine  the DI engine adapter
 * @param {number} issueNumber
 * @returns {Promise<string>} the itemId
 * @throws if no board item carries that issue number
 */
export async function resolveItemId(engine, issueNumber) {
  const { items } = await engine.listItems();
  const match = (items || []).find((i) => i.issueNumber === issueNumber);
  if (!match) {
    throw new Error(
      `resolveItemId: no board item found for issue #${issueNumber} ` +
      `(searched ${items?.length ?? 0} item(s)). Is it on the board?`
    );
  }
  return match.itemId;
}

// ===========================================================================
// VERBS
// ===========================================================================

/**
 * queue(owner, ctx) — "what's on my plate" (human) / "what's Claude working on" (agent).
 * Read-only: filters listItems() to cards carrying the owner's routing label.
 * @param {'agent'|'human'} owner
 * @param {object} ctx  { engine, config }
 * @returns {Promise<{items:object[], say:string}>}
 */
export async function queue(owner, ctx) {
  if (owner !== 'agent' && owner !== 'human') {
    throw new Error(`queue: owner must be 'agent' or 'human', got ${JSON.stringify(owner)}`);
  }
  const label = ctx.config.routing[owner];
  const { items } = await ctx.engine.listItems();
  const mine = (items || []).filter((i) => (i.labels || []).includes(label));

  const n = mine.length;
  const headline = owner === 'human'
    ? `On your plate: ${n} card(s).`
    : `Claude's queue: ${n} card(s).`;
  // Append a short titles list so the report-back is legible at a glance.
  const titles = mine
    .map((i) => `#${i.issueNumber} ${i.title}`)
    .filter(Boolean);
  const say = titles.length ? `${headline} ${titles.join('; ')}` : headline;

  return { items: mine, say };
}

/**
 * put(tasks, ctx) — "put this/these on the board".
 * For each task, in order: createIssue -> addIssueToBoard -> setStage -> setLabels.
 * In staged mode every op is still CALLED with { staged:true } (the engine returns a
 * plan and writes nothing); we report "Would file" and do NOT mark committed.
 * @param {Array<{title:string, body?:string, lane?:string, owner?:'agent'|'human'}>} tasks
 * @param {object} ctx  { engine, config, staged }
 * @returns {Promise<{committed:boolean, created:object[], say:string}>}
 */
export async function put(tasks, ctx) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('put: tasks must be a non-empty array of { title, body?, lane?, owner? }');
  }
  const { engine, config, staged } = ctx;
  const created = [];

  for (const task of tasks) {
    if (!task || !task.title) {
      throw new Error('put: each task requires a title');
    }
    const body = task.body ?? '';
    const lane = task.lane || defaultLane(config);
    const owner = task.owner || 'human';
    const label = config.routing[owner];

    // EXACT order: create -> add -> stage -> label. Each threads { staged }.
    //
    // HARD RULE: in staged mode we STILL call every op (the engine returns a
    // `{ staged, wouldRun }` plan and writes nothing). But a staged return carries
    // NO real url/number/itemId — so we substitute legible sentinels to keep the
    // chain calling downstream ops instead of feeding them `undefined`. (The mock
    // engine ignores these args; the real engine, in staged mode, still previews.)
    const issue = await engine.createIssue(task.title, body, { labels: [], staged });
    const issueUrl = issue.url ?? '(staged: url pending)';
    const issueNumber = issue.number ?? null;

    const item = await engine.addIssueToBoard(issueUrl, { staged });
    const itemId = item.itemId ?? '(staged: itemId pending)';

    await engine.setStage(itemId, lane, { staged });
    await engine.setLabels(issueNumber, [label], { staged });

    created.push({ number: issueNumber, url: issueUrl, owner, lane });
  }

  const humanCount = created.filter((c) => c.owner === 'human').length;
  const agentCount = created.filter((c) => c.owner === 'agent').length;
  const n = created.length;
  const verb = staged ? 'Would file' : 'Filed';
  const say = `${verb} ${n} card(s). ${sayQueues(humanCount, agentCount)}`;

  return { committed: !staged, created, say };
}

// ===========================================================================
// CLI SHIM + REAL ENGINE ADAPTER
// ===========================================================================
//
// The adapter wraps board.mjs's exported ops to honor the DI contract above.
// board.mjs's ops have the signature `op(cfg, flags, ...args)` and read
// staged/labels/identity off `flags`. The adapter binds `cfg` and translates each
// verb-style options object into the `flags` shape board.mjs expects:
//   - createIssue: DI passes { labels:[], staged }; board.mjs reads labels off
//     flags.labels (a CSV) -> we join the array into a CSV. staged -> flags.staged.
//   - setLabels:   DI passes labels as an ARRAY; board.mjs's setLabels takes a CSV
//     positional -> we join. staged -> flags.staged.
//   - comment:     DI passes { identity, staged }; both map onto flags.
//   - listItems/setStage/addIssueToBoard: staged (if any) -> flags.staged.
// `--json` is left false; verbs don't read engine stdout, only return values.

/**
 * Build the real engine adapter by binding board.mjs's ops to a loaded config.
 * Each op is wrapped to convert the verb-facing options object into board.mjs's
 * (cfg, flags, ...) calling convention.
 * @param {object} eng   the board.mjs module namespace (its exports)
 * @param {object} cfg   a board.mjs-style config (loaded via board.mjs loadConfig)
 */
function makeRealEngine(eng, cfg) {
  const flagsFor = (opts = {}) => ({
    staged: !!opts.staged,
    json: false,
    config: null,
    labels: null,
    identity: opts.identity || 'pat',
    interval: null,
    once: false,
  });
  return {
    listItems: () => eng.listItems(cfg),
    getStageField: () => eng.getStageField(cfg),
    createIssue: (title, body, opts = {}) => {
      const flags = flagsFor(opts);
      // DI hands labels as an array; board.mjs's createIssue reads flags.labels (CSV).
      flags.labels = Array.isArray(opts.labels) && opts.labels.length
        ? opts.labels.join(',')
        : null;
      return eng.createIssue(cfg, flags, title, body);
    },
    addIssueToBoard: (issueUrl, opts = {}) =>
      eng.addIssueToBoard(cfg, flagsFor(opts), issueUrl),
    setStage: (itemId, stageLabel, opts = {}) =>
      eng.setStage(cfg, flagsFor(opts), itemId, stageLabel),
    setLabels: (issueNumber, labels, opts = {}) =>
      // DI hands an array; board.mjs's setLabels takes a CSV positional.
      eng.setLabels(cfg, flagsFor(opts), issueNumber, (labels || []).join(',')),
    comment: (issueNumber, body, opts = {}) =>
      eng.comment(cfg, flagsFor(opts), issueNumber, body),
  };
}

/**
 * Minimal CLI arg parse: <verb> [--staged] [--config <path>] [verb args...]
 */
function parseCliArgs(argv) {
  const out = { verb: null, staged: false, config: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') out.staged = true;
    else if (a === '--config') out.config = argv[++i];
    else if (!out.verb) out.verb = a;
    else out.rest.push(a);
  }
  return out;
}

async function cli() {
  const { verb, staged, config: configPath, rest } = parseCliArgs(process.argv.slice(2));

  if (!verb || verb === '--help' || verb === 'help') {
    console.log(`board-manager.mjs — conversational board verbs

  queue <agent|human>                 what's on a queue (read-only)
  put "<title>" [owner] [lane]        file one card (create->add->stage->label)

  --staged          preview every write; nothing is committed
  --config <path>   board.json (default ../board.json via board.mjs)`);
    return;
  }

  // The verb-layer config (preset + routing) comes from scripts/lib/config.mjs.
  // The engine adapter binds a board.mjs-style config (loaded by board.mjs's own
  // loadConfig). We load both: lib/config gives routing+preset; board.mjs's config
  // gives the projectId/owner/repo the ops actually shell out against.
  const { loadConfig } = await import('./lib/config.mjs');
  const eng = await import('./board.mjs');

  // board.mjs's loadConfig defaults to ../board.json when path is null.
  const engineCfg = eng.loadConfig(configPath || undefined);
  // lib/config.loadConfig requires an explicit path; fall back to the same file
  // board.mjs uses (its resolved __path) so routing+preset come from one source.
  const verbCfg = await loadConfig(configPath || engineCfg.__path);

  const ctx = { engine: makeRealEngine(eng, engineCfg), config: verbCfg, staged };

  let result;
  switch (verb) {
    case 'queue': {
      const owner = rest[0];
      if (!owner) throw new Error('usage: queue <agent|human>');
      result = await queue(owner, ctx);
      break;
    }
    case 'put': {
      const [title, owner, lane] = rest;
      if (!title) throw new Error('usage: put "<title>" [owner] [lane]');
      result = await put([{ title, owner, lane }], ctx);
      break;
    }
    default:
      throw new Error(`unknown verb '${verb}'. Run --help for the verb map.`);
  }

  console.log(result.say);
  console.log(JSON.stringify(result, null, 2));
}

// Run as a CLI only when invoked directly (not when imported for testing).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  cli().catch((e) => {
    console.error(`[ERROR] ${e.message}`);
    process.exit(1);
  });
}
