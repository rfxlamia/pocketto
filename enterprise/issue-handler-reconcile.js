'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { issueBody } = require('../cli/lib/bodies');
const github = require('./github');
const meta = require('./meta');
const { resultError } = require('./issue-handler-proof');
const {
  ISSUE_FIELDS,
  ISSUE_LABEL,
  flattenIssuePages,
  parseCreatedIssueNumber,
} = require('./issue-handler-identity');
const { validateIssueOwnership } = require('./issue-identity');

function repoView(runner) {
  return github.runGh(['repo', 'view', '--json', 'nameWithOwner,url'], {
    runner,
    expectJson: true,
  });
}

function listOpenPlanIssues(repo, runner) {
  return github.runGh([
    'issue', 'list', '--repo', repo.nameWithOwner,
    '--state', 'open', '--label', ISSUE_LABEL, '--limit', '1000', '--json', ISSUE_FIELDS,
  ], { runner, expectJson: true });
}

function issueView(repo, number, runner) {
  return github.runGh([
    'issue', 'view', String(number), '--repo', repo.nameWithOwner, '--json', ISSUE_FIELDS,
  ], { runner, expectJson: true });
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
      try { fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
    }
  }
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
  const validation = validateIssueOwnership(viewed.data, {
    repo,
    planId: event.plan_id,
    specPath: spec.specPath,
    expectedUrl: recorded.url,
    expectedNumber: recorded.number,
    requiredLabel: ISSUE_LABEL,
  });
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
    const validation = validateIssueOwnership(issue, {
      repo,
      planId: event.plan_id,
      specPath: spec.specPath,
      requiredLabel: ISSUE_LABEL,
    });
    if (validation.identity.conflicting) {
      return { error: resultError(event, 'ISSUE_MANUAL_RESOLUTION', 'An open pocket-plan issue has conflicting title/full-spec identity; resolve it manually.') };
    }
    if (!validation.identity.matches) continue;
    if (!validation.ok) {
      return { error: resultError(event, 'ISSUE_MANUAL_RESOLUTION', 'An exact plan issue is closed, foreign, or otherwise conflicting; resolve ownership manually.') };
    }
    matches.push(issue);
  }
  if (matches.length > 1) {
    return { error: resultError(event, 'ISSUE_MANUAL_RESOLUTION', 'Multiple open issues match the exact plan identity; choose one manually before retrying.') };
  }
  return { matches };
}

module.exports = { issueView, lookupMetadataIssue, mapGhFailure, repoView, searchExactIssues, writeIssue };
