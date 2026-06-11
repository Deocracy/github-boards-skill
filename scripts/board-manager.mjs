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
//   engine.listItemsWithBodies()                        -> { items:[{itemId,issueNumber,title,stageLabel,labels[],body,issueUrl}], count }
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
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadPreset, laneNames } from './lib/presets.mjs';
import { readState, writeState, diff } from './lib/state.mjs';
import { ensureLedger, readLedger, writeLedger, appendCandidate, setIntent, candidateId } from './lib/ledger.mjs';
import { prepareInput, applyProposals } from './lib/mapper.mjs';
import { classify, resolveDecisions, cidMarker } from './lib/promote.mjs';
import { PROFILES } from './lib/profiles.mjs';
import { contentHash, detectProfiles, diffSources, buildManifest, validateExtraction, WATCH_GLOB_RE } from './lib/sources.mjs';
import { classifyDrift, resolveReconcileDecisions } from './lib/reconcile.mjs';
import { writeSnapshot, listSnapshots, readSnapshot, readLog, diffSnapshots, invertDiff, resolveKeep } from './lib/snapshots.mjs';

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
 * Commit path, per task in order: createIssue -> addIssueToBoard -> setStage -> setLabels.
 * In staged mode there is NO real issue, so the downstream ops cannot operate on it
 * (the real engine null-derefs on issueUrl.match before its stagedGuard — a live
 * `put --staged` caught this). We therefore call ONLY createIssue (which previews +
 * validates via its stagedGuard), preview the chain from the INPUTS, report "Would
 * file", and do NOT mark committed.
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

    if (staged) {
      // STAGED PREVIEW (create chain). A live `put --staged` proved there is NO
      // real issue in staged mode, so the downstream ops cannot operate on it:
      // addIssueToBoard/setStage/setLabels all need a real url/itemId/number that
      // only exists after a committed createIssue. We therefore preview the
      // create-chain FROM THE INPUTS and call only createIssue (its stagedGuard
      // previews correctly and validates the create is well-formed). We do NOT
      // call addIssueToBoard/setStage/setLabels on a nonexistent issue.
      await engine.createIssue(task.title, body, { labels: [], staged });
      created.push({ number: null, url: null, owner, lane, title: task.title });
      continue;
    }

    // COMMIT PATH — EXACT order: create -> add -> stage -> label, each on the
    // real returned url/itemId/number from a committed createIssue.
    const issue = await engine.createIssue(task.title, body, { labels: [] });
    const issueUrl = issue.url ?? null;
    const issueNumber = issue.number ?? null;

    const item = await engine.addIssueToBoard(issueUrl, {});
    const itemId = item.itemId ?? null;

    await engine.setStage(itemId, lane, {});
    await engine.setLabels(issueNumber, [label], {});

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

  if (staged) {
    // STAGED PREVIEW (create chain) — same fix as put: there is NO real issue in
    // staged mode, so we preview the create-chain from the INPUTS and call only
    // createIssue (its stagedGuard previews + validates). We do NOT chain
    // addIssueToBoard/setStage/setLabels on a nonexistent issue.
    await engine.createIssue(child.title, body, { labels: [], staged });
    const say = `Would file follow-up '${child.title}' (Claude's queue).`;
    return { created: { number: null, url: null, owner }, committed: false, say };
  }

  // COMMIT PATH — same chain as put on the real returned url/itemId/number.
  const issue = await engine.createIssue(child.title, body, { labels: [] });
  const issueUrl = issue.url ?? null;
  const number = issue.number ?? null;

  const item = await engine.addIssueToBoard(issueUrl, {});
  const itemId = item.itemId ?? null;

  await engine.setStage(itemId, lane, {});
  await engine.setLabels(number, [label], {});

  const say = `Filed follow-up #${number} '${child.title}'.`;
  return { created: { number, url: issueUrl, owner }, committed: true, say };
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
 * bootstrap(ctx) — Tier-1: provision a real board from the current repo.
 * Idempotent: resumes from ctx.existingConfig (partial board.json) and adopts an
 * existing same-title project / Stage field instead of duplicating. Approval-gated
 * via ctx.staged (staged previews the whole plan and writes nothing).
 *
 * @param {object} ctx { engine, staged, dir, detectRepo, writeConfig, preset?, title?, existingConfig? }
 * @returns {Promise<{committed:boolean, staged?:boolean, plan?:object, config?:object, say:string}>}
 */
