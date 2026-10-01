'use strict';

const { runJson, listComments } = require('./phase-handler-github');
const enterpriseMeta = require('./meta');
const { PhaseHandlerError, safeMessage } = require('./phase-handler-errors');

function resolveRepository(options) {
  const data = runJson(['repo', 'view', '--json', 'owner,name,url'], options);
  const owner = typeof data.owner === 'string' ? data.owner : data.owner && data.owner.login;
  const name = data.name;
  if (typeof owner !== 'string' || owner.length === 0 || typeof name !== 'string' || name.length === 0) {
    throw new PhaseHandlerError('ORIGIN_UNPROVEN', 'The current origin repository could not be proven.');
  }
  return { owner, name, nameWithOwner: `${owner}/${name}`, url: data.url || null };
}

function resolveOwnedIssue(event, context, repo, options) {
  const stored = enterpriseMeta.getIssueIdentity(context.specDir);
  let invalidStored = false;
  if (Number.isInteger(stored.number) && stored.number > 0) {
    if (stored.url && !sameRepository(stored.url, repo)) {
      invalidStored = true;
    } else {
      try {
        const issue = runJson(['issue', 'view', String(stored.number), '--repo', repo.nameWithOwner,
          '--json', 'number,url,state,title,body'], options);
        if (isOwnedOpenIssue(issue, event.plan_id, repo)) return issue;
        invalidStored = true;
      } catch (_) {
        invalidStored = true;
      }
    }
  }

  const matches = runJson(['issue', 'list', '--repo', repo.nameWithOwner, '--state', 'open', '--label', 'pocket-plan',
    '--search', event.plan_id, '--json', 'number,url,state,title,body'], options);
  if (!Array.isArray(matches)) {
    throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'Issue search response must be an array.', { status: 'retryable', retryable: true });
  }
  const exact = matches.filter((candidate) => hasExactPlanIdentity(candidate, event.plan_id));
  const owned = exact.filter((candidate) => isOwnedOpenIssue(candidate, event.plan_id, repo));
  if (exact.length === 1 && owned.length === 1) return owned[0];
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

function isOwnedOpenIssue(issue, planId, repo) {
  return issue
    && Number.isInteger(issue.number)
    && issue.number > 0
    && sameRepository(issue.url, repo)
    && String(issue.state).toUpperCase() === 'OPEN'
    && hasExactPlanIdentity(issue, planId);
}

function hasExactPlanIdentity(issue, planId) {
  if (!issue || typeof planId !== 'string') return false;
  const titleTokens = String(issue.title || '').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
  if (titleTokens.includes(planId)) return true;
  const body = typeof issue.body === 'string' ? issue.body.replace(/\\/g, '/') : '';
  return new RegExp(`(?:^|/)docs/pocket/spec/${planId}(?:/|$)`, 'i').test(body);
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
  } catch (_) {
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
  } catch (_) {
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
  } catch (_) {
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
