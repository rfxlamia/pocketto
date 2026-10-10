'use strict';

// Enterprise phase stack publisher (T11).
//
// Publishes one phase branch as a PR whose base is the root base (phase 1) or
// the parent phase branch (phase N). Remote work goes through injectable runners
// only: `options.ghRunner` (gh seam) and `options.gitRunner` (git seam). Pushes
// are never forced, and no retarget, merge, or rebase happens here.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const github = require('./github');
const enterpriseMeta = require('./meta');
const { runJson, runGhOnce, ghFailureError } = require('./phase-handler-github');
const { resolveRepository, sameRepository } = require('./phase-handler-targets');
const { PhaseHandlerError } = require('./phase-handler-errors');
const { stackBlock, phasePrBody, upsertStackBlock } = require('./stack-body');
const { PUSH_CONSENT_PHASE_BRANCHES } = require('./registration-phase');

const DEFAULT_GIT_TIMEOUT_MS = 30000;
// `state` is required so each listed candidate can be verified as OPEN. The limit is
// explicit because gh's default of 30 would hide duplicates beyond it.
const PR_LIST_FIELDS = 'number,url,state,headRefName,baseRefName,body';
const PR_LIST_LIMIT = 100;
const PR_VIEW_FIELDS = 'number,url,state,headRefName,baseRefName,body';

function defaultGitRunner(args, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_GIT_TIMEOUT_MS;
  const res = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', timeout: timeoutMs });
  return {
    exit: typeof res.status === 'number' ? res.status : 1,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : (res.error ? String(res.error.message || res.error) : ''),
  };
}

function gitCall(options, cwd, args) {
  const runner = options.gitRunner || defaultGitRunner;
  return runner(args.slice(), { cwd, timeoutMs: options.timeoutMs });
}