export async function bootstrap(ctx) {
  const { engine, staged, dir } = ctx;
  const detectRepo = ctx.detectRepo;
  const writeConfig = ctx.writeConfig;
  const presetName = ctx.preset || 'build';
  const routing = { agent: 'agent:go', human: 'needs-claude' };

  const repo = await detectRepo();
  const repoSlug = repo.nameWithOwner || `${repo.owner}/${repo.repo}`;
  const preset = await loadPreset(presetName);
  const lanes = laneNames(preset);
  const projectTitle = ctx.title || `${repo.repo} board`;

  if (staged) {
    const plan = { op: 'bootstrap', repo: repoSlug, projectTitle, lanes, labels: [routing.agent, routing.human] };
    const say = `Would bootstrap board "${projectTitle}" on ${repoSlug}: ${lanes.length} lanes [${lanes.join(', ')}], labels [${routing.agent}, ${routing.human}]. After commit, set the board view to group by Stage (browser-only).`;
    return { committed: false, staged: true, plan, say };
  }

  // COMMIT — write-as-you-go; resume from a partial existing config.
  const cfg = { ...(ctx.existingConfig || {}) };
  cfg.owner = repo.owner;
  cfg.repo = repoSlug;
  cfg.preset = presetName;
  cfg.routing = routing;

  const ownerInfo = await engine.getOwnerId(repo.owner);
  cfg.ownerType = ownerInfo.ownerType;

  // Project: reuse partial config -> else adopt same-title -> else create.
  if (!cfg.projectId) {
    const found = await engine.findProjectByTitle(repo.owner, ownerInfo.ownerType, projectTitle);
    const proj = found || await engine.createProject(ownerInfo.ownerId, projectTitle, {});
    cfg.projectId = proj.projectId;
    cfg.projectNumber = proj.projectNumber;
    cfg.projectUrl = proj.url;
  }

  // Stage field: reuse partial config -> else adopt existing -> else create.
  if (!cfg.stageFieldId) {
    const found = await engine.findStageFieldByName(cfg.projectId, 'Stage');
    const field = found || await engine.createStageField(cfg.projectId, lanes, {});
    cfg.stageFieldId = field.stageFieldId;
    cfg.stageOptions = Object.fromEntries(field.options.map((o) => [o.label, o.optionId]));
  }

  cfg.pushPolicy = cfg.pushPolicy || 'on-approval';
  cfg.pullCadence = cfg.pullCadence || 'session-start';

  // Persist the complete binding ONCE. writeBoardConfig requires the full shape,
  // so there is no partial/checkpoint file. Resumability after a mid-provision
  // failure comes from two places instead: (i) a complete board.json passed back
  // as ctx.existingConfig on a re-run, and (ii) the adopt-by-title path above
  // (findProjectByTitle / findStageFieldByName), which rediscovers the
  // already-created project/field on GitHub even if no local board.json survived.
  await writeConfig(cfg);

  await engine.ensureLabels(cfg.repo, [routing.agent, routing.human], {});

  if (dir) {
    await setIntent(dir, { wantsBoard: true, boundBoard: { projectNumber: cfg.projectNumber, projectUrl: cfg.projectUrl } });
  }

  const say = `Bootstrapped board "${projectTitle}" (#${cfg.projectNumber}) on ${cfg.repo} with ${lanes.length} lanes. One manual step remains: open the project and set the board view to group by Stage. Then run doctor.`;
  return { committed: true, config: cfg, say };
}

/**
 * ledger(action, arg, ctx) — inspect/append the Tier-0 intent ledger.
 * @param {'show'|'add'} action
 * @param {string|null} arg  candidate title (for 'add')
 * @param {object} ctx { dir, source? }
 * @returns {Promise<{say:string, ledger:object}>}
 */
export async function ledger(action, arg, ctx) {
  const dir = ctx.dir || process.cwd();
  if (action === 'add') {
    if (!arg) throw new Error('usage: ledger add "<title>"');
    const updated = await appendCandidate(dir, { title: arg, source: ctx.source || 'manual' });
    return { say: `Added candidate "${arg}" (${updated.candidates.length} total in the ledger).`, ledger: updated };
  }
  const l = (await readLedger(dir)) || await ensureLedger(dir);
  const n = l.candidates.length;
  const bound = l.intent.boundBoard ? `bound to project #${l.intent.boundBoard.projectNumber}` : 'no board bound';
  return { say: `Ledger: ${n} candidate(s), ${bound}.`, ledger: l };
}

/**
 * mapPrepare(ctx) — build the LLM mapper's input packet from the ledger + config.
 * @param {object} ctx { dir, config, session? }
 * @returns {Promise<object>} the input packet (see lib/mapper.prepareInput)
 */
export async function mapPrepare(ctx) {
  const dir = ctx.dir || process.cwd();
  // Read-only: never create a ledger file as a side effect of "prepare".
  // prepareInput tolerates a null/empty ledger (Task 2 test).
  const ledger = (await readLedger(dir)) || { candidates: [] };
  return prepareInput(ledger, ctx.config, ctx.session || null);
}

/**
 * mapRecord(ctx) — validate the mapper's proposals, enrich the ledger, persist,
 * and return { report, questions }. Never touches the board.
 * @param {object} ctx { dir, config, proposals }
 */
export async function mapRecord(ctx) {
  const dir = ctx.dir || process.cwd();
  const ledger = (await readLedger(dir)) || (await ensureLedger(dir));
  const { ledger: enriched, report, questions } = applyProposals(ledger, ctx.proposals || [], ctx.config);
  await writeLedger(dir, enriched);
  const n = report.mapped.length + report.comments.length + report.split.length;
  const say = `Processed ${n} candidate(s): ${report.mapped.length} card(s), ${report.comments.length} comment(s), ${report.split.length} split parent(s). ` +
    `${report.merged.length} merged, ${report.skipped.length} skipped, ${report.needsDecision.length} need a decision, ${report.rejected.length} rejected.`;
  return { report, questions, say };
}

/**
 * bodyFor — issue body for a promoted card: the candidate note (if any) followed
 * by the durable candidateId marker.
 * @param {object} cand  the ledger candidate
 * @param {string} cid   candidateId
 * @returns {string}
 */
function bodyFor(cand, cid) {
  const note = cand && cand.note ? String(cand.note).trim() : '';
  return note ? `${note}\n\n${cidMarker(cid)}` : cidMarker(cid);
}

// ===========================================================================
// M3b SYNC — fs side. The pure logic lives in lib/sources.mjs; these helpers
// do the only fs work: presence checks, watch-glob expansion, content hashing.
// ===========================================================================

/**
 * Which profile detect dirs exist under `dir`? (Input to detectProfiles.)
 * @param {string} dir
 * @returns {string[]} repo-relative dirs present
 */
export function presentDetectDirs(dir) {
  return PROFILES
    .filter((p) => p.detect !== null && existsSync(join(dir, p.detect)))
    .map((p) => p.detect);
}

