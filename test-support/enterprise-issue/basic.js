'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  EVENT_ID,
  FIXED_TIME,
  ISSUE_URL,
  PLAN_ID,
  REPOSITORY,
  enterpriseMeta,
  loadIssueHandler,
  makeIssue,
  makeProject,
  makeSingleMatchTransport,
  makeZeroMatchTransport,
  runHandler,
} = require('./fixtures');

// T8 Cycle 1: one issue is created for a pending approved spec with no exact match.
test('CYCLE 1: creates one issue for a pending approved spec with no exact open match', () => {
  const fixture = makeProject();
  const transport = makeZeroMatchTransport();
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'a deterministic spec-approved issue handler must exist');

  const result = runHandler(handler, fixture, transport);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.proof_ref, enterpriseMeta.issueProofRef());
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 1,
    'exactly one issue must be created');
  const searches = transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'list');
  assert.equal(searches.length, 1, 'search must happen before creation');
  assert.ok(searches[0].includes('--repo') && searches[0].includes(REPOSITORY), 'search must use the current origin');
  assert.ok(searches[0].includes('--state') && searches[0].includes('open'), 'search must include only open issues');
  assert.ok(searches[0].includes('--label') && searches[0].includes('pocket-plan'), 'search must use the pocket-plan label');

  const metadata = JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8'));
  assert.equal(metadata.github_issue.number, 42);
  assert.equal(metadata.github_issue.url, ISSUE_URL);
  assert.equal(metadata.github_issue.ownership.plan_id, PLAN_ID);
  assert.equal(metadata.github_issue.ownership.repository, REPOSITORY);
  assert.equal(metadata.github_issue.ownership.event_id, EVENT_ID);
  assert.equal(metadata.github_issue.ownership.spec_path, 'docs/pocket/spec/demo-approved-plan/approved-spec.md');
  assert.match(metadata.github_issue.ownership.proof_hash, /^[0-9a-f]{64}$/);
  assert.match(transport.createdBodies[0], /docs\/pocket\/spec\/demo-approved-plan\/approved-spec\.md/);
  assert.ok(transport.createdBodies[0].includes(fixture.specMarkdown), 'the issue body must carry the approved specification');
});

// T8 Cycle 2: one exact open current-origin match is reused without duplication.
test('CYCLE 2: reuses one open current-origin exact-plan issue without creating a duplicate', () => {
  const fixture = makeProject();
  const existing = makeIssue({ number: 52, url: 'https://github.com/pocketto/example/issues/52' });
  const transport = makeSingleMatchTransport(existing);
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'issue handler must be available');

  const result = runHandler(handler, fixture, transport);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.proof_ref, enterpriseMeta.issueProofRef());
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 0,
    'an existing exact issue must not be duplicated');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'view').length, 1,
    'the search candidate must be fetched and validated in the current origin');
  const metadata = JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8'));
  assert.equal(metadata.github_issue.number, 52);
  assert.equal(metadata.github_issue.url, existing.url);
  assert.equal(metadata.github_issue.ownership.plan_id, PLAN_ID);
  assert.equal(metadata.github_issue.ownership.event_id, EVENT_ID);
});
