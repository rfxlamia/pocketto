'use strict';

const { runJson, listComments } = require('./phase-handler-github');
const enterpriseMeta = require('./meta');
const { ISSUE_LABEL } = require('./issue-handler-identity');
const { repoIdentity, validateIssueOwnership, validateIssueReference } = require('./issue-identity');
const { PhaseHandlerError, safeMessage } = require('./phase-handler-errors');

function resolveRepository(options) {
  const data = runJson(['repo', 'view', '--json', 'owner,name,url'], options);
  const owner = typeof data.owner === 'string' ? data.owner : data.owner && data.owner.login;
  const name = data.name;
  if (typeof owner !== 'string' || owner.length === 0 || typeof name !== 'string' || name.length === 0) {
    throw new PhaseHandlerError('ORIGIN_UNPROVEN', 'The current origin repository could not be proven.');
  }
  const nameWithOwner = `${owner}/${name}`;
  const identity = repoIdentity({ nameWithOwner, url: data.url });
  if (!identity) {
    throw new PhaseHandlerError('ORIGIN_UNPROVEN', 'The current origin repository could not be proven.');
  }
  return { owner, name, nameWithOwner, url: data.url, identity };
}

function resolveOwnedIssue(event, context, repo, options) {
  const stored = enterpriseMeta.getIssueIdentity(context.specDir);
  const recorded = validateRecordedIssue(stored, event, repo, options);
  if (recorded.issue) return recorded.issue;

  const matches = runJson(['issue', 'list', '--repo', repo.nameWithOwner, '--state', 'open', '--label', ISSUE_LABEL,
    '--search', event.plan_id, '--json', 'number,url,state,title,body,labels'], options);
  if (!Array.isArray(matches)) {
    throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'Issue search response must be an array.', { status: 'retryable', retryable: true });
  }
  return resolveSearchedIssue(matches, event, repo, recorded.invalid);
}

function validateRecordedIssue(stored, event, repo, options) {
  const hasStoredIdentity = (Number.isInteger(stored.number) && stored.number > 0)
    || (typeof stored.url === 'string' && stored.url.length > 0);
  if (!hasStoredIdentity) return { issue: null, invalid: false };

  const reference = validateIssueReference(stored, repo.identity,
    Number.isInteger(stored.number) && stored.number > 0 ? stored.number : null);
  if (!reference.ok) return { issue: null, invalid: true };

  try {
    const issue = runJson(['issue', 'view', String(stored.number), '--repo', repo.nameWithOwner,
      '--json', 'number,url,state,title,body,labels'], options);
    const ownership = validateIssueOwnership(issue, {
      repo: repo.identity,
      planId: event.plan_id,
      expectedUrl: stored.url,
      expectedNumber: stored.number,
      requiredLabel: ISSUE_LABEL,
    });
    return ownership.ok ? { issue, invalid: false } : { issue: null, invalid: true };
  } catch {
    return { issue: null, invalid: true };
  }
}

function resolveSearchedIssue(matches, event, repo, invalidStored) {
  const evaluated = matches.map((candidate) => ({
    candidate,
    ownership: validateIssueOwnership(candidate, {
      repo: repo.identity,
      planId: event.plan_id,
      requiredLabel: ISSUE_LABEL,
    }),
  }));
  if (evaluated.some(({ ownership }) => ownership.identity.conflicting)) {
    throw new PhaseHandlerError('ISSUE_OWNERSHIP_UNPROVEN', 'Issue search found conflicting title and full-spec-path plan identities.');
  }
  const exact = evaluated.filter(({ ownership }) => ownership.identity.matches);
  const owned = exact.filter(({ ownership }) => ownership.ok);
  if (exact.length === 1 && owned.length === 1) return owned[0].candidate;
  if (exact.length > 1 || (exact.length === 1 && owned.length === 0)) {
    throw new PhaseHandlerError('ISSUE_OWNERSHIP_UNPROVEN', 'Issue search found an ambiguous, foreign, closed, or mismatched plan issue.');
  }
  if (invalidStored) {
    throw new PhaseHandlerError('ISSUE_OWNERSHIP_UNPROVEN', 'Recorded issue metadata is invalid and no exact owned open issue could be proven.');
  }
  throw new PhaseHandlerError('ISSUE_REQUIRED', 'Phase reporting requires an existing owned open issue; no issue was created.', {
    status: 'retryable',
    retryable: true,
  });
}

