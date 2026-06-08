#!/usr/bin/env node
// board.mjs — the BoardConnection adapter (ghCli).
//
// A thin, mechanism-agnostic CLI implementing the BoardConnection contract from
// SPEC-CONNECTION.md (ADR-027). Cross-platform: it shells out to `gh` and
// `gh api graphql` only — `gh` + `node` ARE the portable runtime, so this one
// file runs anywhere (Windows, Linux Actions, macOS) with no PowerShell twin.
//
// Lanes are addressed by stable LABEL (resolved to optionId internally).
// The Stage FIELD is addressed by configured ID end-to-end, fail-closed.
//
// Usage:  node board.mjs <command> [args] [--config <path>] [--staged] [--json]
// Run     node board.mjs --help   for the command map.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { checkPresetCoverage } from "./lib/presets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default config lives at the repo root as board.json (one level up from scripts/).
const DEFAULT_CONFIG = resolve(__dirname, "..", "board.json");

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = { staged: false, json: false, config: null, labels: null, identity: "pat", interval: null, once: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staged") flags.staged = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--config") flags.config = argv[++i];
    else if (a === "--labels") flags.labels = argv[++i];
    else if (a === "--identity") flags.identity = argv[++i];
    else if (a === "--interval") flags.interval = argv[++i];
    else if (a === "--once") flags.once = true;
    else positional.push(a);
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// errors: a Refusal is an intentional fail-closed stop (distinct from a crash)
// ---------------------------------------------------------------------------
class Refusal extends Error {
  constructor(msg) { super(msg); this.name = "Refusal"; this.refusal = true; }
}

function loadConfig(path) {
  const p = path || DEFAULT_CONFIG;
  let raw;
  try { raw = readFileSync(p, "utf8"); }
  catch (e) { throw new Refusal(`config not found at ${p}: ${e.message}`); }
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { throw new Refusal(`config at ${p} is not valid JSON: ${e.message}`); }
  for (const k of ["owner", "projectNumber", "projectId", "repo", "stageFieldId", "stageOptions"]) {
    if (cfg[k] === undefined) throw new Refusal(`config missing required key '${k}'`);
  }
  // shape/type validation — a present-but-wrong key must fail-closed HERE with a
  // legible Refusal, not crash opaquely later (a string projectNumber dispatched
  // as -f against $num:Int!, a null stageOptions TypeError, a misrouted owner).
  if (typeof cfg.projectNumber !== "number")
    throw new Refusal(`config.projectNumber must be a number, got ${typeof cfg.projectNumber} (${JSON.stringify(cfg.projectNumber)})`);
  for (const k of ["owner", "projectId", "repo", "stageFieldId"]) {
    if (typeof cfg[k] !== "string" || cfg[k].trim() === "")
      throw new Refusal(`config.${k} must be a non-empty string`);
  }
  if (!/^[^/]+\/[^/]+$/.test(cfg.repo))
    throw new Refusal(`config.repo must be 'owner/name' (got ${JSON.stringify(cfg.repo)})`);
  if (cfg.stageOptions === null || typeof cfg.stageOptions !== "object" ||
      Array.isArray(cfg.stageOptions) || Object.keys(cfg.stageOptions).length === 0)
    throw new Refusal(`config.stageOptions must be a non-empty object of {label: optionId}`);
  if (cfg.ownerType !== undefined &&
      !["organization", "user"].includes(String(cfg.ownerType).toLowerCase()))
    throw new Refusal(`config.ownerType must be 'Organization' or 'User' (got ${JSON.stringify(cfg.ownerType)})`);
  cfg.__path = p;
  return cfg;
}

// ---------------------------------------------------------------------------
// shelling out to gh
// ---------------------------------------------------------------------------
function sh(args, { input } = {}) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (r.error) throw new Error(`failed to spawn gh: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(" ")}\n  exit ${r.status}\n  ${(r.stderr || r.stdout || "").trim()}`);
  }
  return (r.stdout || "").trim();
}

// gh api graphql -f query=... -f k=v -F k=intval ; returns parsed data
function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "number") args.push("-F", `${k}=${v}`);
    else args.push("-f", `${k}=${v}`);
  }
  const out = sh(args);
  const parsed = JSON.parse(out);
  if (parsed.errors) throw new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// staged-mode helper: every write routes through this. When --staged is set we
// print the exact mutation that WOULD run and execute nothing (Invariant 4).
// ---------------------------------------------------------------------------
function stagedGuard(flags, plan, runFn) {
  if (flags.staged) {
    return { staged: true, wouldRun: plan, note: "STAGED (dry-run): nothing was written." };
  }
  return runFn();
}

