// scripts/lib/repo-detect.mjs — resolve the current repo from the git remote.
//
// detectRepo(runner) is pure given an injected `runner` that returns the raw
// `gh repo view --json owner,name,nameWithOwner` stdout. The default runner
// shells out to gh. Fail-closed: a RepoDetectError (a refusal) is thrown when
// no GitHub repo can be resolved, so bootstrap stops with a legible message
// instead of guessing.

import { spawnSync } from 'node:child_process';

export class RepoDetectError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RepoDetectError';
    this.refusal = true;
  }
}

/**
 * @param {() => string} [runner] returns `gh repo view --json ...` stdout
 * @returns {{owner:string, repo:string, nameWithOwner:string}}
 */
export function detectRepo(runner = defaultRunner) {
  const out = runner();
  let data;
  try {
    data = JSON.parse(out);
  } catch (e) {
    throw new RepoDetectError(`could not parse \`gh repo view\` output: ${e.message}`);
  }
  const owner = data && data.owner && data.owner.login;
  const repo = data && data.name;
  if (!owner || !repo) {
    throw new RepoDetectError(
      'no GitHub repo detected for the current directory. ' +
      'Run bootstrap with --repo owner/name to name one explicitly, ' +
      'or check `gh repo view`.'
    );
  }
  return { owner, repo, nameWithOwner: data.nameWithOwner || `${owner}/${repo}` };
}

function defaultRunner() {
  const r = spawnSync('gh', ['repo', 'view', '--json', 'owner,name,nameWithOwner'], {
    encoding: 'utf8',
    shell: false,
  });
  if (r.error) throw new RepoDetectError(`failed to spawn gh: ${r.error.message}`);
  if (r.status !== 0) {
    throw new RepoDetectError(
      `\`gh repo view\` failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}. ` +
      'Are you in a git repo with a GitHub remote? Use --repo owner/name to name one.'
    );
  }
  return (r.stdout || '').trim();
}
