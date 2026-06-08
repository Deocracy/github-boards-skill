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
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPreset, laneNames } from './lib/presets.mjs';
import { readState, writeState, diff } from './lib/state.mjs';

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
    // `{ staged, wouldRun }` plan and writes nothing) to honor Invariant 4 and
    // exercise the engine's validation. But a staged return carries NO real
    // url/number/itemId. So the human-facing preview is built from the INPUTS
    // (title, lane, owner), NOT from these id-less staged returns — keeping the
    // chain flowing on clean placeholders rather than `undefined`, and the `say`
    // legible (no `#null`, no sentinel strings).
    const issue = await engine.createIssue(task.title, body, { labels: [], staged });
    const issueUrl = staged ? null : (issue.url ?? null);
    const issueNumber = staged ? null : (issue.number ?? null);

    const item = await engine.addIssueToBoard(issueUrl, { staged });
    const itemId = staged ? null : (item.itemId ?? null);

    await engine.setStage(itemId, lane, { staged });
    await engine.setLabels(issueNumber, [label], { staged });

    created.push({ number: issueNumber, url: issueUrl, owner, lane, title: task.title });
  }

  const humanCount = created.filter((c) => c.owner === 'human').length;
  const agentCount = created.filter((c) => c.owner === 'agent').length;
  const n = created.length;
  let say;
  if (staged) {
    // Preview lists intended cards by title/lane/owner (READS + INPUTS only).
    const list = created.map((c) => `'${c.title}' → ${c.lane} (${c.owner})`).join('; ');
    say = `Would file ${n} card(s): ${list}. ${sayQueues(humanCount, agentCount)}`;
  } else {
    say = `Filed ${n} card(s). ${sayQueues(humanCount, agentCount)}`;
  }

  return { committed: !staged, created, say };
}

/**
 * move(card, lane, ctx) — "move card X to <lane>".
 * Resolve the card's itemId (a READ that works in staged mode), then setStage.
 * @param {number} card  issue number
 * @param {string} lane  target lane name
 * @param {object} ctx   { engine, config, staged }
 * @returns {Promise<{moved:{card,lane,itemId}, committed:boolean, say:string}>}
 */
export async function move(card, lane, ctx) {
  const { engine, staged } = ctx;
  const itemId = await resolveItemId(engine, card); // READ — works in staged mode
  await engine.setStage(itemId, lane, { staged });
  // Staged preview reads from INPUTS + READS (card, lane, itemId), never the
  // id-less staged return of setStage.
  const say = staged
    ? `Would move #${card} → ${lane}.`
    : `Moved #${card} → ${lane}.`;
  return { moved: { card, lane, itemId }, committed: !staged, say };
}

/**
 * reject(card, learnings, ctx) — "reject with learnings".
 * Move the card to the terminal reject lane (terminal:true, name ~ /reject/i)
 * and record the learnings as a comment.
 * @param {number} card  issue number
 * @param {string} [learnings]
 * @param {object} ctx   { engine, config, staged }
 * @returns {Promise<{rejected:{card,lane}, committed:boolean, say:string}>}
 */
export async function reject(card, learnings, ctx) {
  const { engine, config, staged } = ctx;
  const lanes = config?.preset?.lanes;
  if (!Array.isArray(lanes)) {
    throw new Error('reject: config.preset.lanes is missing');
  }
  const rejectLane = lanes.find((l) => l.terminal && /reject/i.test(l.name));
  if (!rejectLane) {
    throw new Error(
      'reject: no terminal lane matching /reject/i found in config.preset.lanes ' +
      `(${lanes.map((l) => l.name).join(', ')}). Add a terminal "Rejected" lane.`
    );
  }
  const lane = rejectLane.name;
  const itemId = await resolveItemId(engine, card); // READ — works in staged mode
  const note = learnings || 'Rejected with learnings.';
  await engine.setStage(itemId, lane, { staged });
  await engine.comment(card, note, { staged });
  // Preview from INPUTS + READS (card, lane), not the id-less staged returns.
  const say = staged
    ? `Would reject #${card} (→ ${lane}) with learnings.`
    : `Rejected #${card} → ${lane}; learnings recorded.`;
  return { rejected: { card, lane }, committed: !staged, say };
}

/**
 * route(card, owner, ctx) — "this needs me" (human) / "hand it to Claude" (agent).
 * Swap the routing label (add the new owner's label, remove the other's). A
 * human-routed card stays claimed (its STAGE is NOT moved) and is escalated via
 * a comment. An agent-routed card is relabeled only.
 * @param {number} card  issue number
 * @param {'agent'|'human'} owner
 * @param {object} ctx   { engine, config, staged }
 * @returns {Promise<{routed:{card,owner}, committed:boolean, say:string}>}
 */
