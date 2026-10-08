'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const enterpriseMeta = require('../../enterprise/meta');

const PLAN_ID = 'demo-approved-plan';
const REPOSITORY = 'pocketto/example';
const REPOSITORY_URL = 'https://github.com/pocketto/example';
const ISSUE_URL = `${REPOSITORY_URL}/issues/42`;
const EVENT_ID = `${PLAN_ID}:spec-approved:r1`;
const FIXED_TIME = '2026-09-19T12:00:00.000Z';

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-issue-'));
  const specDir = path.join(projectRoot, 'docs', 'pocket', 'spec', PLAN_ID);
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'approved-spec.md');
  const specMarkdown = [
    '# Approved plan',
    '',
    '## Summary',
    'A plan that needs one owned issue.',
    '',
    '## Acceptance Criteria',
    '- The issue belongs to this exact plan.',
    '',
  ].join('\n');
  fs.writeFileSync(specPath, specMarkdown);
  const specHash = crypto.createHash('sha256').update(specMarkdown).digest('hex');
  const event = {
    event_id: EVENT_ID,
    plan_id: PLAN_ID,
    type: 'spec-approved',
    revision: 1,
    occurred_at: FIXED_TIME,
    artifact_refs: [{ root: 'spec', kind: 'approved-spec', path: 'approved-spec.md', sha256: specHash, revision: 1 }],
    payload_hash: 'a'.repeat(64),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 0 },
  };
  return { projectRoot, specDir, specPath, specMarkdown, event };
}

function makeIssue({
  number = 42,
  url = ISSUE_URL,
  state = 'OPEN',
  title = `Pocket Plan: ${PLAN_ID}`,
  body = `Approved specification: docs/pocket/spec/${PLAN_ID}/approved-spec.md`,
  labels = [{ name: 'pocket-plan' }],
} = {}) {
  return { number, url, state, title, body, labels, createdAt: FIXED_TIME };
}

function makeZeroMatchTransport(issue = makeIssue()) {
  const calls = [];
  const createdBodies = [];
  const runner = (args) => {
    calls.push(args.slice());
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify({ nameWithOwner: REPOSITORY, url: REPOSITORY_URL }), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      const unrelated = makeIssue({
        number: 41,
        url: `${REPOSITORY_URL}/issues/41`,
        title: 'Pocket Plan: another-approved-plan',
        body: 'Approved specification: docs/pocket/spec/another-approved-plan/approved-spec.md',
      });
      return { exit: 0, stdout: JSON.stringify([[unrelated], []]), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const bodyFileIndex = args.indexOf('--body-file');
      if (bodyFileIndex >= 0) createdBodies.push(fs.readFileSync(args[bodyFileIndex + 1], 'utf8'));
      return { exit: 0, stdout: `${issue.url}\n`, stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view' && args[2] === String(issue.number)) {
      return { exit: 0, stdout: JSON.stringify(issue), stderr: '' };
    }
    return { exit: 1, stdout: '', stderr: `Unexpected fake gh command: ${args.join(' ')}` };
  };
  return { calls, createdBodies, runner };
}

function makeSingleMatchTransport(issue) {
  const calls = [];
  const runner = (args) => {
    calls.push(args.slice());
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify({ nameWithOwner: REPOSITORY, url: REPOSITORY_URL }), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      return { exit: 0, stdout: JSON.stringify([[issue], []]), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view' && args[2] === String(issue.number)) {
      return { exit: 0, stdout: JSON.stringify(issue), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      return { exit: 1, stdout: '', stderr: 'duplicate issue creation is forbidden in this test' };
    }
    return { exit: 1, stdout: '', stderr: `Unexpected fake gh command: ${args.join(' ')}` };
  };
  return { calls, runner };
}

function makeReconciliationTransport({ pages = [[]], issues = {}, repository = { nameWithOwner: REPOSITORY, url: REPOSITORY_URL } } = {}) {
  const calls = [];
  const runner = (args) => {
    calls.push(args.slice());
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify(repository), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      return { exit: 0, stdout: JSON.stringify(pages), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      const issue = issues[Number(args[2])];
      if (issue) return { exit: 0, stdout: JSON.stringify(issue), stderr: '' };
      return { exit: 1, stdout: '', stderr: 'issue not found in fake current repository' };
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      return { exit: 1, stdout: '', stderr: 'issue creation is forbidden in this test' };
    }
    return { exit: 1, stdout: '', stderr: `Unexpected fake gh command: ${args.join(' ')}` };
  };
  return { calls, runner };
}

function makeNearMatchThenCreateTransport(nearMatch, createdIssue) {
  const calls = [];
  const runner = (args) => {
    calls.push(args.slice());
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify({ nameWithOwner: REPOSITORY, url: REPOSITORY_URL }), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      return { exit: 0, stdout: JSON.stringify([[nearMatch], []]), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      return { exit: 0, stdout: `${createdIssue.url}\n`, stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view' && args[2] === String(createdIssue.number)) {
      return { exit: 0, stdout: JSON.stringify(createdIssue), stderr: '' };
    }
    return { exit: 1, stdout: '', stderr: `Unexpected fake gh command: ${args.join(' ')}` };
  };
  return { calls, runner };
}

function writeIssueMetadata(specDir, issue) {
  const value = enterpriseMeta.readMetaFor(specDir);
  value.github_issue = { ...issue };
  enterpriseMeta.writeMetaFor(specDir, value);
}

function snapshotMetadata(specDir) {
  const target = enterpriseMeta.resolveMetaPath(specDir);
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
}

function loadIssueHandler() {
  try {
    return require('../../enterprise/issue-handler');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /enterprise\/issue-handler/.test(err.message)) return null;
    throw err;
  }
}

function runHandler(handler, fixture, transport) {
  return handler.handleSpecApproved(fixture.event, {
    projectRoot: fixture.projectRoot,
    ghRunner: transport.runner,
    clock: () => new Date(FIXED_TIME),
  });
}

module.exports = {
  EVENT_ID,
  FIXED_TIME,
  ISSUE_URL,
  PLAN_ID,
  REPOSITORY,
  REPOSITORY_URL,
  enterpriseMeta,
  loadIssueHandler,
  makeIssue,
  makeNearMatchThenCreateTransport,
  makeProject,
  makeReconciliationTransport,
  makeSingleMatchTransport,
  makeZeroMatchTransport,
  runHandler,
  snapshotMetadata,
  writeIssueMetadata,
};
