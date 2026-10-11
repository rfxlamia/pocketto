'use strict';

// Enterprise phase stack publisher (T11).
//
// Publishes one phase branch as a PR whose base is the root base (phase 1) or
// the parent phase branch (phase N). Remote work goes through injectable runners
// only: `options.ghRunner` (gh seam) and `options.gitRunner` (git seam). Pushes
// are never forced, and no retarget, merge, or rebase happens here. Local
// preflight checks and the git seam live in ./phase-stack-checks.js.

const fs = require('node:fs');
const path = require('node:path');

const github = require('./github');
const enterpriseMeta = require('./meta');
const { runJson, runGhOnce, ghFailureError } = require('./phase-handler-github');
const { resolveRepository, sameRepository } = require('./phase-handler-targets');
const { PhaseHandlerError } = require('./phase-handler-errors');
const { stackBlock, phasePrBody, upsertStackBlock } = require('./stack-body');
const {
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
} = require('./phase-stack-checks');

// `state` is required so each listed candidate can be verified as OPEN. The limit is
// explicit because gh's default of 30 would hide duplicates beyond it.
const PR_LIST_FIELDS = 'number,url,state,headRefName,baseRefName,body,isCrossRepository';
const PR_LIST_LIMIT = 100;
const PR_VIEW_FIELDS = 'number,url,state,headRefName,baseRefName,body,isCrossRepository';

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
  if (!view || !sameRepository(view.url, repo) || view.isCrossRepository !== false) return null;
  if (String(view.state).toUpperCase() !== 'OPEN' || view.headRefName !== phase.branch) return null;
  if (view.baseRefName !== phase.baseBranch) {
    throw prBlocked('base retargeted',
      `PR_BLOCKED: the recorded PR for ${phase.key} now targets ${view.baseRefName}, not ${phase.baseBranch}. Pocket does not retarget; fix the base on GitHub, then rerun.`, false);
  }
  return view;
}

// A child stacks on an open parent only. A merged or closed parent ends the stack for this
// child: its base may already be gone, and GitHub may retarget the child, so the base checks
// would give advice that cannot work. The read is gh-only, so it runs before any push.
function assertParentOpen(options, repo, phase, parentPr) {
  const view = viewRecordedPr(options, repo, parentPr);
  if (!view) return; // stale hint: the base check below decides
  const state = String(view.state).toUpperCase();
  if (state === 'OPEN') return;
  if (state === 'MERGED') {
    throw prBlocked('parent PR merged',
      `PR_BLOCKED: parent PR #${parentPr} (${phase.parentKey}) is already merged. Pocket never stacks ${phase.key} on a merged parent and never retargets or rebases. A rerun fails the same way. Repairing ${phase.key} is a manual decision.`, false);
  }
  throw prBlocked('parent PR closed',
    `PR_BLOCKED: parent PR #${parentPr} (${phase.parentKey}) is closed without a merge. Pocket will not stack ${phase.key} on it. Reopen the parent PR on GitHub. A lifecycle event that is already terminal is not redelivered, so that case needs a manual decision.`, false);
}