export async function route(card, owner, ctx) {
  if (owner !== 'agent' && owner !== 'human') {
    throw new Error(`route: owner must be 'agent' or 'human', got ${JSON.stringify(owner)}`);
  }
  const { engine, config, staged } = ctx;
  const newLabel = config.routing[owner];
  const oldLabel = config.routing[owner === 'agent' ? 'human' : 'agent'];

  await engine.setLabels(card, [newLabel], { staged });
  await engine.removeLabels(card, [oldLabel], { staged });
  if (owner === 'human') {
    // Invariant: a human-routed card stays claimed (no stage move) and is
    // escalated via a comment.
    const escalationNote =
      '🧍 This card needs a human.' + (config.escalateTo ? ' @' + config.escalateTo : '');
    await engine.comment(card, escalationNote, { staged });
  }
  // Preview from INPUTS only (card, owner) — staged label/comment ops are id-less.
  const say = staged
    ? `Would route #${card} → ${owner}${owner === 'human' ? ' and flag it for you' : ''}.`
    : `Routed #${card} → ${owner}.`;
  return { routed: { card, owner }, committed: !staged, say };
}

/**
 * followup(parent, child, ctx) — "Claude found more work".
 * File a new child card linked to its parent, following put's create -> add ->
 * stage -> label chain. Defaults owner to 'agent' (Claude's queue).
 * @param {number} parent  parent issue number
 * @param {{title:string, body?:string, owner?:'agent'|'human'}} child
 * @param {object} ctx   { engine, config, staged }
 * @returns {Promise<{created:{number,url,owner}, committed:boolean, say:string}>}
 */
export async function followup(parent, child, ctx) {
  if (!child || !child.title) {
    throw new Error('followup: child requires a title');
  }
  const { engine, config, staged } = ctx;
  const owner = child.owner || 'agent';
  const body = (child.body || '') + ('\n\nFollow-up to #' + parent + '.');
  const lane = defaultLane(config);
  const label = config.routing[owner];

  // Same chain + staged discipline as put: every op called with { staged }; the
  // preview is built from INPUTS (title, owner), not the id-less staged returns.
  const issue = await engine.createIssue(child.title, body, { labels: [], staged });
  const issueUrl = staged ? null : (issue.url ?? null);
  const number = staged ? null : (issue.number ?? null);

  const item = await engine.addIssueToBoard(issueUrl, { staged });
  const itemId = staged ? null : (item.itemId ?? null);

  await engine.setStage(itemId, lane, { staged });
  await engine.setLabels(number, [label], { staged });

  const say = staged
    ? `Would file follow-up '${child.title}' (Claude's queue).`
    : `Filed follow-up #${number} '${child.title}'.`;
  return { created: { number, url: issueUrl, owner }, committed: !staged, say };
}

/**
 * reshape(presetName, ctx) — diff the live board's Stage options against a preset
 * and produce a human checklist of one-time UI steps needed to align them.
 * READ-ONLY: never calls any write op; `applied` is always false in v1.
 * @param {string} presetName  Name of a bundled preset (e.g. 'build')
 * @param {object} ctx         { engine, config, staged } — staged is ignored (read-only)
 * @returns {Promise<{diff:{missing:string[],extra:string[]}, applied:false, checklist:string[], say:string}>}
 */
export async function reshape(presetName, ctx) {
  const preset = await loadPreset(presetName);
  const presetLanes = laneNames(preset);
  const presetSet = new Set(presetLanes);

  const field = await ctx.engine.getStageField();
  const boardLabels = (field.options || []).map((o) => o.label);
  const boardSet = new Set(boardLabels);

  const missing = presetLanes.filter((l) => !boardSet.has(l));
  const extra = boardLabels.filter((l) => !presetSet.has(l));

  const checklist = [];
  for (const lane of missing) {
    checklist.push(`Add a \`Stage\` option named "${lane}"`);
  }
  if (extra.length > 0) {
    checklist.push(
      `Review ${extra.length} extra Stage option(s) not in the preset (rename/remove if intended): ${extra.map((e) => `"${e}"`).join(', ')}`
    );
  }
  checklist.push('Set the board view to group by `Stage`.');

  let say;
  if (missing.length === 0 && extra.length === 0) {
    say = `Board already matches the '${presetName}' preset (${presetLanes.length} lanes).`;
  } else {
    const extraNote = extra.length > 0 ? `, and review ${extra.length} extra` : '';
    say = `To match the '${presetName}' preset: add ${missing.length} lane(s)${extraNote}. See the checklist.`;
  }

  return { diff: { missing, extra }, applied: false, checklist, say };
}

