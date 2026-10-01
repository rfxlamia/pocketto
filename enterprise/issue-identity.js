'use strict';

// Shared Enterprise issue ownership validation for issue reconciliation handlers.

const PLAN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function repoIdentity(data) {
  if (!data || typeof data.nameWithOwner !== 'string' || !/^[^/]+\/[^/]+$/.test(data.nameWithOwner)
      || typeof data.url !== 'string') return null;
  let url;
  try {
    url = new URL(data.url);
  } catch {
    return null;
  }
  const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  const [owner, name] = data.nameWithOwner.split('/');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || segments.length !== 2 || segments[0].toLowerCase() !== owner.toLowerCase()
      || segments[1].toLowerCase() !== name.toLowerCase()) return null;
  return { nameWithOwner: data.nameWithOwner, origin: url.origin, path: `/${segments.join('/')}` };
}

function issueUrl(issue) {
  if (issue && typeof issue.html_url === 'string' && issue.html_url.length > 0) return issue.html_url;
  return issue && typeof issue.url === 'string' && issue.url.length > 0 ? issue.url : null;
}

function issueUrlBelongsTo(issue, repo) {
  const candidateUrl = issueUrl(issue);
  if (!candidateUrl || !repo || typeof repo.origin !== 'string' || typeof repo.path !== 'string'
      || !Number.isInteger(issue.number) || issue.number <= 0) return false;
  let url;
  try {
    url = new URL(candidateUrl);
  } catch {
    return false;
  }
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && url.origin === repo.origin
    && url.pathname.replace(/\/$/, '') === `${repo.path}/issues/${issue.number}`
    && !url.search && !url.hash;
}

function validateIssueReference(reference, repo, expectedNumber = null) {
  if (!reference || !Number.isInteger(reference.number) || reference.number <= 0) {
    return { ok: false, reason: 'issue number is invalid' };
  }
  if (expectedNumber !== null && reference.number !== expectedNumber) {
    return { ok: false, reason: 'issue number does not match the recorded issue identity' };
  }
  if (!issueUrlBelongsTo(reference, repo)) {
    return { ok: false, reason: 'issue URL does not belong to the current repository origin and number' };
  }
  return { ok: true };
}

function labelsOf(issue) {
  if (!issue || !Array.isArray(issue.labels)) return [];
  return issue.labels.map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
}

function containsExactPath(text, expectedPath) {
  const escapedPath = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = new RegExp(`(?:^|[^A-Za-z0-9._/-])${escapedPath}(?=$|[^A-Za-z0-9._/-])`);
  return boundary.test(text);
}

function hasPlanIdentity(issue, planId, specPath = null) {
  if (typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId)) {
    return { matches: false, titleMatch: false, pathMatch: false, conflicting: false };
  }
  const title = typeof issue?.title === 'string' ? issue.title : '';
  const token = new RegExp(`(^|[^a-z0-9-])${planId}($|[^a-z0-9-])`);
  const titleMatch = token.test(title);
  const body = typeof issue?.body === 'string' ? issue.body : '';
  const embeddedPlanIds = [...body.matchAll(/docs\/pocket\/spec\/([a-z0-9]+(?:-[a-z0-9]+)*)\//g)]
    .map((match) => match[1]);
  const pathMatch = typeof specPath === 'string'
    ? containsExactPath(body, specPath)
    : embeddedPlanIds.includes(planId);
  const namedTitle = /^\s*Pocket Plan:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\b/.exec(title);
  const conflicting = (titleMatch && embeddedPlanIds.some((id) => id !== planId))
    || (pathMatch && namedTitle && namedTitle[1] !== planId);
  return { matches: titleMatch || pathMatch, titleMatch, pathMatch, conflicting: Boolean(conflicting) };
}

function validateIssueIdentity(issue, planId, specPath = null) {
  const identity = hasPlanIdentity(issue, planId, specPath);
  if (identity.conflicting) {
    return { ok: false, identity, reason: 'title and embedded full-spec path identify different plans' };
  }
  if (!identity.matches) {
    return { ok: false, identity, reason: 'issue does not contain the exact normalized plan identity' };
  }
  return { ok: true, identity };
}

function validateIssueOwnership(issue, {
  repo,
  planId,
  specPath = null,
  expectedUrl,
  expectedNumber = null,
  requiredLabel = null,
} = {}) {
  const identityResult = validateIssueIdentity(issue, planId, specPath);
  if (!identityResult.ok) {
    return { ...identityResult, code: 'ISSUE_OWNERSHIP_AMBIGUOUS' };
  }
  const identity = identityResult.identity;
  if (!Number.isInteger(issue?.number) || issue.number <= 0
      || (expectedNumber !== null && issue.number !== expectedNumber)) {
    return { ok: false, code: 'ISSUE_OWNERSHIP_AMBIGUOUS', identity, reason: 'issue number is invalid or does not match metadata' };
  }
  if (typeof issue.state !== 'string') {
    return { ok: false, code: 'ISSUE_OWNERSHIP_AMBIGUOUS', identity, reason: 'issue state is unavailable' };
  }
  if (issue.state.toLowerCase() !== 'open') {
    return { ok: false, code: 'ISSUE_CLOSED', identity, reason: 'issue is not open' };
  }
  if (!issueUrlBelongsTo(issue, repo)) {
    return { ok: false, code: 'ISSUE_OWNERSHIP_AMBIGUOUS', identity, reason: 'issue belongs to a different repository origin or URL' };
  }
  if (expectedUrl !== undefined) {
    const recorded = validateIssueReference({ number: expectedNumber ?? issue.number, url: expectedUrl }, repo, issue.number);
    if (!recorded.ok || expectedUrl !== issueUrl(issue)) {
      return { ok: false, code: 'ISSUE_OWNERSHIP_AMBIGUOUS', identity, reason: 'metadata URL does not match the current-origin issue URL' };
    }
  }
  const repository = issue.repository;
  const reportedName = repository && (repository.nameWithOwner || repository.full_name);
  if (typeof reportedName === 'string' && reportedName.toLowerCase() !== repo.nameWithOwner.toLowerCase()) {
    return { ok: false, code: 'ISSUE_OWNERSHIP_AMBIGUOUS', identity, reason: 'issue repository does not match the current repository' };
  }
  if (requiredLabel && !labelsOf(issue).includes(requiredLabel)) {
    return { ok: false, code: 'ISSUE_OWNERSHIP_AMBIGUOUS', identity, reason: `issue is missing the ${requiredLabel} label` };
  }
  return { ok: true, identity };
}

module.exports = {
  issueUrlBelongsTo,
  repoIdentity,
  validateIssueOwnership,
  validateIssueReference,
};