function resolvePhasePr(context, phase, repo, options) {
  const stored = enterpriseMeta.getPrIdentity(context.specDir, phase.key);
  const metadataMatch = resolveMetadataPr(stored, context, phase, repo, options);
  return metadataMatch || searchPhasePr(context, phase, repo, options);
}

function resolveMetadataPr(stored, context, phase, repo, options) {
  if (!Number.isInteger(stored.number) || stored.number <= 0
      || (stored.url && !sameRepository(stored.url, repo))) return null;
  try {
    const pr = loadPrView(stored.number, repo, options);
    const comments = listComments(`repos/${repo.nameWithOwner}/issues/${pr.number}/comments`, options);
    return validOpenPr(pr, context.branch, repo) && hasPhaseIdentity(comments, phase.number, true)
      ? { pr, comments }
      : null;
  } catch {
    // Invalid or stale metadata is only a hint; exact branch/phase search follows.
    return null;
  }
}

function searchPhasePr(context, phase, repo, options) {
  const candidates = runJson(['pr', 'list', '--repo', repo.nameWithOwner, '--head', context.branch, '--state', 'open',
    '--json', 'number,url,state,headRefName,baseRefName,title,body,headRefOid'], options);
  if (!Array.isArray(candidates)) {
    throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'PR search response must be an array.', { status: 'retryable', retryable: true });
  }
  const matches = candidates.map((candidate) => searchCandidate(candidate, context, phase, repo, options)).filter(Boolean);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 || candidates.length > 0) {
    throw new PhaseHandlerError('PR_MANUAL_RESOLUTION', 'PR search found ambiguous, foreign, closed, or mismatched phase candidates.');
  }
  throw requiredPr('No open PR matches the exact plan branch and phase marker; the adapter never creates PRs.');
}

function searchCandidate(candidate, context, phase, repo, options) {
  if (!Number.isInteger(candidate.number) || candidate.number <= 0) return null;
  let pr;
  try {
    pr = loadPrView(candidate.number, repo, options);
  } catch {
    return null;
  }
  if (!validOpenPr(pr, context.branch, repo)) return null;
  const comments = listComments(`repos/${repo.nameWithOwner}/issues/${pr.number}/comments`, options);
  return hasPhaseIdentity(comments, phase.number, false) ? { pr, comments } : null;
}

function loadPrView(number, repo, options) {
  const pr = runJson(['pr', 'view', String(number), '--repo', repo.nameWithOwner,
    '--json', 'number,url,state,headRefName,baseRefName,title,body,headRefOid'], options);
  if (pr.number !== number || !sameRepository(pr.url, repo)) {
    throw new PhaseHandlerError('PR_OWNERSHIP_UNPROVEN', 'The PR does not belong to the current origin repository.');
  }
  return pr;
}

function validOpenPr(pr, branch, repo) {
  return pr
    && sameRepository(pr.url, repo)
    && String(pr.state).toUpperCase() === 'OPEN'
    && pr.headRefName === branch;
}

function hasPhaseIdentity(comments, phaseNumber, metadataFirst) {
  const markers = comments.map((comment) => {
    if (typeof comment.body !== 'string') return null;
    const match = /^<!-- pocket-phase-(\d+)-summary -->$/.exec(comment.body.split(/\r?\n/, 1)[0]);
    return match ? Number(match[1]) : null;
  }).filter((number) => number !== null);
  if (markers.includes(phaseNumber)) return true;
  return metadataFirst && markers.length === 0;
}

function sameRepository(url, repo) {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const parts = parsed.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
  return parsed.hostname.toLowerCase() === 'github.com'
    && parts.length >= 2
    && parts[0].toLowerCase() === repo.owner.toLowerCase()
    && parts[1].toLowerCase() === repo.name.toLowerCase();
}

function requiredPr(message) {
  return new PhaseHandlerError('PR_REQUIRED', message, { status: 'retryable', retryable: true });
}


module.exports = { resolveRepository, resolveOwnedIssue, resolvePhasePr };