// Every local precondition, in the order it has always run. Nothing here mutates remote
// state. The PR body is built here too, so a body that cannot be built never reaches origin.
function prePushChecks({ projectRoot, specDir, planId, phase, closeoutSnapshot, registration, options }) {
  const issue = enterpriseMeta.getIssueIdentity(specDir).number;
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new PhaseHandlerError('ISSUE_REQUIRED', 'Phase PR publishing requires a recorded plan issue.', { status: 'retryable', retryable: true });
  }
  const headSha = localHeadOf(options, projectRoot, phase.branch);
  assertBaseExpected(options, projectRoot, planId, phase);
  const repo = resolveRepository(phaseGhOptions(options));
  const parentPr = phase.parentKey ? parentPrNumber(specDir, phase.parentKey) : null;
  if (parentPr !== null) assertParentOpen(options, repo, phase, parentPr);
  assertBasePublished(options, projectRoot, phase);
  const block = stackBlock({ planId, phaseKey: phase.key, phaseOrder: phase.order, phaseCount: phase.count, baseBranch: phase.baseBranch, parentPr });
  // closes only works when the PR merges into the default branch, which only a one-phase plan
  // does (its base is the root base). Multi-phase PRs target a phase branch, so they use refs.
  const body = phasePrBody({ closeoutSnapshot, block, issueLink: { issue, finalPhase: phase.count === 1 } });
  const remoteSha = remoteHeadOf(options, projectRoot, phase.branch);
  assertPushConsent({ projectRoot, specDir, phase, registration, localSha: headSha, remoteSha });
  assertFastForward(options, projectRoot, phase.branch, remoteSha, headSha);
  return { repo, headSha, remoteSha, parentPr, block, body };
}

// The filtered list is the identity check when no recorded PR resolved. Every returned
// candidate must be open for this exact head and base, and at most one may exist.
function listOwnCandidates(options, repo, phase) {
  const listed = runJson(['pr', 'list', '--repo', repo.nameWithOwner, '--head', phase.branch, '--base', phase.baseBranch,
    '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_LIST_FIELDS], phaseGhOptions(options));
  if (!Array.isArray(listed)) {
    throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'gh pr list did not return an array.', { status: 'retryable', retryable: true });
  }
  // A fork PR can reuse our head branch name. An explicit fork is dropped here rather than
  // blocking: a blocking rule would let anyone stall publishing with a fork PR. Anything whose
  // provenance is unknown stays in the list and fails the own-candidate check below.
  const own = listed.filter((candidate) => !(candidate && candidate.isCrossRepository === true));
  if (!own.every((candidate) => isOwnCandidate(candidate, phase))) {
    throw prBlocked('foreign PR in list',
      'PR_BLOCKED: pr list returned a PR that is not open for this exact phase head and base. Resolve it by hand, then rerun.', false);
  }
  if (own.length > 1) {
    throw prBlocked('ambiguous PR identity',
      'PR_BLOCKED: more than one open PR matches this phase head and base. Close the duplicates by hand, then rerun.', false);
  }
  return own;
}

function publishPhase({ projectRoot, specDir, planId, phase, closeoutSnapshot, registration, options = {} }) {
  // Every local precondition runs before the first remote mutation (the push).
  const { repo, headSha, remoteSha, parentPr, block, body } = prePushChecks({
    projectRoot, specDir, planId, phase, closeoutSnapshot, registration, options,
  });
  if (remoteSha !== headSha) pushBranch(options, projectRoot, phase.branch);

  // Metadata first: a recorded PR number is viewed before the filtered list is consulted.
  const recorded = metadataPr(options, specDir, repo, phase);
  if (recorded) {
    return reusePr({ options, specDir, repo, phase, block, parentPr, headSha, candidate: recorded });
  }

  const listed = listOwnCandidates(options, repo, phase);
  if (listed.length === 1) {
    return reusePr({ options, specDir, repo, phase, block, parentPr, headSha, candidate: listed[0] });
  }

  let created;
  try {
    created = prNumberFromUrl(ghWithBody(options, [
      'pr', 'create', '--repo', repo.nameWithOwner, '--head', phase.branch, '--base', phase.baseBranch,
      '--title', `${planId} phase ${phase.order}`,
    ], body, classifyCreateFailure), repo);
  } catch (error) {
    if (!error || error.reason !== 'existing PR for head') throw error;
    // A concurrent publish created the PR after our list ran. Re-list once: reuse the PR when
    // exactly one own PR is there, otherwise the refusal stands.
    const raced = listOwnCandidates(options, repo, phase);
    if (raced.length !== 1) throw error;
    return reusePr({ options, specDir, repo, phase, block, parentPr, headSha, candidate: raced[0] });
  }
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
