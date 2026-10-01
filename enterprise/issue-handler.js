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

function resultSucceeded(event, proofHash) {
  return {
    event_id: event.event_id,
    status: 'succeeded',
    proof_ref: meta.issueProofRef(),
    proof_hash: proofHash,
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

function containsExactPath(text, expectedPath) {
  const escapedPath = expectedPath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
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

function replayIssueProof(event, spec) {
  if (event.delivery.status !== 'succeeded') return null;
  const recorded = meta.readMetaFor(spec.specDir).github_issue || {};
  const ownership = recorded.ownership || {};
  const identity = ownership.identity;
  const validIdentity = ['title', 'full-spec-path', 'title+full-spec-path'].includes(identity);
  if (event.proof_ref !== meta.issueProofRef()
      || typeof event.proof_hash !== 'string'
      || ownership.event_id !== event.event_id
      || ownership.plan_id !== event.plan_id
      || ownership.spec_path !== spec.specPath
      || typeof ownership.repository !== 'string'
      || !Number.isInteger(recorded.number) || recorded.number <= 0
      || typeof recorded.url !== 'string' || recorded.url.length === 0
      || !validIdentity) {
    return resultError(event, 'ISSUE_PROOF_MISMATCH', 'Succeeded event has no matching persisted issue ownership proof; resolve metadata manually before replay.');
  }
  const expectedHash = computeProofHash({
    event,
    issue: { number: recorded.number, url: recorded.url },
    repository: ownership.repository,
    specPath: ownership.spec_path,
    identity,
  });
  if (expectedHash !== ownership.proof_hash || event.proof_hash !== expectedHash) {
    return resultError(event, 'ISSUE_PROOF_MISMATCH', 'Succeeded event issue proof does not match persisted metadata; resolve metadata manually before replay.');
  }
  return resultSucceeded(event, event.proof_hash);
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

function proveIssue(event, issue, spec, repo, clock) {
  const validation = issueValidation(issue, event, spec, repo);
  if (!validation.ok) {
    return resultError(event, 'ISSUE_MANUAL_RESOLUTION', `Issue could not be safely reconciled: ${validation.reason}; resolve it manually.`);
  }
  const identity = validation.identity;
  const identityProof = identity.titleMatch && identity.pathMatch
    ? 'title+full-spec-path'
    : identity.titleMatch ? 'title' : 'full-spec-path';
  const proofHash = saveIssueProof(spec.specDir, event, issue, repo, spec.specPath, identityProof, clock);
  return resultSucceeded(event, proofHash);
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

function issueViewNotFound(result) {
  const diagnostics = [result && result.raw && result.raw.stderr,
    result && result.classification && result.classification.error && result.classification.error.message]
    .filter(Boolean).join(' ');
  return /(?:issue|pull request).{0,80}(?:not found|could not resolve)|(?:not found|could not resolve).{0,80}(?:issue|pull request)/i.test(diagnostics);
}

function lookupMetadataIssue(event, spec, repo, runner) {
  const recorded = meta.readMetaFor(spec.specDir).github_issue || {};
  const hasRecordedIdentity = (Number.isInteger(recorded.number) && recorded.number > 0)
    || (typeof recorded.url === 'string' && recorded.url.length > 0);
  if (!hasRecordedIdentity) return { hasRecordedIdentity: false };
  if (!Number.isInteger(recorded.number) || recorded.number <= 0
      || typeof recorded.url !== 'string' || recorded.url.length === 0) {
    return { hasRecordedIdentity: true, invalidReason: 'issue metadata is incomplete' };
  }
  const viewed = issueView(repo, recorded.number, runner);
  if (!viewed.ok) {
    if (issueViewNotFound(viewed)) {
      return { hasRecordedIdentity: true, invalidReason: 'recorded issue was not found in the current origin' };
    }
    return { hasRecordedIdentity: true, error: mapGhFailure(event, 'Metadata issue validation', viewed) };
  }
  const validation = issueValidation(viewed.data, event, spec, repo, recorded.url);
  return validation.ok
    ? { hasRecordedIdentity: true, issue: viewed.data }
    : { hasRecordedIdentity: true, invalidReason: validation.reason };
}

function searchExactIssues(event, spec, repo, runner) {
  const listed = listOpenPlanIssues(repo, runner);
  if (!listed.ok) return { error: mapGhFailure(event, 'Open pocket-plan issue search', listed) };
  const issues = flattenIssuePages(listed.data);
  if (!issues) {
    return { error: resultError(event, 'ISSUE_SEARCH_MALFORMED', 'Open pocket-plan issue search returned a malformed response.') };
  }
  if (issues.length >= 1000) {
    return { error: resultError(event, 'ISSUE_SEARCH_INCOMPLETE', 'The open issue search reached its pagination limit; resolve ownership manually instead of selecting a partial result.') };
  }
  const matches = [];
  for (const issue of issues) {
    const identity = hasPlanIdentity(issue, event.plan_id, spec.specPath);
    if (identity.conflicting) {
      return { error: resultError(event, 'ISSUE_MANUAL_RESOLUTION', 'An open pocket-plan issue has conflicting title/full-spec identity; resolve it manually.') };
    }
    if (!identity.matches) continue;
    const repositoryMatches = !issue.repository || !issue.repository.nameWithOwner
      || issue.repository.nameWithOwner.toLowerCase() === repo.nameWithOwner.toLowerCase();
    if (!labelsOf(issue).includes(ISSUE_LABEL) || String(issue.state).toUpperCase() !== 'OPEN'
        || !issueUrlBelongsTo(issue, repo) || !repositoryMatches) {
      return { error: resultError(event, 'ISSUE_MANUAL_RESOLUTION', 'An exact plan issue is closed, foreign, or otherwise conflicting; resolve ownership manually.') };
    }
    matches.push(issue);
  }
  if (matches.length > 1) {
    return { error: resultError(event, 'ISSUE_MANUAL_RESOLUTION', 'Multiple open issues match the exact plan identity; choose one manually before retrying.') };
  }
  return { matches };
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
  const replay = replayIssueProof(event, spec);
  if (replay) return replay;

  const runner = opts.ghRunner;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();
  const repositoryResult = repoView(runner);
  if (!repositoryResult.ok) return mapGhFailure(event, 'Current origin lookup', repositoryResult);
  const repo = repoIdentity(repositoryResult.data);
  if (!repo) return resultError(event, 'ISSUE_ORIGIN_UNVERIFIED', 'Current origin repository identity could not be verified; resolve repository ownership manually.');

  const metadata = lookupMetadataIssue(event, spec, repo, runner);
  if (metadata.error) return metadata.error;
  if (metadata.issue) return proveIssue(event, metadata.issue, spec, repo, clock);

  const search = searchExactIssues(event, spec, repo, runner);
  if (search.error) return search.error;
  if (search.matches.length === 1) {
    const viewed = issueView(repo, search.matches[0].number, runner);
    if (!viewed.ok) return mapGhFailure(event, 'Exact issue validation', viewed);
    return proveIssue(event, viewed.data, spec, repo, clock);
  }
  if (metadata.hasRecordedIdentity) {
    return resultError(event, 'ISSUE_MANUAL_RESOLUTION', `Recorded issue metadata is invalid (${metadata.invalidReason || 'identity mismatch'}) and no exact open current-origin issue was found; resolve it manually rather than creating a duplicate.`);
  }

  const created = writeIssue(event, runner, spec, repo);
  if (created.error) return mapGhFailure(event, 'Issue creation or validation', created.error);
  if (created.manual) return resultError(event, 'ISSUE_MANUAL_RESOLUTION', `${created.manual}; verify the target manually before retrying.`);
  return proveIssue(event, created.issue, spec, repo, clock);
}

module.exports = { handleSpecApproved };