function print(flags, obj) {
  if (flags.json) { console.log(JSON.stringify(obj, null, 2)); return; }
  console.log(JSON.stringify(obj, null, 2));
}

// ===========================================================================
// UNDERSTAND
// ===========================================================================

// getStageField — fail-closed (Invariant 2). Resolve by configured id, assert
// name == "Stage", and assert NO OTHER single-select field is named "Stage".
// Refuse on a missing id or a name clash rather than guessing.
function getStageField(cfg, { force } = {}) {
  const ownerType = (cfg.ownerType || "Organization").toLowerCase();
  const ownerSel = ownerType === "user" ? "user" : "organization";
  const q = `
    query($login:String!, $num:Int!) {
      ${ownerSel}(login:$login) {
        projectV2(number:$num) {
          id
          fields(first:50) {
            nodes {
              __typename
              ... on ProjectV2SingleSelectField { id name options { id name } }
              ... on ProjectV2FieldCommon { id name }
            }
          }
        }
      }
    }`;
  const data = graphql(q, { login: cfg.owner, num: cfg.projectNumber });
  const proj = data[ownerSel]?.projectV2;
  if (!proj) throw new Refusal(`project #${cfg.projectNumber} not found for ${cfg.owner}`);

  const singleSelects = proj.fields.nodes.filter(
    (n) => n.__typename === "ProjectV2SingleSelectField"
  );

  // force === "name-only" simulates a name-matching adapter (gh-aw / MCP) that
  // resolves Stage by NAME. On a board that also carries a default "Status"
  // single-select this is the dangerous path; we use it to PROVE the contract
  // refuses to operate via name when the field cannot be addressed by id.
  if (force === "name-only") {
    const byName = singleSelects.filter((f) => f.name === "Stage");
    if (byName.length !== 1) {
      throw new Refusal(
        `name-only resolution is unsafe: found ${byName.length} single-select field(s) named "Stage" ` +
        `alongside ${singleSelects.length} single-select field(s) total ` +
        `(${singleSelects.map((f) => `${f.name}`).join(", ")}). ` +
        `Refusing to guess — address the Stage field by configured id instead.`
      );
    }
    // Even when exactly one is named Stage, a name-only adapter cannot prove it
    // matches the configured id; the contract mandates id-addressing, so refuse.
    throw new Refusal(
      `name-only resolution is forbidden by Invariant 2: a board carries a default ` +
      `"Status" single-select too, and name-matching adapters would silently write the ` +
      `wrong field. Resolve Stage by configured stageFieldId (${cfg.stageFieldId}).`
    );
  }

  // The mandated path: resolve by configured id.
  const byId = singleSelects.find((f) => f.id === cfg.stageFieldId);
  if (!byId) {
    throw new Refusal(
      `fail-closed: configured stageFieldId ${cfg.stageFieldId} is not present as a ` +
      `single-select field on project #${cfg.projectNumber}. Found single-selects: ` +
      `${singleSelects.map((f) => `${f.name}(${f.id})`).join(", ")}. Refusing to operate.`
    );
  }
  if (byId.name !== "Stage") {
    throw new Refusal(
      `fail-closed: field ${cfg.stageFieldId} is named "${byId.name}", expected "Stage". ` +
      `Refusing to operate on a misconfigured stageFieldId.`
    );
  }
  // Assert no OTHER single-select is also named "Stage" (ambiguity guard).
  const alsoStage = singleSelects.filter((f) => f.name === "Stage" && f.id !== cfg.stageFieldId);
  if (alsoStage.length > 0) {
    throw new Refusal(
      `fail-closed: ${alsoStage.length} OTHER single-select field(s) are also named "Stage" ` +
      `(${alsoStage.map((f) => f.id).join(", ")}). Name is ambiguous; refusing to operate.`
    );
  }

  return {
    fieldId: byId.id,
    fieldName: byId.name,
    options: byId.options.map((o) => ({ label: o.name, optionId: o.id })),
  };
}

