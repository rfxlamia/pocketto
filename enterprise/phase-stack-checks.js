'use strict';

// Local preflight checks and the git seam for the phase stack publisher (T11).
// Every check here runs before the first remote mutation (the push). Git runs only
// through `options.gitRunner`, and pushes are never forced.

const { spawnSync } = require('node:child_process');

const enterpriseMeta = require('./meta');
const { PhaseHandlerError } = require('./phase-handler-errors');
const { PUSH_CONSENT_PHASE_BRANCHES } = require('./registration-phase');

const DEFAULT_GIT_TIMEOUT_MS = 30000;

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

module.exports = {
  localHeadOf,
  remoteHeadOf,
  assertPushConsent,
  assertFastForward,
  pushBranch,
  prBlocked,
  parentPrNumber,
  assertBasePublished,
  assertBaseExpected,
  isOwnCandidate,
};
