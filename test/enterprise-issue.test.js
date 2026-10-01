'use strict';

// T8 Cycle 1: issue creation from spec-approved with no existing owned issue.
// Given a pending `spec-approved` event with valid spec artifacts, no owned
// issue metadata, and zero open `pocket-plan` issues matching the exact
// normalized plan identity in the current origin repository, When the handler
// runs, Then it creates exactly one issue and records number/URL/ownership
// proof in `.pocket-meta.json`.
// Exercise through `enterprise/issue-handler.js` with a fake `gh` transport
// and real temporary metadata. Fake GitHub responses and clock; do not mock
// reconciliation or metadata storage.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const enterpriseMeta = require('../enterprise/meta');

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
      // `gh issue list --limit` returns all pages; nested pages keep the fake
      // transport explicit about the pagination boundary.
      return { exit: 0, stdout: JSON.stringify([[unrelated], []]), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      return { exit: 0, stdout: `${issue.url}\n`, stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view' && args[2] === String(issue.number)) {
      return { exit: 0, stdout: JSON.stringify(issue), stderr: '' };
    }
    return { exit: 1, stdout: '', stderr: `Unexpected fake gh command: ${args.join(' ')}` };
  };
  return { calls, runner };
}

function loadIssueHandler() {
  try {
    return require('../enterprise/issue-handler');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /enterprise\/issue-handler/.test(err.message)) return null;
    throw err;
  }
}

test('CYCLE 1: creates one issue for a pending approved spec with no exact open match', () => {
  const fixture = makeProject();
  const transport = makeZeroMatchTransport();
  const handler = loadIssueHandler();

  // Keep a missing production module as an assertion failure, not a test
  // import/setup error: this is the expected pre-implementation RED.
  assert.ok(handler && typeof handler.handleSpecApproved === 'function',
    'a deterministic spec-approved issue handler must exist');

  const result = handler.handleSpecApproved(fixture.event, {
    projectRoot: fixture.projectRoot,
    ghRunner: transport.runner,
    clock: () => new Date(FIXED_TIME),
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.proof_ref, enterpriseMeta.issueProofRef());
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 1,
    'exactly one issue must be created');
  const searches = transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'list');
  assert.equal(searches.length, 1, 'search must happen before creation');
  assert.ok(searches[0].includes('--repo') && searches[0].includes(REPOSITORY),
    'search must be scoped to the current origin repository');
  assert.ok(searches[0].includes('--state') && searches[0].includes('open'),
    'search must include only open issues');
  assert.ok(searches[0].includes('--label') && searches[0].includes('pocket-plan'),
    'search must be scoped to the pocket-plan label');

  const metadata = JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8'));
  assert.equal(metadata.github_issue.number, 42);
  assert.equal(metadata.github_issue.url, ISSUE_URL);
  assert.equal(metadata.github_issue.ownership.plan_id, PLAN_ID);
  assert.equal(metadata.github_issue.ownership.repository, REPOSITORY);
  assert.equal(metadata.github_issue.ownership.event_id, EVENT_ID);
  assert.equal(metadata.github_issue.ownership.spec_path, 'docs/pocket/spec/demo-approved-plan/approved-spec.md');
  assert.match(metadata.github_issue.ownership.proof_hash, /^[0-9a-f]{64}$/);
});