// listItems — paginated GraphQL (Invariant: Invariant-5 / build-req 5).
// NEVER `gh project item-list --format json`.
function listItems(cfg, { pageSize = 50 } = {}) {
  const items = [];
  let cursor = null;
  // Stage is read by the CONFIGURED field id (match field.id === stageFieldId),
  // NOT by fieldValueByName("Stage"). This keeps the READ path id-addressed and
  // consistent with the WRITE path (setStage), honoring Invariant 2 — a board can
  // carry more than one single-select, and name-matching could read the wrong one.
  const q = `
    query($projectId:ID!, $first:Int!, $after:String) {
      node(id:$projectId) {
        ... on ProjectV2 {
          items(first:$first, after:$after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              fieldValues(first:20) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name optionId
                    field { ... on ProjectV2SingleSelectField { id } }
                  }
                }
              }
              content {
                __typename
                ... on Issue {
                  number title state
                  repository { nameWithOwner }
                  labels(first:20) { nodes { name } }
                }
                ... on DraftIssue { title }
              }
            }
          }
        }
      }
    }`;
  // pagination loop — exercises items(first:N, after:cursor)
  for (let guard = 0; guard < 1000; guard++) {
    const vars = { projectId: cfg.projectId, first: pageSize };
    if (cursor) vars.after = cursor;
    const data = graphql(q, vars);
    // fail-closed: a wrong/inaccessible projectId returns data.node:null with NO
    // errors array — distinguish that from a genuinely empty board so a
    // misconfigured read can't masquerade as "0 cards".
    if (guard === 0 && (!data.node || !data.node.items)) {
      throw new Refusal(
        `project node ${cfg.projectId} did not resolve to a ProjectV2 with items — ` +
        `check projectId and that the token can read the project ` +
        `(a default GITHUB_TOKEN cannot read Projects v2).`
      );
    }
    const conn = data.node?.items;
    if (!conn) break;
    for (const n of conn.nodes) {
      const c = n.content || {};
      const stageVal = (n.fieldValues?.nodes || []).find(
        (v) => v.__typename === "ProjectV2ItemFieldSingleSelectValue" && v.field?.id === cfg.stageFieldId
      );
      items.push({
        itemId: n.id,
        contentType: c.__typename || null,
        issueNumber: c.number ?? null,
        title: c.title ?? null,
        state: c.state ?? null,
        repo: c.repository?.nameWithOwner ?? null,
        stageLabel: stageVal?.name ?? null,
        labels: (c.labels?.nodes || []).map((l) => l.name),
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { items, count: items.length };
}

// getIssue — by GraphQL, returns node id + body + labels + state + comments.
function getIssue(cfg, owner, repo, number) {
  const q = `
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        issue(number:$num) {
          id number title body state
          labels(first:30) { nodes { name } }
          comments(first:30) { nodes { body author { login } createdAt } }
        }
      }
    }`;
  const data = graphql(q, { owner, repo, num: Number(number) });
  const iss = data.repository?.issue;
  if (!iss) throw new Refusal(`issue ${owner}/${repo}#${number} not found`);
  return {
    nodeId: iss.id,
    number: iss.number,
    title: iss.title,
    body: iss.body,
    state: iss.state,
    labels: iss.labels.nodes.map((l) => l.name),
    comments: iss.comments.nodes.map((c) => ({
      body: c.body, author: c.author?.login ?? null, createdAt: c.createdAt,
    })),
  };
}

// snapshot — combined UNDERSTAND read: stage field + items.
function snapshot(cfg) {
  const stageField = getStageField(cfg);
  const { items, count } = listItems(cfg);
  return {
    projectId: cfg.projectId,
    projectUrl: cfg.projectUrl || null,
    stageField,
    itemCount: count,
    items,
  };
}

// ===========================================================================
// MAKE
// ===========================================================================

// createIssue — REAL Issue via `gh issue create` (Invariant 1). Never drafts.
function createIssue(cfg, flags, title, body) {
  const [owner, repo] = cfg.repo.split("/");
  const labels = flags.labels ? flags.labels.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const ghArgs = ["issue", "create", "--repo", cfg.repo, "--title", title, "--body", body];
  for (const l of labels) ghArgs.push("--label", l);

  const plan = { op: "gh issue create", repo: cfg.repo, title, labels, body };
  return stagedGuard(flags, plan, () => {
    const url = sh(ghArgs); // gh prints the new issue URL
    const m = url.match(/\/issues\/(\d+)\s*$/);
    if (!m) throw new Error(`could not parse issue number from gh output: ${url}`);
    const number = Number(m[1]);
    // fetch the node id + assert content type is Issue (Invariant 1 proof)
    const iss = getIssue(cfg, owner, repo, number);
    return { issueNodeId: iss.nodeId, number, url: url.trim(), contentType: "Issue", labels: iss.labels };
  });
}

// addIssueToBoard — UPSERT via addProjectV2ItemById (idempotent). Real Issue only.
function addIssueToBoard(cfg, flags, issueUrl) {
  // resolve the issue node id from its url
  const m = issueUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!m) throw new Refusal(`not an issue url: ${issueUrl}`);
  const [, owner, repo, num] = m;
  const iss = getIssue(cfg, owner, repo, num);
  const plan = { op: "addProjectV2ItemById", projectId: cfg.projectId, contentId: iss.nodeId, issueUrl };
  return stagedGuard(flags, plan, () => {
    const q = `
      mutation($projectId:ID!, $contentId:ID!) {
        addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}) {
          item { id type content { __typename } }
        }
      }`;
    const data = graphql(q, { projectId: cfg.projectId, contentId: iss.nodeId });
    const item = data.addProjectV2ItemById.item;
    return {
      itemId: item.id,
      contentType: item.content?.__typename || item.type,
      upsert: true,
    };
  });
}

// setLabels — addLabelsToLabelable (labels are Issue props, NOT project fields).
function setLabels(cfg, flags, number, labelsCsv) {
  const num = Number(number);
  if (!Number.isInteger(num)) throw new Refusal(`set-labels: <number> must be an issue number, got "${number}"`);
  const labels = labelsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const plan = { op: "gh issue edit --add-label", repo: cfg.repo, number: num, labels };
  return stagedGuard(flags, plan, () => {
    const args = ["issue", "edit", String(num), "--repo", cfg.repo];
    for (const l of labels) args.push("--add-label", l);
    sh(args);
    return { number: num, addedLabels: labels };
  });
}

// removeLabels — removeLabelsFromLabelable via `gh issue edit --remove-label`.
// Additive sibling of setLabels (labels are Issue props, NOT project fields).
// Routed through the SAME stagedGuard, so a staged preview writes nothing.
function removeLabels(cfg, flags, number, labelsCsv) {
  const num = Number(number);
  if (!Number.isInteger(num)) throw new Refusal(`remove-labels: <number> must be an issue number, got "${number}"`);
  const labels = labelsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const plan = { op: "gh issue edit --remove-label", repo: cfg.repo, number: num, labels };
  return stagedGuard(flags, plan, () => {
    const args = ["issue", "edit", String(num), "--repo", cfg.repo];
    for (const l of labels) args.push("--remove-label", l);
    sh(args);
    return { number: num, removedLabels: labels };
  });
}

// comment — identity-aware (Invariant 5). asIdentity=pat (default) fine;
// asIdentity=actions WARNS the comment is inert for the 0.2 re-trigger loop.
function comment(cfg, flags, number, body) {
  const identity = flags.identity || "pat";
  if (identity !== "pat" && identity !== "actions")
    throw new Refusal(`unknown --identity '${identity}' (expected: pat | actions)`);
  const num = Number(number);
  if (!Number.isInteger(num)) throw new Refusal(`comment: <number> must be an issue number, got "${number}"`);

  // Invariant 5 is a TOKEN-LEVEL SEAM. `identity` records the INTENDED author.
  // In 0.1 authorship is NOT enforced — the comment is authored by whatever `gh`
  // is currently authed as — so we never emit an *enforced* re-trigger guarantee a
  // downstream 0.2 reply-loop could wrongly trust. `enforced:false` says exactly
  // that; real token-switching lands when GCA's own identity is provisioned (ADR-028).
  const warnings = [];
  if (identity === "actions") {
    warnings.push(
      "IDENTITY=actions: a comment authored by the Actions bot (GITHUB_TOKEN) is INERT for the " +
      "0.2 re-trigger loop — it will NOT re-fire issue-event automation. Author re-firing comments " +
      "under a PAT/App identity (ADR-028)."
    );
  } else {
    warnings.push(
      "IDENTITY=pat (intended, NOT enforced in 0.1): this comment is authored by whatever `gh` is " +
      "currently authed as. A guaranteed re-firing 0.2 comment requires a provisioned PAT/App identity " +
      "(ADR-028); verify `gh auth status` before relying on re-trigger."
    );
  }
  const meta = {
    number: num, identity,
    intendedReTrigger: identity === "pat",
    enforced: false, // 0.1 does not switch tokens; see ADR-028
    warnings,
  };
  const plan = { op: "gh issue comment", repo: cfg.repo, ...meta, body };
  return stagedGuard(flags, plan, () => {
    const url = sh(["issue", "comment", String(num), "--repo", cfg.repo, "--body", body]);
    return { ...meta, commentUrl: url.trim() };
  });
}

// ===========================================================================
// REGULATE
// ===========================================================================

// setStage — resolve stageLabel -> optionId from config; address Stage by the
// configured field id (fail-closed verified first); updateProjectV2ItemFieldValue.
function setStage(cfg, flags, itemId, stageLabel) {
  // fail-closed gate FIRST: confirm the configured Stage field is sound.
  const field = getStageField(cfg);
  // resolve label -> optionId from config (case-insensitive, partial allowed)
  const optionId = resolveStageOption(cfg, stageLabel);
  if (!optionId) {
    throw new Refusal(
      `unknown stage "${stageLabel}". Valid lanes: ${Object.keys(cfg.stageOptions).join(", ")}`
    );
  }
  // cross-check the config optionId against the LIVE field options (already
  // fetched above) so a stale board.json fails closed with a legible message
  // instead of an opaque API error at write time.
  if (!field.options.some((o) => o.optionId === optionId)) {
    throw new Refusal(
      `stage "${stageLabel}" resolves to optionId ${optionId}, which is NOT a live option on the ` +
      `Stage field. Live options: ${field.options.map((o) => `${o.label}(${o.optionId})`).join(", ")}. ` +
      `board.json stageOptions is stale — re-capture optionIds for this board.`
    );
  }
  const plan = {
    op: "updateProjectV2ItemFieldValue",
    projectId: cfg.projectId,
    itemId,
    fieldId: field.fieldId, // ALWAYS the configured id, never name
    singleSelectOptionId: optionId,
    stageLabel,
  };
  return stagedGuard(flags, plan, () => {
    // gh project item-edit with project-id + field-id + option-id (proven spike path)
    sh([
      "project", "item-edit",
      "--id", itemId,
      "--project-id", cfg.projectId,
      "--field-id", field.fieldId,
      "--single-select-option-id", optionId,
    ]);
    return { ok: true, itemId, stageLabel, fieldId: field.fieldId, optionId };
  });
}

function resolveStageOption(cfg, label) {
  if (cfg.stageOptions[label]) return cfg.stageOptions[label];
  const lc = label.toLowerCase();
  // exact case-insensitive
  for (const [k, v] of Object.entries(cfg.stageOptions)) {
    if (k.toLowerCase() === lc) return v;
  }
  // partial match (e.g. "reject" -> "Rejected (learnings kept)")
  const partial = Object.entries(cfg.stageOptions).filter(([k]) => k.toLowerCase().includes(lc));
  if (partial.length === 1) return partial[0][1];
  return null;
}

// ===========================================================================
// CROSS-CUTTING
// ===========================================================================

// capabilities — per-adapter feature + per-run limit map (Invariant 4 / build-req 4).
function capabilities(cfg) {
  return {
    adapter: "ghCli",
    spec: "SPEC-CONNECTION.md (ADR-027)",
    config: cfg.__path,
    features: {
      createRepo: true,
      createIssue: true,        // REAL Issue (Invariant 1), never draft
      addToBoard: true,         // upsert via addProjectV2ItemById
      setLabels: true,          // addLabelsToLabelable (Issue prop, not field)
      comment: true,            // identity-aware (Invariant 5)
      setStage: true,           // by configured field id, fail-closed (Invariant 2)
      pagedReads: true,         // items(first,after) GraphQL (Invariant 5)
      staged: true,             // dry-run preview (Invariant 4)
      identityAware: true,      // pat vs actions authoring identity
    },
    maxOpsPerRun: {
      // the gh adapter has NO per-run write caps.
      addComment: null, addLabels: null, updateProject: null, createIssue: null,
    },
    adapterNotes: {
      ghAw: {
        when: "0.2 governed write path (Actions-only, tech-preview, version-pinned)",
        maxOpsPerRun: { addComment: 1, addLabels: 3, updateProject: 10, createIssue: 1 },
        note: "per-run safe-output caps; never a single point of failure (ghCli stays the fallback).",
      },
      mcp: {
        when: "optional cheap READ adapter",
        requires: "projects_get needs fields:[ids] — without it returns titles only -> blank Stage -> mis-routed REGULATE.",
        note: "keep MCP READ-only; never let it own MAKE.",
      },
    },
    invariantsEnforced: [
      "1: cards are real Issues (createIssue -> addIssueToBoard; never drafts)",
      "2: Stage addressed by configured id, fail-closed on name ambiguity",
      "3: labels/comments via Issue mutations, never field updates",
      "4: every write is staged-previewable",
      "5: token write-capability != authoring identity",
    ],
  };
}

// runDoctor — cross-platform preflight (SPEC build-req 2). Verifies the portable
// runtime (node + gh + auth) and that THIS board is reachable with sound config,
// so setup failures are LEGIBLE on Windows / Linux Actions / macOS instead of an
// opaque spawn error. Collects ALL checks (never throws); sets exit 1 on any FAIL.
function runDoctor(flags) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  add("node", "PASS", `Node ${process.version} on ${process.platform}/${process.arch}`);

  let ghOk = false;
  const v = spawnSync("gh", ["--version"], { encoding: "utf8", shell: false });
  if (v.error)
    add("gh-installed", "FAIL", `gh CLI not found on PATH (${v.error.code || v.error.message}). ` +
      `Install GitHub CLI (https://cli.github.com). On Windows the winget/MSI build provides gh.exe, ` +
      `which Node spawns without a shell; a bare 'gh' shim may not resolve.`);
  else if (v.status !== 0) add("gh-installed", "FAIL", `\`gh --version\` exited ${v.status}`);
  else { ghOk = true; add("gh-installed", "PASS", (v.stdout || "").split("\n")[0].trim()); }

  if (ghOk) {
    const a = spawnSync("gh", ["auth", "status"], { encoding: "utf8", shell: false });
    const txt = ((a.stdout || "") + (a.stderr || "")).trim();
    if (a.status !== 0) add("gh-auth", "FAIL", `not authenticated — run \`gh auth login\`. ${txt.split("\n")[0] || ""}`);
    else add("gh-auth", "PASS", (txt.split("\n").find((l) => /Logged in/i.test(l)) || txt.split("\n")[0] || "authenticated").trim());
  } else add("gh-auth", "SKIP", "gh not available");

  let cfg = null;
  try {
    cfg = loadConfig(flags.config);
    add("config", "PASS", `${cfg.__path} — owner=${cfg.owner} (${cfg.ownerType || "Organization"}), ` +
      `project #${cfg.projectNumber}, ${Object.keys(cfg.stageOptions).length} lanes`);
  } catch (e) { add("config", "FAIL", e.message); }

  if (ghOk && cfg) {
    try {
      const f = getStageField(cfg);
      add("project-access", "PASS",
        `project #${cfg.projectNumber} reachable; Stage field ${f.fieldId} has ${f.options.length} live options`);
      const live = new Set(f.options.map((o) => o.optionId));
      const stale = Object.entries(cfg.stageOptions).filter(([, id]) => !live.has(id)).map(([l]) => l);
      if (stale.length) add("stage-options", "FAIL",
        `config lanes with stale optionIds (not live on the board): ${stale.join(", ")} — re-capture stageOptions`);
      else add("stage-options", "PASS", "every config lane maps to a live optionId");
    } catch (e) {
      add("project-access", "FAIL", e.message);
      add("stage-options", "SKIP", "project not reachable");
    }
  } else {
    add("project-access", "SKIP", ghOk ? "config invalid" : "gh not available");
    add("stage-options", "SKIP", ghOk ? "config invalid" : "gh not available");
  }

  // preset-coverage check — pure, offline, no board access needed.
  // Runs whenever config loaded OK and board.json names a preset.
  if (cfg && cfg.preset) {
    try {
      // Load the preset synchronously (same pattern as the engine's readFileSync usage).
      const presetPath = resolve(__dirname, "..", "presets", `${cfg.preset}.json`);
      let presetObj;
      try {
        presetObj = JSON.parse(readFileSync(presetPath, "utf8"));
      } catch (e) {
        add("preset-coverage", "FAIL",
          `preset "${cfg.preset}" not found or invalid: ${e.message}`);
        presetObj = null;
      }
      if (presetObj) {
        const cov = checkPresetCoverage(presetObj, cfg.stageOptions);
        if (cov.ok) {
          add("preset-coverage", "PASS",
            `all ${presetObj.lanes.length} preset lanes covered by stageOptions`);
        } else {
          add("preset-coverage", "FAIL",
            `preset "${cfg.preset}" lanes missing from stageOptions: ${cov.missing.join(", ")}. ` +
            `\n  UI setup checklist — add these lanes to your GitHub Project board:\n` +
            cov.missing.map((l) => `  [ ] Add single-select option "${l}" to the Stage field`).join("\n") +
            `\n  Then re-run: node scripts/board.mjs stage-field --json  (capture new optionIds into board.json)`);
        }
      }
    } catch (e) {
      add("preset-coverage", "FAIL", `preset-coverage check error: ${e.message}`);
    }
  } else if (cfg) {
    add("preset-coverage", "SKIP", "no preset configured in board.json");
  } else {
    add("preset-coverage", "SKIP", "config invalid — skipping preset check");
  }

  const failed = checks.filter((c) => c.status === "FAIL").length;
  if (failed > 0) process.exitCode = 1;
  return { ok: failed === 0, platform: process.platform, node: process.version, failed, checks };
}

// ===========================================================================
// WATCH (near-realtime board awareness — epic 0.1.6)
// ===========================================================================

// diffItems — PURE. Compare two listItems() snapshots (keyed by stable itemId)
// and emit structured change events. This is the heart of near-realtime board
// awareness: it catches **lane moves** (stageLabel change) — the one change class
// GitHub Actions and the notifications inbox structurally miss — plus
// created / removed / relabeled / state changes. Comment & body edits are NOT
// visible from the items() read; those arrive via the 0.2 webhook (or per-issue
// polling) and are intentionally out of scope for the 0.1.6 structural watcher.
function diffItems(prev, next) {
  const events = [];
  const prevById = new Map((prev || []).map((i) => [i.itemId, i]));
  const nextById = new Map((next || []).map((i) => [i.itemId, i]));

  for (const [id, n] of nextById) {
    if (!prevById.has(id))
      events.push({ type: "created", itemId: id, issueNumber: n.issueNumber, title: n.title, stageLabel: n.stageLabel, labels: n.labels });
  }
  for (const [id, p] of prevById) {
    if (!nextById.has(id))
      events.push({ type: "removed", itemId: id, issueNumber: p.issueNumber, title: p.title, lastStage: p.stageLabel });
  }
  for (const [id, n] of nextById) {
    const p = prevById.get(id);
    if (!p) continue;
    if ((p.stageLabel ?? null) !== (n.stageLabel ?? null))
      events.push({ type: "moved", itemId: id, issueNumber: n.issueNumber, title: n.title, from: p.stageLabel ?? null, to: n.stageLabel ?? null });
    const added = (n.labels || []).filter((l) => !(p.labels || []).includes(l));
    const removed = (p.labels || []).filter((l) => !(n.labels || []).includes(l));
    if (added.length || removed.length)
      events.push({ type: "relabeled", itemId: id, issueNumber: n.issueNumber, title: n.title, added, removed });
    if ((p.state ?? null) !== (n.state ?? null))
      events.push({ type: "state-changed", itemId: id, issueNumber: n.issueNumber, title: n.title, from: p.state ?? null, to: n.state ?? null });
    if ((p.title ?? null) !== (n.title ?? null))
      events.push({ type: "retitled", itemId: id, issueNumber: n.issueNumber, from: p.title ?? null, to: n.title ?? null });
  }
  return events;
}

function emitEvent(obj) { console.log(JSON.stringify(obj)); }

// runWatch — the continuous poll-and-diff loop. Establishes a baseline, then every
// `interval` seconds re-reads the board and emits one JSON line per change event.
// Near-realtime (cadence ≈ interval), no public endpoint needed — the container
// watches outward; sub-second webhook push is the 0.2 upgrade. `--once` runs a
// single settle+poll cycle and exits (CI/smoke). Clean exit on SIGINT.
async function runWatch(cfg, flags) {
  const stamp = () => new Date().toISOString();
  const intervalMs = Math.max(2, flags.interval ? Number(flags.interval) : 15) * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let prev = listItems(cfg).items;
  emitEvent({ type: "watch-start", board: cfg.projectUrl || cfg.repo, baselineCount: prev.length, intervalSec: intervalMs / 1000, once: !!flags.once, ts: stamp() });

  process.on("SIGINT", () => { emitEvent({ type: "watch-stop", reason: "SIGINT", ts: stamp() }); process.exit(0); });

  do {
    await sleep(flags.once ? 2000 : intervalMs);
    let next;
    try { next = listItems(cfg).items; }
    catch (e) { emitEvent({ type: "poll-error", message: e.message, ts: stamp() }); continue; }
    for (const ev of diffItems(prev, next)) emitEvent({ ...ev, ts: stamp() });
    prev = next;
  } while (!flags.once);

  if (flags.once) emitEvent({ type: "watch-done", note: "single cycle (--once) complete", ts: stamp() });
}

// ===========================================================================
// dispatch
// ===========================================================================
const HELP = `board.mjs — the BoardConnection (ghCli) adapter

UNDERSTAND:
  stage-field                         resolve Stage by configured id, fail-closed
  list-items                          paginated GraphQL list (NEVER item-list --format json)
  get-issue <owner> <repo> <number>   read an issue (node id, body, labels, comments)
  snapshot                            stage field + all items

MAKE:
  create-issue <title> <body> [--labels a,b]   REAL Issue (never draft) -> id+number+url
  add-to-board <issueUrl>                       upsert onto board -> itemId
  set-labels <number> <a,b>                     addLabelsToLabelable
  remove-labels <number> <a,b>                  removeLabelsFromLabelable
  comment <number> <body> [--identity pat|actions]   identity-aware comment

REGULATE:
  set-stage <itemId> <stageLabel>     move lane by configured field id + option id

WATCH (near-realtime — 0.1.6):
  watch [--interval <sec>] [--once]   poll-and-diff; stream create/move/label/state change events (incl. lane moves)

CROSS-CUTTING:
  doctor                              cross-platform preflight: node + gh + auth + board reachable
  capabilities                        per-adapter feature/limit map
  --staged   (global)                 dry-run: print the mutation, write nothing
  --config <path>                     override config (default ../board.json)
  --json                              json output (default)`;

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === "--help" || cmd === "help") { console.log(HELP); return; }

  // doctor runs BEFORE loadConfig so it can report node/gh/auth even when the
  // config itself is the problem.
  if (cmd === "doctor") { print(flags, runDoctor(flags)); return; }

  const cfg = loadConfig(flags.config);

  // watch is a long-running async loop — handle it before the sync switch.
  if (cmd === "watch") return runWatch(cfg, flags);

  switch (cmd) {
    // UNDERSTAND
    case "stage-field": {
      const force = positional[1] === "--force-name-only" ? "name-only" : undefined;
      print(flags, getStageField(cfg, { force }));
      break;
    }
    case "list-items": print(flags, listItems(cfg)); break;
    case "get-issue": {
      const [, owner, repo, number] = positional;
      if (!owner || !repo || !number) throw new Refusal("usage: get-issue <owner> <repo> <number>");
      print(flags, getIssue(cfg, owner, repo, number));
      break;
    }
    case "snapshot": print(flags, snapshot(cfg)); break;

    // MAKE
    case "create-issue": {
      const title = positional[1], body = positional[2] ?? "";
      if (!title) throw new Refusal("usage: create-issue <title> <body> [--labels a,b]");
      print(flags, createIssue(cfg, flags, title, body));
      break;
    }
    case "add-to-board": {
      const url = positional[1];
      if (!url) throw new Refusal("usage: add-to-board <issueUrl>");
      print(flags, addIssueToBoard(cfg, flags, url));
      break;
    }
    case "set-labels": {
      const number = positional[1], labels = positional[2];
      if (!number || !labels) throw new Refusal("usage: set-labels <number> <a,b>");
      print(flags, setLabels(cfg, flags, number, labels));
      break;
    }
    case "remove-labels": {
      const number = positional[1], labels = positional[2];
      if (!number || !labels) throw new Refusal("usage: remove-labels <number> <a,b>");
      print(flags, removeLabels(cfg, flags, number, labels));
      break;
    }
    case "comment": {
      const number = positional[1], body = positional[2];
      if (!number || body === undefined) throw new Refusal("usage: comment <number> <body> [--identity pat|actions]");
      print(flags, comment(cfg, flags, number, body));
      break;
    }

    // REGULATE
    case "set-stage": {
      const itemId = positional[1], stageLabel = positional[2];
      if (!itemId || !stageLabel) throw new Refusal("usage: set-stage <itemId> <stageLabel>");
      print(flags, setStage(cfg, flags, itemId, stageLabel));
      break;
    }

    // CROSS-CUTTING
    case "capabilities": print(flags, capabilities(cfg)); break;

    default:
      throw new Refusal(`unknown command '${cmd}'. Run --help for the command map.`);
  }
}

// Run as a CLI only when invoked directly (not when imported for testing).
const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const onErr = (e) => {
    const tag = e.refusal ? "REFUSED" : "ERROR";
    console.error(`[${tag}] ${e.message}`);
    process.exit(e.refusal ? 2 : 1);
  };
  try {
    const r = main(); // `watch` returns a promise; every sync command returns undefined
    if (r && typeof r.then === "function") r.catch(onErr);
  } catch (e) { onErr(e); }
}

// export for in-process testing
export {
  loadConfig, getStageField, listItems, getIssue, snapshot,
  createIssue, addIssueToBoard, setLabels, removeLabels, comment, setStage,
  capabilities, resolveStageOption, runDoctor, diffItems, runWatch, Refusal,
};