/**
 * ownerOf — determine who owns a card based on routing labels.
 * Returns 'agent' | 'human' | null.
 * @param {string[]} labels
 * @param {{agent:string, human:string}} routing
 * @returns {'agent'|'human'|null}
 */
function ownerOf(labels, routing) {
  if ((labels || []).includes(routing.agent)) return 'agent';
  if ((labels || []).includes(routing.human)) return 'human';
  return null;
}

/**
 * summary(ctx) — last-seen memory snapshot and change report.
 * Read-only toward the board (only listItems). Writes local state file.
 * @param {object} ctx  { engine, config, staged, dir? }
 * @returns {Promise<{changes:{moved,added,removed,rejected}, queues:{human,agent}, say:string}>}
 */
export async function summary(ctx) {
  const { engine, config } = ctx;
  const dir = ctx.dir || process.cwd();

  // 1. Fetch current board state
  const { items } = await engine.listItems();
  const currentMap = {};
  for (const it of (items || [])) {
    currentMap[it.issueNumber] = {
      lane: it.stageLabel,
      labels: it.labels || [],
      owner: ownerOf(it.labels, config.routing),
    };
  }

  // 2. Load prior state
  const prev = await readState(dir);

  // 3. Diff
  const d = diff(prev?.items || {}, currentMap);

  // 4. Rejected = cards that moved into a lane matching /reject/i
  const rejected = d.moved.filter((m) => /reject/i.test(m.to));

  // 5. Queue counts from current items
  const values = Object.values(currentMap);
  const human = values.filter((v) => v.owner === 'human').length;
  const agent = values.filter((v) => v.owner === 'agent').length;

  // 6. Build say
  let say;
  if (prev === null) {
    say = `First look at the board. ${sayQueues(human, agent)}`;
  } else {
    say = `Since last time: ${d.moved.length} moved, ${d.added.length} new, ${rejected.length} rejected. ${sayQueues(human, agent)}`;
  }

  // 7. Persist state (always — not a board write)
  const snapshot = { seenAt: new Date().toISOString(), items: currentMap };
  await writeState(dir, snapshot);

  // 8. teamSync opt-in: also write committed last-sync.json
  if (config.teamSync === true) {
    const syncPath = join(dir, 'last-sync.json');
    await writeFile(syncPath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  return { changes: { ...d, rejected }, queues: { human, agent }, say };
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
    removeLabels: (issueNumber, labels, opts = {}) =>
      // DI hands an array; board.mjs's removeLabels takes a CSV positional.
      eng.removeLabels(cfg, flagsFor(opts), issueNumber, (labels || []).join(',')),
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
  move <card#> <lane>                 move a card to a lane
  reject <card#> "<learnings>"        reject a card -> terminal reject lane + learnings
  route <card#> <agent|human>         swap routing label (human also escalates)
  followup <parent#> "<title>" [owner]  file a child card linked to its parent
  reshape <preset>                      diff board Stage options vs preset; print checklist (read-only)
  summary                               last-seen memory: what changed since last run (read-only toward board)

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
    case 'move': {
      const [card, lane] = rest;
      if (!card || !lane) throw new Error('usage: move <card#> <lane>');
      result = await move(Number(card), lane, ctx);
      break;
    }
    case 'reject': {
      const [card, learnings] = rest;
      if (!card) throw new Error('usage: reject <card#> "<learnings>"');
      result = await reject(Number(card), learnings, ctx);
      break;
    }
    case 'route': {
      const [card, owner] = rest;
      if (!card || !owner) throw new Error('usage: route <card#> <agent|human>');
      result = await route(Number(card), owner, ctx);
      break;
    }
    case 'followup': {
      const [parent, title, owner] = rest;
      if (!parent || !title) throw new Error('usage: followup <parent#> "<title>" [owner]');
      result = await followup(Number(parent), { title, owner }, ctx);
      break;
    }
    case 'reshape': {
      const [presetName] = rest;
      if (!presetName) throw new Error('usage: reshape <preset>');
      result = await reshape(presetName, ctx);
      break;
    }
    case 'summary': {
      result = await summary({ ...ctx, dir: process.cwd() });
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
