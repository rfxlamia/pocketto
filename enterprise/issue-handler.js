'use strict';

// Enterprise-owned reconciliation for the neutral `spec-approved` event.
// GitHub identity is persisted only in the Enterprise-owned metadata file;
// adapter responses expose only the opaque proof reference and hash.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { issueBody } = require('../cli/lib/bodies');
const github = require('./github');
const meta = require('./meta');
const { validateEvent } = require('../cli/lib/lifecycle-contract');

const ISSUE_LABEL = 'pocket-plan';
const ISSUE_FIELDS = 'number,url,state,title,body,labels,createdAt';
const PLAN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function resultError(event, code, message, retryable = false) {
  return {
    event_id: event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event',
    status: retryable ? 'retryable' : 'terminal',
    error: { code, retryable, message: String(message || code) },
  };
}

function repoView(runner) {
  return github.runGh(['repo', 'view', '--json', 'nameWithOwner,url'], {
    runner,
    expectJson: true,
  });
}

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

function hasPlanIdentity(issue, planId, specPath) {
  const title = typeof issue.title === 'string' ? issue.title : '';
  const token = new RegExp(`(^|[^a-z0-9-])${planId}($|[^a-z0-9-])`);
  const titleMatch = token.test(title);
  const body = typeof issue.body === 'string' ? issue.body : '';
  const pathMatch = body.includes(specPath);
  return { matches: titleMatch || pathMatch, titleMatch, pathMatch };
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

function listOpenPlanIssues(repo, runner) {
  return github.runGh([
    'issue', 'list', '--repo', repo.nameWithOwner,
    '--state', 'open', '--label', ISSUE_LABEL, '--limit', '1000', '--json', ISSUE_FIELDS,
  ], { runner, expectJson: true });
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

function issueView(repo, number, runner) {
  return github.runGh([
    'issue', 'view', String(number), '--repo', repo.nameWithOwner, '--json', ISSUE_FIELDS,
  ], { runner, expectJson: true });
}

function parseCreatedIssueNumber(output, repo) {
  const match = /\/issues\/(\d+)(?:\s|$)/.exec(String(output || '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  const candidate = { number, url: String(output).trim() };
  return issueUrlBelongsTo(candidate, repo) ? number : null;
}

function computeProofHash({ event, issue, repository, specPath, identity }) {
  const proof = {
    event_id: event.event_id,
    plan_id: event.plan_id,
    repository,
    issue_number: issue.number,
    issue_url: issue.url,
    spec_path: specPath,
    identity,
  };
  return crypto.createHash('sha256').update(JSON.stringify(proof), 'utf8').digest('hex');
}

function saveIssueProof(specDir, event, issue, repo, specPath, identity, clock) {
  const proofHash = computeProofHash({
    event,
    issue,
    repository: repo.nameWithOwner,
    specPath,
    identity,
  });
  const current = meta.readMetaFor(specDir);
  const createdAt = typeof issue.createdAt === 'string'
    ? issue.createdAt
    : clock().toISOString();
  const updated = {
    ...current,
    github_issue: {
      ...(current.github_issue || {}),
      number: issue.number,
      url: issue.url,
      created_at: createdAt,
      ownership: {
        plan_id: event.plan_id,
        repository: repo.nameWithOwner,
        event_id: event.event_id,
        spec_path: specPath,
        identity,
        proof_hash: proofHash,
      },
    },
  };
  meta.writeMetaFor(specDir, updated);
  return proofHash;
}

function writeIssue(event, runner, spec, repo) {
  const body = issueBody({
    title: `Pocket Plan: ${event.plan_id}`,
    context: `Approved specification: \`${spec.specPath}\``,
    technicalApproach: 'See the approved specification below.',
    acceptanceCriteria: [],
    outOfScope: [],
    specMarkdown: spec.markdown,
  });
  let bodyFile;
  try {
    bodyFile = github.writeBodyFile(body);
    const created = github.runGh([
      'issue', 'create', '--repo', repo.nameWithOwner,
      '--title', `Pocket Plan: ${event.plan_id}`,
      '--label', ISSUE_LABEL,
      '--body-file', bodyFile,
    ], { runner });
    if (!created.ok) return { error: created };
    const number = parseCreatedIssueNumber(created.data, repo);
    if (!number) return { manual: 'GitHub did not return an issue URL in the current origin repository' };
    const viewed = issueView(repo, number, runner);
    if (!viewed.ok) return { error: viewed };
    return { issue: viewed.data, created: true };
  } finally {
    if (bodyFile) {
      try { fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
    }
  }
}

function proveIssue(event, issue, spec, repo, clock) {
  const identity = hasPlanIdentity(issue, event.plan_id, spec.specPath);
  if (!Number.isInteger(issue.number) || issue.number <= 0
      || String(issue.state).toUpperCase() !== 'OPEN'
      || !labelsOf(issue).includes(ISSUE_LABEL)
      || !issueUrlBelongsTo(issue, repo)
      || !identity.matches) {
    return resultError(event, 'ISSUE_MANUAL_RESOLUTION', 'Issue could not be proven open, current-origin, pocket-plan labeled, and tied to the exact plan identity.');
  }
  const identityProof = identity.titleMatch && identity.pathMatch
    ? 'title+full-spec-path'
    : identity.titleMatch ? 'title' : 'full-spec-path';
  const proofHash = saveIssueProof(spec.specDir, event, issue, repo, spec.specPath, identityProof, clock);
  return {
    event_id: event.event_id,
    status: 'succeeded',
    proof_ref: meta.issueProofRef(),
    proof_hash: proofHash,
  };
}

function mapGhFailure(event, operation, result) {
  const classification = result && result.classification;
  const error = classification && classification.error;
  const status = classification && classification.status === 'retryable' ? 'retryable' : 'terminal';
  return {
    event_id: event.event_id,
    status,
    error: {
      code: error && error.code ? error.code : 'GH_UNKNOWN',
      retryable: status === 'retryable',
      message: `${operation} failed: ${error && error.message ? error.message : 'GitHub response was unavailable'}`,
    },
  };
}

function handleSpecApproved(event, opts = {}) {
  const checked = validateEvent(event);
  if (!checked.ok || event.type !== 'spec-approved') {
    return resultError(event, 'ISSUE_INVALID_EVENT', 'Expected a valid spec-approved lifecycle event.');
  }
  const projectRoot = opts.projectRoot;
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return resultError(event, 'ISSUE_NO_PROJECT', 'A project root is required to resolve the approved specification.');
  }
  const spec = specContext(event, projectRoot);
  if (spec.error) return resultError(event, 'STALE_ARTIFACT', `${spec.error}; verify the committed spec artifact before retrying.`);

  const runner = opts.ghRunner;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();
  const repositoryResult = repoView(runner);
  if (!repositoryResult.ok) return mapGhFailure(event, 'Current origin lookup', repositoryResult);
  const repo = repoIdentity(repositoryResult.data);
  if (!repo) return resultError(event, 'ISSUE_ORIGIN_UNVERIFIED', 'Current origin repository identity could not be verified; resolve repository ownership manually.');

  const currentMetadata = meta.readMetaFor(spec.specDir);
  const recorded = currentMetadata.github_issue || {};
  if (Number.isInteger(recorded.number) && recorded.number > 0 || typeof recorded.url === 'string') {
    return resultError(event, 'ISSUE_METADATA_REQUIRES_RECONCILIATION', 'Existing issue metadata must be validated before a new issue can be created.');
  }

  const listed = listOpenPlanIssues(repo, runner);
  if (!listed.ok) return mapGhFailure(event, 'Open pocket-plan issue search', listed);
  const listedIssues = flattenIssuePages(listed.data);
  if (!listedIssues) {
    return resultError(event, 'ISSUE_SEARCH_MALFORMED', 'Open pocket-plan issue search returned a malformed response.');
  }
  const exactMatches = listedIssues.filter((issue) => hasPlanIdentity(issue, event.plan_id, spec.specPath).matches);
  if (exactMatches.length > 1) {
    return resultError(event, 'ISSUE_MANUAL_RESOLUTION', 'Multiple open issues match the exact plan identity; choose one manually before retrying.');
  }
  if (exactMatches.length === 1) {
    const listedMatch = exactMatches[0];
    if (!Number.isInteger(listedMatch.number) || listedMatch.number <= 0
        || !issueUrlBelongsTo(listedMatch, repo)) {
      return resultError(event, 'ISSUE_MANUAL_RESOLUTION', 'Exact plan search returned an issue outside the current origin; resolve ownership manually.');
    }
    const viewed = issueView(repo, listedMatch.number, runner);
    if (!viewed.ok) return mapGhFailure(event, 'Exact issue validation', viewed);
    return proveIssue(event, viewed.data, spec, repo, clock);
  }

  const created = writeIssue(event, runner, spec, repo);
  if (created.error) return mapGhFailure(event, 'Issue creation or validation', created.error);
  if (created.manual) return resultError(event, 'ISSUE_MANUAL_RESOLUTION', `${created.manual}; verify the target manually before retrying.`);
  return proveIssue(event, created.issue, spec, repo, clock);
}

module.exports = { handleSpecApproved };