/** Recursive file walk. Missing dir -> []. */
async function walkFiles(base) {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    // ENOENT (missing dir) -> ok; other errors (EACCES) -> subtree skipped silently
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = join(base, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Expand watch patterns to repo-relative POSIX paths (deduped, sorted).
 * Only `<base>/**\/*.<ext>` and bare literal paths are supported; other glob
 * forms are handled two ways: patterns containing "*" that don't fit the glob
 * shape are ignored; "*"-less glob-ish patterns ("?", "{...}") fall through to
 * the literal branch and simply match no real file (never throw).
 * @param {string} dir       repo root
 * @param {string[]} patterns
 * @returns {Promise<string[]>}
 */
export async function expandWatch(dir, patterns) {
  const found = [];
  for (const pattern of patterns || []) {
    if (typeof pattern !== 'string') continue;
    const m = WATCH_GLOB_RE.exec(pattern);
    if (m) {
      const ext = m[2];
      for (const f of await walkFiles(join(dir, m[1]))) {
        if (f.endsWith(ext)) found.push(f);
      }
    } else if (!pattern.includes('*')) {
      try {
        const s = await stat(join(dir, pattern));
        if (s.isFile()) found.push(join(dir, pattern));
      } catch { /* missing literal -> skip */ }
    }
    // other glob forms: unsupported -> match nothing
  }
  const rel = found.map((f) => relative(dir, f).replace(/\\/g, '/'));
  return [...new Set(rel)].sort();
}

/**
 * Hash every watched file's content. First-match-wins profile attribution
 * (profiles arrive in PROFILES order — specific first, generic last).
 * @param {string} dir
 * @param {object[]} profiles  detectProfiles output
 * @param {{maxFiles?:number}} [opts]  cap on watched-file count (throws when exceeded; hashing never starts)
 * @returns {Promise<Record<string,{hash:string,profile:string}>>}
 */
export async function hashWatched(dir, profiles, opts = {}) {
  const attributed = [];
  const seen = new Set();
  for (const profile of profiles || []) {
    for (const path of await expandWatch(dir, profile.watch)) {
      if (seen.has(path)) continue; // already attributed to an earlier (more specific) profile
      seen.add(path);
      attributed.push({ path, profile: profile.name });
    }
  }
  const max = opts.maxFiles ?? Infinity;
  if (attributed.length > max) {
    throw new Error(`hashWatched: ${attributed.length} watched file(s) exceeds cap ${max}`);
  }
  const out = {};
  for (const { path, profile } of attributed) {
    const text = await readFile(join(dir, path), 'utf8').catch(() => null);
    if (text === null) continue; // vanished between walk and read -> skip
    out[path] = { hash: contentHash(text), profile };
  }
  return out;
}

/**
 * syncScan(ctx) — what changed in the watched source files since the last sync?
 * READ-ONLY: no ledger writes (never even creates one), no board, no LLM.
 * The returned manifest is the packet Claude extracts from (lib/sources.buildManifest).
 * @param {object} ctx { dir, config? }  config = RAW board.json or null (sources block only)
 *   ctx.maxFiles? — watched-file cap (throws; used by the SessionStart hook to bound session-start cost)
 * @returns {Promise<{manifest:object, say:string}>}
 */
export async function syncScan(ctx) {
  const dir = ctx.dir || process.cwd();
  const profiles = detectProfiles(presentDetectDirs(dir), ctx.config || null);
  // Unsupported/invalid watch patterns are surfaced, not silently swallowed.
  const ignoredPatterns = [];
  for (const p of profiles) {
    for (const pat of p.watch) {
      if (typeof pat !== 'string' || (pat.includes('*') && !WATCH_GLOB_RE.test(pat))) {
        ignoredPatterns.push({ profile: p.name, pattern: String(pat) });
      }
    }
  }
  const currentHashes = await hashWatched(dir, profiles, { maxFiles: ctx.maxFiles });
  const ledger = await readLedger(dir); // null is fine — first scan
  const { changed, unchanged } = diffSources(currentHashes, (ledger && ledger.sources) || null);
  const manifest = buildManifest(changed, profiles);
  let say = changed.length
    ? `Sync scan: ${changed.length} changed source file(s) across ${manifest.profiles.length} profile(s); ${unchanged.length} unchanged.`
    : `Sync scan: all sources unchanged (${unchanged.length} file(s) watched).`;
  if (ignoredPatterns.length) {
    manifest.ignoredPatterns = ignoredPatterns;
    say += ` ${ignoredPatterns.length} unsupported watch pattern(s) ignored.`;
  }
  return { manifest, say };
}

/**
 * syncRecord(ctx) — record the LLM's extraction into the ledger, fail-closed.
 *
 * - Refuses the WHOLE run (zero appends, no ledger created) on any structurally
 *   invalid item.
 * - done:true items -> skippedDone (never appended; ledger collects intent).
 * - Appends via appendCandidate -> content-hash candidateId dedup (re-recording
 *   the same extraction is a no-op; report.deduped).
 * - AFTER all appends succeed, re-hashes every watched file and settles
 *   ledger.sources (coverage-gated — next bullet). A covered file edited
 *   BETWEEN scan and record is marked synced unread — narrow accepted window,
 *   same class as M3a's create->persist gap; the next edit re-flags it.
 * - Coverage-gated settlement: a changed file with NO extraction item naming it
 *   (live or done) keeps its old hash state -> stays flagged, reported in
 *   report.uncovered. A changed file whose items are all done:true IS covered
 *   (the done items name it) and settles.
 *
 * @param {object} ctx { dir, config?, extracted }  extracted = parsed extraction JSON
 * @returns {Promise<{report:object, say:string}>}
 */
export async function syncRecord(ctx) {
  const dir = ctx.dir || process.cwd();
  const { valid, skippedDone, errors } = validateExtraction(ctx.extracted);
  if (errors.length) {
    throw new Error(`sync: refused — ${errors.length} invalid extraction item(s): ` +
      errors.map((e) => `${e.index ?? '?'}: ${e.error}`).join('; '));
  }

  // Append (dedup by content-hash id). ensureLedger only AFTER validation passes.
  await ensureLedger(dir);
  const added = [];
  const deduped = [];
  for (const item of valid) {
    const id = candidateId(item.title);
    const before = await readLedger(dir);
    if (before.candidates.some((c) => c.id === id)) {
      deduped.push({ candidateId: id, title: item.title });
      continue;
    }
    await appendCandidate(dir, { title: item.title, note: item.note, source: item.source });
    added.push({ candidateId: id, title: item.title, source: item.source });
  }

  // Persist-after-success, coverage-gated: settle a file's hash only if the
  // extraction spoke for it (any item — live or done — whose source names it)
  // or it was already settled at this hash. A changed file the extraction did
  // NOT cover stays flagged (fail-closed) and is reported as `uncovered` — the
  // next scan re-flags it rather than silently losing its work items.
  const coveredFiles = new Set(
    [...valid, ...skippedDone]
      .map((it) => String(it.source).split('#')[0].trim())
      .filter(Boolean),
  );
  const profiles = detectProfiles(presentDetectDirs(dir), ctx.config || null);
  const currentHashes = await hashWatched(dir, profiles);
  const ledger = await readLedger(dir);
  ledger.sources = ledger.sources || {};
  const syncedAt = new Date().toISOString();
  const uncovered = [];
  for (const [path, info] of Object.entries(currentHashes)) {
    const prior = ledger.sources[path];
    const unchanged = prior && prior.hash === info.hash;
    if (unchanged || coveredFiles.has(path)) {
      ledger.sources[path] = { hash: info.hash, syncedAt: unchanged ? prior.syncedAt : syncedAt, profile: info.profile };
    } else {
      uncovered.push(path);
    }
  }
  await writeLedger(dir, ledger);

  const report = { added, deduped, skippedDone, uncovered, errors: [] };
  let say = `Sync: added ${added.length} candidate(s); ${deduped.length} deduped, ${skippedDone.length} done item(s) skipped.`;
  if (uncovered.length) say += ` ${uncovered.length} changed file(s) not covered by the extraction — still flagged.`;
  return { report, say };
}

// ===========================================================================
// M4a RECONCILE — drift detection (scan) + ledger-only healing (apply).
// The board is NEVER written here; board mutations stay promote's job.
// ===========================================================================

/**
 * reconcileScan(ctx) — classify drift between the ledger, the live board, and
 * the source files. READ-ONLY (one live board read; zero writes). A failing
 * board read throws loudly — this is a user-invoked verb, and silent
 * degradation would fake a clean bill of health.
 * @param {object} ctx { engine, config, dir, sourceExists? }
 * @returns {Promise<{drift:object, say:string}>}
 */
export async function reconcileScan(ctx) {
  const dir = ctx.dir || process.cwd();
  const ledger = (await readLedger(dir)) || { candidates: [] };
  const { items } = await ctx.engine.listItemsWithBodies();
  const sourceExists = ctx.sourceExists || ((p) => existsSync(join(dir, p)));
  const drift = classifyDrift({ ledger, items, sourceExists });
  let say = drift.clean
    ? 'Reconcile scan: clean — ledger and board agree.'
    : `Reconcile scan: ${drift.safeHeals.length} safe heal(s), ${drift.uncertain.length} need a decision, ${drift.duplicates.length} duplicate marker group(s).`;
  if (drift.resumePending.length) {
    say += ` ${drift.resumePending.length} resume-pending — run 'promote apply' to finish their chains.`;
  }
  return { drift, say };
}

/**
 * reconcileApply(decisions, ctx) — heal drift, LEDGER-ONLY (the board is never
 * written; a re-promoted candidate re-enters promote's pipeline, which does the
 * board work later). Fail-closed: any bad decision refuses the whole run before
 * a single write. Persist after each item (resumable). Heals are
 * self-extinguishing — a re-scan after apply is clean (only 'keep' items
 * intentionally resurface on later scans).
 * @param {object|null} decisions { [candidateId]: { action } }
 * @param {object} ctx { engine, config, dir, sourceExists? }
 * @returns {Promise<{report:object, say:string}>}
 */
export async function reconcileApply(decisions, ctx) {
  if (ctx.staged) {
    throw new Error("reconcile: 'reconcile scan' IS the preview — apply writes only the ledger and has no --staged mode.");
  }
  const dir = ctx.dir || process.cwd();
  const { drift } = await reconcileScan(ctx);
  const { toApply, held, errors } = resolveReconcileDecisions(drift, decisions);
  if (errors.length) {
    throw new Error(`reconcile: refused — ${errors.length} bad decision(s): ` +
      errors.map((e) => `${e.candidateId}: ${e.error}`).join('; '));
  }

  const ledger = (await readLedger(dir)) || (await ensureLedger(dir));
  const byId = new Map((ledger.candidates || []).map((c) => [c.id, c]));
  const report = {
    healed: [], adopted: [], reset: [], dismissed: [], kept: [],
    held: held.map((h) => h.candidateId),
    duplicates: drift.duplicates,
    resumePending: drift.resumePending,
    errors: [],
  };

  for (const a of toApply) {
    const cand = byId.get(a.candidateId);
    if (a.action === 'settle') {
      if (!cand) continue; // raced away between scan and apply — next scan re-flags
      cand.status = 'promoted';
      cand.promotion = { ...a.refs };
      await writeLedger(dir, ledger);
      report.healed.push({ candidateId: a.candidateId, issueNumber: a.refs.issueNumber });
    } else if (a.action === 'adopt') {
      if (cand) continue; // already adopted (re-run) — nothing to do
      const adopted = {
        id: a.candidateId, title: a.title || '(adopted from board)', note: '',
        source: 'reconcile:adopted', suggestedLane: null, suggestedOwner: null,
        addedAt: new Date().toISOString(), status: 'promoted', promotion: { ...a.refs },
      };
      ledger.candidates.push(adopted);
      byId.set(adopted.id, adopted);
      await writeLedger(dir, ledger);
      report.adopted.push({ candidateId: a.candidateId, issueNumber: a.refs.issueNumber });
    } else if (a.action === 're-promote') {
      if (!cand) continue;
      cand.status = 'mapped';
      delete cand.promotion;
      await writeLedger(dir, ledger);
      report.reset.push({ candidateId: a.candidateId });
    } else if (a.action === 'dismiss') {
      if (!cand) continue;
      cand.status = 'dismissed';
      await writeLedger(dir, ledger);
      report.dismissed.push({ candidateId: a.candidateId });
    } else if (a.action === 'keep') {
      report.kept.push({ candidateId: a.candidateId }); // untouched; resurfaces next scan
    }
  }

  const say = `Reconcile: ${report.healed.length} healed, ${report.adopted.length} adopted, ` +
    `${report.reset.length} reset for re-promotion, ${report.dismissed.length} dismissed, ` +
    `${report.kept.length} kept, ${report.held.length} held` +
    (report.duplicates.length ? `, ${report.duplicates.length} duplicate group(s) reported` : '') +
    (report.resumePending.length ? `, ${report.resumePending.length} resume-pending (promote's job)` : '') +
    '.';
  return { report, say };
}

/**
 * promotePlan(ctx) — classify the ledger's mapped/needs-decision candidates into
 * promotion buckets. Read-only (no board, no ledger writes).
 * @param {object} ctx { dir, config }
 * @returns {Promise<{plan:object, say:string}>}
 */
export async function promotePlan(ctx) {
  const dir = ctx.dir || process.cwd();
  const ledger = (await readLedger(dir)) || { candidates: [] };
  const plan = classify(ledger, ctx.config);
  const say = `Promotion plan: ${plan.confident.length} confident card(s), ${plan.comments.length} comment(s) ready; ` +
    `${plan.uncertain.length} need a decision; ${plan.skipped.length} skipped.`;
  return { plan, say };
}

/**
 * promoteApply(decisions, ctx) — commit the resolved promotion set to the board,
 * updating the ledger per-candidate (resumable) and stamping the candidateId
 * marker into each issue body.
 *
 * - --staged: preview only (createIssue/comment with staged:true), zero board AND
 *   zero ledger writes (mirrors put --staged: no real issue exists, so the
 *   downstream chain is NOT run on a null url/itemId).
 * - pushPolicy=manual: refuses to commit (use --staged to preview).
 * - Idempotent: a candidate already 'promoted' is skipped (never a second issue).
 * - Resumable: a 'partial' candidate (createIssue done, later step failed) carries
 *   cand.promotion refs; a re-run skips createIssue and resumes the chain. No live
 *   board read — resumability is ledger-only.
 *
 * @param {object|null} decisions { [candidateId]: {action,lane?,owner?} }
 * @param {object} ctx { engine, config, staged, dir }
 * @returns {Promise<{report:object, say:string}>}
 */
export async function promoteApply(decisions, ctx) {
  const { engine, config, staged } = ctx;
  const dir = ctx.dir || process.cwd();

  const policy = config.pushPolicy || 'auto-low-risk';
  if (policy === 'manual' && !staged) {
    throw new Error("promote: pushPolicy is 'manual' — run with --staged to preview; committing is disabled.");
  }

  const ledger = (await readLedger(dir)) || { candidates: [] };
  const plan = classify(ledger, config);
  const { toCommit, held, errors } = resolveDecisions(plan, decisions);
  if (errors.length) {
    throw new Error(`promote: refused — ${errors.length} bad decision(s): ` +
      errors.map((e) => `${e.candidateId}: ${e.error}`).join('; '));
  }

  const byId = new Map((ledger.candidates || []).map((c) => [c.id, c]));
  // report.partial = commit-path errors (side effects may have partially landed);
  // report.failed  = staged-preview errors (no side effects). held/skipped per resolveDecisions/classify.
  const report = {
    promoted: [], partial: [], failed: [],
    held: held.map((h) => h.candidateId),
    skipped: [...plan.skipped],
    wouldCreate: [], wouldComment: [],
  };

  for (const item of toCommit) {
    const cand = byId.get(item.candidateId);
    if (cand && cand.status === 'promoted') {
      report.skipped.push({ candidateId: item.candidateId, reason: 'already promoted' });
      continue;
    }

    if (staged) {
      // PREVIEW ONLY — no board writes, no ledger writes.
      try {
        if (item.kind === 'comment') {
          await engine.comment(item.commentTarget, item.text, { staged });
          report.wouldComment.push({ candidateId: item.candidateId, target: item.commentTarget });
        } else {
          await engine.createIssue(item.title, bodyFor(cand, item.candidateId), { labels: [], staged });
          report.wouldCreate.push({ candidateId: item.candidateId, title: item.title, lane: item.lane, owner: item.owner });
        }
      } catch (e) {
        report.failed.push({ candidateId: item.candidateId, error: e.message });
      }
      continue;
    }

    // COMMIT
    try {
      if (item.kind === 'comment') {
        await engine.comment(item.commentTarget, item.text, {});
        cand.status = 'promoted';
        cand.promotion = { commentTarget: item.commentTarget };
        await writeLedger(dir, ledger);
        report.promoted.push({ candidateId: item.candidateId, commentTarget: item.commentTarget });
        continue;
      }

      // card — resumable create -> add -> stage -> label chain.
      let prom = cand.promotion || null;
      if (!prom || !prom.issueNumber) {
        const issue = await engine.createIssue(item.title, bodyFor(cand, item.candidateId), { labels: [] });
        prom = { issueNumber: issue.number ?? null, issueUrl: issue.url ?? null, issueNodeId: issue.issueNodeId ?? null };
        cand.promotion = prom;
        await writeLedger(dir, ledger); // persist after create
      }
      if (!prom.itemId) {
        const it = await engine.addIssueToBoard(prom.issueUrl, {});
        prom.itemId = it.itemId ?? null;
        cand.promotion = prom; // no-op when resuming (same ref); meaningful on the fresh-create branch
        await writeLedger(dir, ledger); // persist after board-add
      }
      // setStage/setLabels are idempotent (set-to-value / add-label), so unlike
      // createIssue/addIssueToBoard they need no resume guard — re-running them
      // on a resumed partial is safe and a no-op.
      await engine.setStage(prom.itemId, item.lane, {});
      await engine.setLabels(prom.issueNumber, [config.routing[item.owner]], {});
      cand.status = 'promoted';
      await writeLedger(dir, ledger);
      report.promoted.push({ candidateId: item.candidateId, issueNumber: prom.issueNumber, issueUrl: prom.issueUrl, itemId: prom.itemId });
    } catch (e) {
      report.partial.push({ candidateId: item.candidateId, error: e.message, promotion: (byId.get(item.candidateId) || {}).promotion || null });
    }
  }

  const say = staged
    ? `Would promote: ${report.wouldCreate.length} card(s), ${report.wouldComment.length} comment(s); ${report.held.length} held, ${report.skipped.length} skipped. (staged — nothing written.)`
    : `Promoted ${report.promoted.length} item(s); ${report.partial.length} partial, ${report.held.length} held, ${report.skipped.length} skipped, ${report.failed.length} failed.`;
  return { report, say };
}

// ===========================================================================
// M4b SNAPSHOTS — versioned board memory: take/list/diff + the event log.
// Read-only toward the board; owns nothing but .github-boards/snapshots/.
// ===========================================================================

/**
 * snapshotTake(label, ctx) — manual save-point. Same dedup/prune/log as the
 * summary piggyback. Loud on failure (user-invoked).
 * @param {string|null} label
 * @param {object} ctx { engine, config, dir }
 * @returns {Promise<{result:object, say:string}>}
 */
export async function snapshotTake(label, ctx) {
  const dir = ctx.dir || process.cwd();
  const { items } = await ctx.engine.listItems();
  const r = await writeSnapshot(dir, items || [], { label: label || null, keep: resolveKeep(ctx.config) });
  const say = r.skipped
    ? `Snapshot skipped — ${r.reason}.`
    : `Snapshot saved: ${(items || []).length} card(s)${label ? ` ("${label}")` : ''}.`;
  return { result: r, say };
}

/**
 * snapshotList(ctx) — newest-first index of stored snapshots. fs-only.
 * @param {object} ctx { dir }
 * @returns {Promise<{snapshots:object[], say:string}>}
 */
export async function snapshotList(ctx) {
  const dir = ctx.dir || process.cwd();
  const snapshots = await listSnapshots(dir);
  const say = snapshots.length
    ? `${snapshots.length} snapshot(s); newest ${snapshots[0].takenAt}${snapshots[0].label ? ` ("${snapshots[0].label}")` : ''}.`
    : 'No snapshots yet — run summary or `snapshot take` first.';
  return { snapshots, say };
}

/**
 * snapshotDiff(refA, refB, ctx) — pure diff between two snapshots, or between
 * a snapshot and the LIVE board when refB is null (one listItems read).
 * @param {string} refA
 * @param {string|null} refB
 * @param {object} ctx { engine, config, dir }
 * @returns {Promise<{diff:object, say:string}>}
 */
export async function snapshotDiff(refA, refB, ctx) {
  const dir = ctx.dir || process.cwd();
  const a = await readSnapshot(dir, refA);
  let bItems;
  let bName;
  if (refB) {
    const b = await readSnapshot(dir, refB);
    bItems = b.items;
    bName = b.takenAt;
  } else {
    const { items } = await ctx.engine.listItems();
    bItems = items || [];
    bName = 'live board';
  }
  const d = diffSnapshots(a.items, bItems);
  const total = d.moved.length + d.added.length + d.removed.length + d.relabeled.length + d.retitled.length;
  const say = total === 0
    ? `No changes between ${a.takenAt} and ${bName}.`
    : `Since ${a.takenAt} (vs ${bName}): ${d.moved.length} moved, ${d.added.length} added, ` +
      `${d.removed.length} removed, ${d.relabeled.length} relabeled, ${d.retitled.length} retitled.`;
  return { diff: d, say };
}

/**
 * snapshotLog(n, ctx) — the last n events from the permanent journal. fs-only.
 * @param {number} n
 * @param {object} ctx { dir }
 * @returns {Promise<{entries:object[], skippedLines:number, say:string}>}
 */
export async function snapshotLog(n, ctx) {
  const dir = ctx.dir || process.cwd();
  const { entries, skippedLines } = await readLog(dir, n);
  const say = entries.length
    ? `${entries.length} event(s)${skippedLines ? ` (${skippedLines} corrupted line(s) skipped)` : ''}.`
    : 'No events recorded yet.';
  return { entries, skippedLines, say };
}

/**
 * snapshotInvert(refA, refB, ctx) — the undo plan: diff two points (refB null
 * -> live board, one listItems read) and invert it into executable ops + a
 * manual list. Read-only: PROPOSES; execution is the user-approved move/route
 * verbs (see references/undo-contract.md).
 * @param {string} refA
 * @param {string|null} refB
 * @param {object} ctx { engine, config, dir }
 * @returns {Promise<{ops:object[], manual:object[], say:string}>}
 */
export async function snapshotInvert(refA, refB, ctx) {
  const dir = ctx.dir || process.cwd();
  const a = await readSnapshot(dir, refA);
  let bItems;
  let bName;
  if (refB) {
    const b = await readSnapshot(dir, refB);
    bItems = b.items;
    bName = b.takenAt;
  } else {
    const { items } = await ctx.engine.listItems();
    bItems = items || [];
    bName = 'live board';
  }
  const inv = invertDiff(diffSnapshots(a.items, bItems), (ctx.config && ctx.config.routing) || null);
  const moves = inv.ops.filter((o) => o.op === 'move').length;
  const routes = inv.ops.filter((o) => o.op === 'route').length;
  let say;
  if (inv.ops.length === 0 && inv.manual.length === 0) {
    say = `Nothing to undo between ${a.takenAt} and ${bName}.`;
    if (!refB) {
      const snaps = await listSnapshots(dir);
      if (snaps.length > 1) {
        say += ' Note: summary auto-snapshots the current board, so the newest snapshot may already reflect these changes — run `snapshot list` and pick an older ref.';
      }
    }
  } else if (inv.ops.length === 0) {
    say = `No executable undo ops vs ${a.takenAt} — ${inv.manual.length} item(s) need manual attention.`;
  } else {
    say = `Undo plan vs ${a.takenAt} (vs ${bName}): ${inv.ops.length} op(s) (${moves} move(s), ${routes} reroute(s)); ${inv.manual.length} manual item(s). Execute via move/route after approval.`;
  }
  return { ops: inv.ops, manual: inv.manual, say };
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

  // 9. M4b: versioned snapshot + event log (non-fatal — history must never
  // break summary, and the session-start hook calls summary).
  let snapNote = '';
  try {
    await writeSnapshot(dir, items || [], { keep: resolveKeep(config) });
  } catch (e) {
    snapNote = ` (snapshot skipped: ${e.message})`;
  }
  say += snapNote;

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
    listItemsWithBodies: () => eng.listItems(cfg, { withBodies: true }),
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
    getOwnerId: (login) => eng.getOwnerId(login),
    findProjectByTitle: (login, ownerType, title) => eng.findProjectByTitle(login, ownerType, title),
    findStageFieldByName: (projectId, name) => eng.findStageFieldByName(projectId, name),
    createProject: (ownerId, title, opts = {}) => eng.createProject(flagsFor(opts), ownerId, title),
    createStageField: (projectId, lanes, opts = {}) => eng.createStageField(flagsFor(opts), projectId, lanes),
    ensureLabels: (repo, labels, opts = {}) => eng.ensureLabels(flagsFor(opts), repo, labels),
  };
}

/**
 * Minimal CLI arg parse: <verb> [--staged] [--config <path>] [verb args...]
 */
function parseCliArgs(argv) {
  const out = { verb: null, staged: false, config: null, preset: null, title: null, repo: null, session: null, proposals: null, decisions: null, extracted: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') out.staged = true;
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--preset') out.preset = argv[++i];
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--proposals') out.proposals = argv[++i];
    else if (a === '--decisions') out.decisions = argv[++i];
    else if (a === '--extracted') out.extracted = argv[++i];
    else if (!out.verb) out.verb = a;
    else out.rest.push(a);
  }
  return out;
}

async function cli() {
  const { verb, staged, config: configPath, preset, title, repo, session, proposals, decisions: decisionsPath, extracted, rest } = parseCliArgs(process.argv.slice(2));

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
  bootstrap [--preset build] [--title "..."] [--repo owner/name]  provision a board from the current repo
  ledger [add "<title>"]              show or append to the intent ledger
  map prepare [--session <file>]      build the LLM mapper input packet (needs a configured board)
  map record --proposals <file>       validate + record the mapper's proposals into the ledger
  promote plan                          classify mapped candidates into promotion buckets (read-only)
  promote apply [--decisions <file>]    promote confident + decided candidates to the board (idempotent)
  sync scan                             what changed in watched source files (read-only)
  sync record --extracted <file>        record the LLM's extracted work items into the ledger
  reconcile scan                        drift report: ledger vs board vs source files (read-only)
  reconcile apply [--decisions <file>]  heal drift — ledger-only writes (board untouched)
  snapshot take ["label"]               manual board save-point (dedup'd)
  snapshot list                         stored snapshots, newest first
  snapshot diff [<ref>] [<ref2>]        what changed between two points (defaults: latest vs live board)
  snapshot log [N]                      the permanent event journal (default last 20)
  snapshot invert [<ref>] [<ref2>]      the undo plan: inverse ops to restore a point (read-only)

  --staged          preview every write; nothing is committed
  --config <path>   board.json (default ../board.json via board.mjs)`);
    return;
  }

  // bootstrap + ledger run WITHOUT an existing board.json — bypass loadConfig.
  if (verb === 'ledger') {
    const action = rest[0] === 'add' ? 'add' : 'show';
    const arg = action === 'add' ? rest[1] : null;
    const result = await ledger(action, arg, { dir: process.cwd() });
    console.log(result.say);
    return;
  }
  if (verb === 'bootstrap') {
    const eng = await import('./board.mjs');
    const { writeBoardConfig } = await import('./lib/config-writer.mjs');
    const { detectRepo } = await import('./lib/repo-detect.mjs');
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');

    const boardPath = resolve(process.cwd(), 'board.json');
    let existingConfig = null;
    try { existingConfig = JSON.parse(await readFile(boardPath, 'utf8')); } catch { existingConfig = null; }

    // --repo owner/name overrides git-remote detection.
    const detect = repo
      ? () => { const [o, n] = repo.split('/'); return { owner: o, repo: n, nameWithOwner: repo }; }
      : detectRepo;

    // makeRealEngine(eng, {}) is safe here: bootstrap only calls the provisioning
    // ops, which ignore cfg. (The cfg-reading ops are never reached on this path.)
    const engine = makeRealEngine(eng, {});
    const result = await bootstrap({
      engine, staged, dir: process.cwd(),
      detectRepo: detect, writeConfig: (cfg) => writeBoardConfig(boardPath, cfg),
      preset: preset || 'build', title, existingConfig,
    });
    console.log(result.say);
    if (!staged) console.log(JSON.stringify(result, null, 2));
    return;
  }

  // sync runs WITHOUT an existing board.json (Tier-0): read board.json RAW if
  // present (only the optional `sources` block matters here) — never loadConfig.
  if (verb === 'sync') {
    const sub = rest[0];
    const { readFile: rf } = await import('node:fs/promises');
    const boardPath = configPath || join(process.cwd(), 'board.json');
    let rawCfg = null;
    try { rawCfg = JSON.parse(await rf(boardPath, 'utf8')); } catch { rawCfg = null; }
    if (sub === 'scan' || !sub) {
      const r = await syncScan({ dir: process.cwd(), config: rawCfg });
      console.log(r.say);
      console.log(JSON.stringify(r.manifest, null, 2));
      return;
    }
    if (sub === 'record') {
      if (!extracted) throw new Error('usage: sync record --extracted <path-to-extraction.json>');
      let items;
      try { items = JSON.parse(await rf(extracted, 'utf8')); }
      catch (e) { throw new Error(`sync: refused — could not read/parse extraction file '${extracted}': ${e.message}`); }
      const r = await syncRecord({ dir: process.cwd(), config: rawCfg, extracted: items });
      console.log(r.say);
      console.log(JSON.stringify(r.report, null, 2));
      return;
    }
    throw new Error('usage: sync <scan|record> [--extracted <file>]');
  }

  // snapshot list / log are fs-only (no engine, no board.json required) — bypass loadConfig.
  if (verb === 'snapshot') {
    const sub = rest[0];
    if (sub === 'list' || !sub) {
      const r = await snapshotList({ dir: process.cwd() });
      console.log(r.say);
      console.log(JSON.stringify(r.snapshots, null, 2));
      return;
    }
    if (sub === 'log') {
      const n = rest[1] ? Number(rest[1]) : 20;
      if (!Number.isInteger(n) || n < 1) throw new Error(`snapshot log: N must be a positive integer (got '${rest[1]}').`);
      const r = await snapshotLog(n, { dir: process.cwd() });
      console.log(r.say);
      console.log(JSON.stringify(r.entries, null, 2));
      return;
    }
    // take / diff need the engine — fall through to loadConfig below.
    // Unknown sub-verbs get a usage error here (before loadConfig) so an
    // unconfigured repo does not produce a confusing config-not-found error.
    if (sub !== 'take' && sub !== 'diff' && sub !== 'invert') {
      throw new Error('usage: snapshot <take ["label"] | list | diff [<ref>] [<ref2>] | invert [<ref>] [<ref2>] | log [N]>');
    }
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
    case 'map': {
      // `session` and `proposals` are the destructured flag values (Step 5 widened
      // the single top-of-cli() parseCliArgs destructure to include them).
      const sub = rest[0];
      const { readFile } = await import('node:fs/promises');
      if (sub === 'prepare') {
        // --session may be a file path or inline text; try as a file, fall back to literal.
        let sessionText = null;
        if (session) sessionText = await readFile(session, 'utf8').catch(() => session);
        const pkt = await mapPrepare({ dir: process.cwd(), config: verbCfg, session: sessionText });
        console.log(JSON.stringify(pkt, null, 2));
        return;
      } else if (sub === 'record') {
        if (!proposals) throw new Error('usage: map record --proposals <path-to-proposals.json>');
        const parsedProposals = JSON.parse(await readFile(proposals, 'utf8'));
        const r = await mapRecord({ dir: process.cwd(), config: verbCfg, proposals: parsedProposals });
        console.log(r.say);
        console.log(JSON.stringify({ report: r.report, questions: r.questions }, null, 2));
        return;
      } else {
        throw new Error('usage: map <prepare|record> [--session <file>] [--proposals <file>]');
      }
    }
    case 'promote': {
      const sub = rest[0];
      const { readFile } = await import('node:fs/promises');
      if (sub === 'plan' || !sub) {
        const r = await promotePlan({ dir: process.cwd(), config: verbCfg });
        console.log(r.say);
        console.log(JSON.stringify(r.plan, null, 2));
        return;
      } else if (sub === 'apply') {
        let decisions = null;
        if (decisionsPath) decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
        const r = await promoteApply(decisions, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.report, null, 2));
        return;
      } else {
        throw new Error('usage: promote <plan|apply> [--decisions <file>] [--staged]');
      }
    }
    case 'reconcile': {
      const sub = rest[0];
      const { readFile } = await import('node:fs/promises');
      if (sub === 'scan' || !sub) {
        const r = await reconcileScan({ ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.drift, null, 2));
        return;
      }
      if (sub === 'apply') {
        let d = null;
        if (decisionsPath) d = JSON.parse(await readFile(decisionsPath, 'utf8'));
        const r = await reconcileApply(d, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.report, null, 2));
        return;
      }
      throw new Error('usage: reconcile <scan|apply> [--decisions <file>]');
    }
    case 'snapshot': {
      const sub = rest[0];
      if (sub === 'take') {
        const r = await snapshotTake(rest[1] || null, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        return;
      }
      if (sub === 'diff') {
        const r = await snapshotDiff(rest[1] || 'latest', rest[2] || null, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify(r.diff, null, 2));
        return;
      }
      if (sub === 'invert') {
        const r = await snapshotInvert(rest[1] || 'latest', rest[2] || null, { ...ctx, dir: process.cwd() });
        console.log(r.say);
        console.log(JSON.stringify({ ops: r.ops, manual: r.manual }, null, 2));
        return;
      }
      // list, log, and unknown sub-verbs are handled in Tier-0 (above) and never reach here.
      throw new Error('usage: snapshot <take ["label"] | list | diff [<ref>] [<ref2>] | invert [<ref>] [<ref2>] | log [N]>');
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