function localHeadOf(options, cwd, branch) {
  const res = gitCall(options, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (res.exit !== 0 || !/^[0-9a-f]{40}$/.test(res.stdout.trim())) {
    throw new PhaseHandlerError('PHASE_BRANCH_MISSING', `Local branch ${branch} does not exist.`);
  }
  return res.stdout.trim();
}

// Exact ref match: ls-remote patterns match a suffix, so compare the ref column.
function remoteHeadOf(options, cwd, branch) {
  const res = gitCall(options, cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (res.exit !== 0) {
    throw new PhaseHandlerError('REMOTE_UNAVAILABLE', 'git ls-remote could not read origin.', { status: 'retryable', retryable: true });
  }
  const line = res.stdout.split(/\r?\n/).find((candidate) => candidate.endsWith(`\trefs/heads/${branch}`));
  return line ? line.split('\t')[0] : null;
}

function hasDurableConsent(registration) {
  const consent = registration && registration.push_consent;
  return Boolean(consent) && consent.scope === PUSH_CONSENT_PHASE_BRANCHES.scope && consent.force === false;
}

// Consent is durable (registration) or bound to the exact local SHA (per-SHA approval).
// Anything else is retryable: the user approves and the drain reruns.
function assertPushConsent({ projectRoot, specDir, phase, registration, localSha, remoteSha }) {
  if (hasDurableConsent(registration)) return;
  if (enterpriseMeta.getPushApproval(specDir, phase.key).sha === localSha) return;
  throw new PhaseHandlerError('PUSH_CONSENT_REQUIRED',
    `PUSH_CONSENT_REQUIRED: ${phase.branch} at local ${localSha}; remote ${remoteSha || 'absent'}. `
    + `Approve this exact commit with: enterprise/cli.js consent-push ${projectRoot} ${specDir} ${phase.key} --sha ${localSha}`,
    { status: 'retryable', retryable: true });
}

// The remote tip must be an ancestor of the local head, or the push would rewrite
// remote history. Pocket never force-pushes, so divergence is terminal and blocked.
function assertFastForward(options, cwd, branch, remoteSha, headSha) {
  if (remoteSha === null || remoteSha === headSha) return;
  const res = gitCall(options, cwd, ['merge-base', '--is-ancestor', remoteSha, headSha]);
  if (res.exit === 0) return;
  // Exit 1 means "not an ancestor". Any other exit is only divergence when the remote
  // commit is unknown locally; if it is known, the failure is transient and retryable.
  if (res.exit !== 1) {
    const known = gitCall(options, cwd, ['cat-file', '-e', `${remoteSha}^{commit}`]).exit === 0;
    if (known) {
      throw new PhaseHandlerError('GIT_UNAVAILABLE', 'git could not decide whether the remote tip is an ancestor.', { status: 'retryable', retryable: true });
    }
  }
  throw prBlocked('remote branch diverged',
    `PR_BLOCKED: origin/${branch} has diverged from the local branch (it holds commits missing locally). Pocket never force-pushes or rebases. `
    + 'Fetch the remote branch, reconcile it deliberately, then rerun.', false);
}

function pushBranch(options, cwd, branch) {
  // Never forced: no --force and no --force-with-lease in any path.
  const res = gitCall(options, cwd, ['push', '-u', 'origin', branch]);
  if (res.exit !== 0) {
    throw new PhaseHandlerError('PUSH_FAILED', `git push of ${branch} failed.`, { status: 'retryable', retryable: true });
  }
}

// The phase-handler seam (runJson, resolveRepository) reads `ghRunner`.
function phaseGhOptions(options) {
  return { ghRunner: options.ghRunner, timeoutMs: options.timeoutMs };
}

// Runs one gh write (create/edit) with the body in a temp --body-file. The file is
// removed after the call returns, so the runner must read it during the call.
// `classifyFailure(result)` may map a known refusal to a fixed error before the generic path.
function ghWithBody(options, args, body, classifyFailure) {
  const bodyFile = github.writeBodyFile(body);
  try {
    const result = runGhOnce([...args, '--body-file', bodyFile], options, false);
    if (!result.ok) {
      const mapped = classifyFailure ? classifyFailure(result) : null;
      throw mapped || ghFailureError(result);
    }
    return result.raw.stdout;
  } finally {
    try { fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
}

// GitHub refuses a second PR for the same head. The list did not return it (for example
// it sits on another base), so it is ambiguous from here: block without a mutation.
const PR_ALREADY_EXISTS = /pull request.*already exists/i;

function classifyCreateFailure(result) {
  if (!PR_ALREADY_EXISTS.test(result.raw.stderr)) return null;
  return prBlocked('existing PR for head',
    'PR_BLOCKED: GitHub reports a PR already exists for this head. Resolve the existing PR by hand, then rerun.', false);
}

function prNumberFromUrl(stdout, repo) {
  const url = String(stdout || '').trim().split(/\r?\n/).pop();
  const match = /\/pull\/(\d+)$/.exec(url || '');
  if (!match || !sameRepository(url, repo)) {
    throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'gh pr create did not return a PR URL in the current repository.', { status: 'retryable', retryable: true });
  }
  return { number: Number(match[1]), url };
}

// Fixed-reason PR_BLOCKED. `reason` is a closed, human-readable token; the message
// never carries stderr, URLs, or other remote-controlled text.
function prBlocked(reason, message, retryable) {
  const error = new PhaseHandlerError('PR_BLOCKED', message, {
    status: retryable ? 'retryable' : 'terminal',
    retryable,
  });
  error.reason = reason;
  return error;
}

// A child phase must name the parent PR recorded by the earlier publish. Without it,
// the stack block would claim the repository root base, so fail closed instead.
function parentPrNumber(specDir, parentKey) {
  const recorded = enterpriseMeta.getPrIdentity(specDir, parentKey).number;
  if (!Number.isInteger(recorded) || recorded <= 0) {
    throw prBlocked('parent PR not recorded', `PR_BLOCKED: parent PR for ${parentKey} is not recorded yet. Publish the parent phase first, then rerun.`, true);
  }
  return recorded;
}

// A recorded number that GitHub no longer resolves is only a stale hint: return null so
// the filtered list decides. Every other failure (timeout, auth, rate limit) is fatal and
// retryable, and never falls back. Raw stderr is read here because runJson collapses
// not-found into a generic GH_UNKNOWN.
const PR_NOT_FOUND = /could not resolve to a pullrequest|not found/i;

function viewRecordedPr(options, repo, number) {
  const result = runGhOnce(['pr', 'view', String(number), '--repo', repo.nameWithOwner, '--json', PR_VIEW_FIELDS], options, true);
  if (result.ok) return result.data;
  if (result.classification.error.code === 'GH_UNKNOWN' && PR_NOT_FOUND.test(result.raw.stderr)) return null;
  throw ghFailureError(result);
}

// Returns the recorded PR when it is still open for this exact head and base.
// An open PR with the right head but a different base was retargeted on GitHub: block.
function metadataPr(options, specDir, repo, phase) {
  const recorded = enterpriseMeta.getPrIdentity(specDir, phase.key).number;
  if (!Number.isInteger(recorded) || recorded <= 0) return null;
  const view = viewRecordedPr(options, repo, recorded);
  if (!view || !sameRepository(view.url, repo)) return null;
  if (String(view.state).toUpperCase() !== 'OPEN' || view.headRefName !== phase.branch) return null;
  if (view.baseRefName !== phase.baseBranch) {
    throw prBlocked('base retargeted',
      `PR_BLOCKED: the recorded PR for ${phase.key} now targets ${view.baseRefName}, not ${phase.baseBranch}. Pocket does not retarget; fix the base on GitHub, then rerun.`, false);
  }
  return view;
}

// The base must already exist on origin, or the PR would target a missing branch.
// Phase 1 bases on root_base; a child bases on its parent phase branch.
function assertBasePublished(options, cwd, phase) {
  if (remoteHeadOf(options, cwd, phase.baseBranch) !== null) return;
  if (phase.parentKey) {
    throw prBlocked('parent branch not published',
      `PR_BLOCKED: parent branch ${phase.baseBranch} is not on origin yet. Publish the parent phase first, then rerun.`, true);
  }
  throw prBlocked('root base not published',
    `PR_BLOCKED: root base ${phase.baseBranch} is not on origin. Push it, then rerun.`, true);
}

// Repo-local key written at stacked init (cli/lib/phase-branches.js, rootBaseKey; not exported).
// It is the durable record of the root base, so the publisher reads it instead of guessing.
function rootBaseKey(branch) {
  return `branch.${branch}.pocketRootBase`;
}

function recordedRootBase(options, cwd, branch) {
  const res = gitCall(options, cwd, ['config', '--get', rootBaseKey(branch)]);
  if (res.exit === 1) return null;
  if (res.exit !== 0) {
    throw new PhaseHandlerError('GIT_UNAVAILABLE', 'git could not read the recorded root base.', { status: 'retryable', retryable: true });
  }
  return res.stdout.trim() || null;
}

// Phase 1 must target the recorded root base; phase N must target its parent phase
// branch and parent key. Checked before any push, so a mismatched base never reaches origin.
function assertBaseExpected(options, cwd, planId, phase) {
  if (phase.order === 1) {
    const root = recordedRootBase(options, cwd, phase.branch);
    if (root === null) {
      throw prBlocked('root base unrecorded',
        `PR_BLOCKED: ${phase.branch} has no recorded root base. Restore the stacked init record, then rerun.`, false);
    }
    if (phase.baseBranch !== root) {
      throw prBlocked('base mismatch',
        `PR_BLOCKED: ${phase.key} targets ${phase.baseBranch}, but the recorded root base is ${root}. Fix the base, then rerun.`, false);
    }
    return;
  }
  const parentKey = `phase-${phase.order - 1}`;
  const parentBranch = `pocket/${planId}/${parentKey}`;
  if (phase.parentKey !== parentKey || phase.baseBranch !== parentBranch) {
    throw prBlocked('base mismatch',
      `PR_BLOCKED: ${phase.key} must target ${parentBranch} (${parentKey}), not ${phase.baseBranch}. Fix the base, then rerun.`, false);
  }
}

// A listed PR is ours only when it is open for this exact head and base. gh filters by
// --head/--base already; re-checking the returned fields guards against any other candidate.
function isOwnCandidate(candidate, phase) {
  return Boolean(candidate) && candidate.headRefName === phase.branch && candidate.baseRefName === phase.baseBranch
    && String(candidate.state).toUpperCase() === 'OPEN';
}

function publishPhase({ projectRoot, specDir, planId, phase, closeoutSnapshot, registration, options = {} }) {
  // Every local precondition runs before the first remote mutation (the push).
  const issue = enterpriseMeta.getIssueIdentity(specDir).number;
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new PhaseHandlerError('ISSUE_REQUIRED', 'Phase PR publishing requires a recorded plan issue.', { status: 'retryable', retryable: true });
  }
  const headSha = localHeadOf(options, projectRoot, phase.branch);
  assertBaseExpected(options, projectRoot, planId, phase);
  const repo = resolveRepository(phaseGhOptions(options));
  assertBasePublished(options, projectRoot, phase);
  const parentPr = phase.parentKey ? parentPrNumber(specDir, phase.parentKey) : null;
  // The PR body is built before the push, so a body that cannot be built never reaches origin.
  const block = stackBlock({ planId, phaseKey: phase.key, phaseOrder: phase.order, phaseCount: phase.count, baseBranch: phase.baseBranch, parentPr });
  const body = phasePrBody({ closeoutSnapshot, block, issueLink: { issue, finalPhase: phase.order === phase.count } });
  const remoteSha = remoteHeadOf(options, projectRoot, phase.branch);
  assertPushConsent({ projectRoot, specDir, phase, registration, localSha: headSha, remoteSha });
  assertFastForward(options, projectRoot, phase.branch, remoteSha, headSha);
  if (remoteSha !== headSha) pushBranch(options, projectRoot, phase.branch);

  // Metadata first: a recorded PR number is viewed before the filtered list is consulted.
  const recorded = metadataPr(options, specDir, repo, phase);
  if (recorded) {
    return reusePr({ options, specDir, repo, phase, block, parentPr, headSha, candidate: recorded });
  }

  const listed = runJson(['pr', 'list', '--repo', repo.nameWithOwner, '--head', phase.branch, '--base', phase.baseBranch,
    '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_LIST_FIELDS], phaseGhOptions(options));
  if (!Array.isArray(listed)) {
    throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'gh pr list did not return an array.', { status: 'retryable', retryable: true });
  }
  if (!listed.every((candidate) => isOwnCandidate(candidate, phase))) {
    throw prBlocked('foreign PR in list',
      'PR_BLOCKED: pr list returned a PR that is not open for this exact phase head and base. Resolve it by hand, then rerun.', false);
  }
  if (listed.length > 1) {
    throw prBlocked('ambiguous PR identity',
      'PR_BLOCKED: more than one open PR matches this phase head and base. Close the duplicates by hand, then rerun.', false);
  }
  if (listed.length === 1) {
    return reusePr({ options, specDir, repo, phase, block, parentPr, headSha, candidate: listed[0] });
  }

  const created = prNumberFromUrl(ghWithBody(options, [
    'pr', 'create', '--repo', repo.nameWithOwner, '--head', phase.branch, '--base', phase.baseBranch,
    '--title', `${planId} phase ${phase.order}`,
  ], body, classifyCreateFailure), repo);
  recordIdentity({ specDir, phase, pr: created, parentPr, headSha });
  return {
    pr: created,
    created: true,
    headSha,
    notice: { code: 'PR_CREATED', message: `Phase ${phase.order} PR created against ${phase.baseBranch}.` },
  };
}

// Reuse touches only the stack block. Human text outside the managed span is kept
// byte-for-byte by upsertStackBlock, and an unchanged body is never edited again.
function reusePr({ options, specDir, repo, phase, block, parentPr, headSha, candidate }) {
  const body = typeof candidate.body === 'string' ? candidate.body : '';
  let edited;
  try {
    edited = upsertStackBlock(body, block);
  } catch (error) {
    if (error && error.code === 'STACK_BLOCK_MALFORMED') {
      throw prBlocked('STACK_BLOCK_MALFORMED',
        'PR_BLOCKED: STACK_BLOCK_MALFORMED: the PR body has unmatched or repeated stack-context markers. Fix the markers by hand, then rerun.', false);
    }
    throw error;
  }
  if (edited !== body) {
    ghWithBody(options, ['pr', 'edit', String(candidate.number), '--repo', repo.nameWithOwner], edited);
  }
  const pr = { number: candidate.number, url: candidate.url };
  recordIdentity({ specDir, phase, pr, parentPr, headSha });
  return {
    pr,
    created: false,
    headSha,
    notice: { code: 'PR_REUSED', message: `Phase ${phase.order} PR reused against ${phase.baseBranch}.` },
  };
}

function recordIdentity({ specDir, phase, pr, parentPr, headSha }) {
  enterpriseMeta.setPrStackIdentity(specDir, phase.key, {
    number: pr.number,
    url: pr.url,
    head: phase.branch,
    base: phase.baseBranch,
    parent_pr: parentPr,
    head_sha: headSha,
  });
}

module.exports = { publishPhase };
