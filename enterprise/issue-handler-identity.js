'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ISSUE_LABEL = 'pocket-plan';
const ISSUE_FIELDS = 'number,url,state,title,body,labels,createdAt';
const PLAN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function repoIdentity(data) {
  if (!data || typeof data.nameWithOwner !== 'string' || !/^[^/]+\/[^/]+$/.test(data.nameWithOwner)
      || typeof data.url !== 'string') return null;
  let url;
  try {
    url = new URL(data.url);
  } catch (_) {
    return null;
  }
  const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  const [owner, name] = data.nameWithOwner.split('/');
  if (segments.length !== 2 || segments[0].toLowerCase() !== owner.toLowerCase()
      || segments[1].toLowerCase() !== name.toLowerCase()) return null;
  return { nameWithOwner: data.nameWithOwner, origin: url.origin, path: `/${segments.join('/')}` };
}

function issueUrlBelongsTo(issue, repo) {
  if (!issue || typeof issue.url !== 'string' || !Number.isInteger(issue.number) || issue.number <= 0) return false;
  let url;
  try {
    url = new URL(issue.url);
  } catch (_) {
    return false;
  }
  return url.origin === repo.origin
    && url.pathname.replace(/\/$/, '') === `${repo.path}/issues/${issue.number}`
    && !url.search && !url.hash;
}

function labelsOf(issue) {
  if (!Array.isArray(issue.labels)) return [];
  return issue.labels.map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
}

function containsExactPath(text, expectedPath) {
  const escapedPath = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = new RegExp(`(?:^|[^A-Za-z0-9._/-])${escapedPath}(?=$|[^A-Za-z0-9._/-])`);
  return boundary.test(text);
}

function hasPlanIdentity(issue, planId, specPath) {
  const title = typeof issue.title === 'string' ? issue.title : '';
  const token = new RegExp(`(^|[^a-z0-9-])${planId}($|[^a-z0-9-])`);
  const titleMatch = token.test(title);
  const body = typeof issue.body === 'string' ? issue.body : '';
  const pathMatch = containsExactPath(body, specPath);
  const embeddedPlanIds = [...body.matchAll(/docs\/pocket\/spec\/([a-z0-9]+(?:-[a-z0-9]+)*)\//g)]
    .map((match) => match[1]);
  const namedTitle = /^\s*Pocket Plan:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\b/.exec(title);
  const conflicting = (titleMatch && embeddedPlanIds.some((id) => id !== planId))
    || (pathMatch && namedTitle && namedTitle[1] !== planId);
  return { matches: titleMatch || pathMatch, titleMatch, pathMatch, conflicting: Boolean(conflicting) };
}

function specContext(event, projectRoot) {
  if (!PLAN_ID_PATTERN.test(event.plan_id)) return { error: 'plan_id is not a normalized kebab-slug' };
  const specDir = path.resolve(projectRoot, 'docs', 'pocket', 'spec', event.plan_id);
  const refs = event.artifact_refs.filter((ref) => ref.root === 'spec');
  if (refs.length === 0 || refs.length !== event.artifact_refs.length) {
    return { error: 'spec-approved requires spec-root artifacts only' };
  }
  for (const ref of refs) {
    if (path.isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes('..')) {
      return { error: 'approved spec artifact path is not root-relative' };
    }
  }
  const ref = refs[0];
  const artifactPath = path.resolve(specDir, ref.path);
  const relative = path.relative(specDir, artifactPath);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { error: 'approved spec artifact escapes the current plan directory' };
  }
  let realSpecDir;
  let realArtifact;
  let markdown;
  try {
    realSpecDir = fs.realpathSync(specDir);
    realArtifact = fs.realpathSync(artifactPath);
    if (!fs.statSync(realArtifact).isFile()) return { error: 'approved spec artifact is not a file' };
    markdown = fs.readFileSync(realArtifact, 'utf8');
  } catch (err) {
    return { error: `approved spec artifact is unavailable (${err && err.code === 'ENOENT' ? 'not found' : 'read failed'})` };
  }
  const realRelative = path.relative(realSpecDir, realArtifact);
  if (realRelative === '' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    return { error: 'approved spec artifact escapes the current plan directory' };
  }
  const actualHash = crypto.createHash('sha256').update(markdown).digest('hex');
  if (actualHash !== ref.sha256) return { error: 'approved spec artifact hash does not match the event' };
  const specPath = `docs/pocket/spec/${event.plan_id}/${ref.path.split(path.sep).join('/')}`;
  return { specDir, specPath, markdown, ref };
}

function flattenIssuePages(data) {
  if (!Array.isArray(data)) return null;
  const issues = [];
  const append = (page) => {
    if (!Array.isArray(page)) return false;
    for (const issue of page) {
      if (Array.isArray(issue)) {
        if (!append(issue)) return false;
      } else if (!issue || typeof issue !== 'object') {
        return false;
      } else {
        issues.push(issue);
      }
    }
    return true;
  };
  return append(data) ? issues : null;
}

function parseCreatedIssueNumber(output, repo) {
  const match = /\/issues\/(\d+)(?:\s|$)/.exec(String(output || '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  const candidate = { number, url: String(output).trim() };
  return issueUrlBelongsTo(candidate, repo) ? number : null;
}

function issueValidation(issue, event, spec, repo, expectedUrl = null) {
  const identity = hasPlanIdentity(issue, event.plan_id, spec.specPath);
  const repositoryMatches = !issue.repository || !issue.repository.nameWithOwner
    || issue.repository.nameWithOwner.toLowerCase() === repo.nameWithOwner.toLowerCase();
  if (identity.conflicting) return { ok: false, reason: 'title and embedded full-spec path identify different plans' };
  if (!Number.isInteger(issue.number) || issue.number <= 0) return { ok: false, reason: 'issue number is invalid' };
  if (String(issue.state).toUpperCase() !== 'OPEN') return { ok: false, reason: 'issue is not open' };
  if (!labelsOf(issue).includes(ISSUE_LABEL)) return { ok: false, reason: 'issue is missing the pocket-plan label' };
  if (!issueUrlBelongsTo(issue, repo) || !repositoryMatches) return { ok: false, reason: 'issue belongs to a different repository origin' };
  if (expectedUrl && expectedUrl !== issue.url) return { ok: false, reason: 'metadata URL does not match the current-origin issue URL' };
  if (!identity.matches) return { ok: false, reason: 'issue does not contain the exact normalized plan identity' };
  return { ok: true, identity };
}

module.exports = {
  ISSUE_FIELDS,
  ISSUE_LABEL,
  flattenIssuePages,
  hasPlanIdentity,
  issueUrlBelongsTo,
  issueValidation,
  labelsOf,
  parseCreatedIssueNumber,
  repoIdentity,
  specContext,
};
