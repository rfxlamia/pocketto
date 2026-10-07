'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  PLAN_ID,
  REPOSITORY,
  REPOSITORY_URL,
  enterpriseMeta,
  loadIssueHandler,
  makeIssue,
  makeNearMatchThenCreateTransport,
  makeProject,
  makeReconciliationTransport,
  runHandler,
  snapshotMetadata,
  writeIssueMetadata,
} = require('./fixtures');

function assertManualResolution(scenario) {
  const fixture = makeProject();
  const before = snapshotMetadata(fixture.specDir);
  const transport = makeReconciliationTransport(scenario);
  const result = runHandler(loadIssueHandler(), fixture, transport);
  assert.equal(result.status, 'terminal', `${scenario.name} requires manual resolution`);
  assert.match(result.error.code, /MANUAL|OWNERSHIP|CONFLICT/);
  assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'create'), false,
    `${scenario.name}: no issue may be created`);
  assert.equal(snapshotMetadata(fixture.specDir), before, `${scenario.name}: metadata must not mutate`);
}

// T8 Cycle 3: positive metadata is validated before search; invalid metadata falls back safely.
test('CYCLE 3: wrong-origin metadata falls back to a unique exact current-origin issue', () => {
  const fixture = makeProject();
  const wrongOrigin = makeIssue({ number: 99, url: 'https://github.com/other/repo/issues/99' });
  writeIssueMetadata(fixture.specDir, wrongOrigin);
  const exact = makeIssue({ number: 52, url: `${REPOSITORY_URL}/issues/52` });
  const transport = makeReconciliationTransport({ pages: [[exact], []], issues: { 99: wrongOrigin, 52: exact } });
  const result = runHandler(loadIssueHandler(), fixture, transport);
  assert.equal(result.status, 'succeeded', 'a unique exact current-origin fallback is safe to reuse');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 0);
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'list').length, 1,
    'invalid metadata must fall back to exact current-origin search');
  const metadata = JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8'));
  assert.equal(metadata.github_issue.number, 52);
  assert.equal(metadata.github_issue.ownership.repository, REPOSITORY);
});

test('CYCLE 3: missing metadata target falls back to a unique exact issue', () => {
  const fixture = makeProject();
  writeIssueMetadata(fixture.specDir, makeIssue({ number: 69, url: `${REPOSITORY_URL}/issues/69` }));
  const exact = makeIssue({ number: 70, url: `${REPOSITORY_URL}/issues/70` });
  const transport = makeReconciliationTransport({ pages: [[exact], []], issues: { 70: exact } });
  const result = runHandler(loadIssueHandler(), fixture, transport);
  assert.equal(result.status, 'succeeded', 'a stale issue number must fall back to a unique exact current-origin match');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'list').length, 1);
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 0);
  assert.equal(JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8')).github_issue.number, 70);
});

test('CYCLE 3: closed metadata target stops without mutation when exact search is empty', () => {
  const fixture = makeProject();
  const closed = makeIssue({ number: 60, url: `${REPOSITORY_URL}/issues/60`, state: 'CLOSED' });
  writeIssueMetadata(fixture.specDir, closed);
  const before = snapshotMetadata(fixture.specDir);
  const transport = makeReconciliationTransport({ pages: [[]], issues: { 60: closed } });
  const result = runHandler(loadIssueHandler(), fixture, transport);
  assert.equal(result.status, 'terminal');
  assert.match(result.error.code, /MANUAL|OWNERSHIP|CONFLICT/);
  assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'list'), true);
  assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'create'), false);
  assert.equal(snapshotMetadata(fixture.specDir), before, 'closed issue metadata must remain unchanged');
});

test('CYCLE 3: wrong-plan metadata target stops without mutation when exact search is empty', () => {
  const fixture = makeProject();
  const wrongPlan = makeIssue({
    number: 61,
    url: `${REPOSITORY_URL}/issues/61`,
    title: 'Pocket Plan: another-approved-plan',
    body: 'docs/pocket/spec/another-approved-plan/approved-spec.md',
  });
  writeIssueMetadata(fixture.specDir, wrongPlan);
  const before = snapshotMetadata(fixture.specDir);
  const transport = makeReconciliationTransport({ pages: [[]], issues: { 61: wrongPlan } });
  const result = runHandler(loadIssueHandler(), fixture, transport);
  assert.equal(result.status, 'terminal');
  assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'list'), true);
  assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'create'), false);
  assert.equal(snapshotMetadata(fixture.specDir), before, 'wrong-plan metadata must remain unchanged');
});

// Exact cardinality and ownership conflicts are fail-closed with no mutations.
test('CYCLE 3: multiple exact matches stop for manual resolution', () => assertManualResolution({
  name: 'multiple exact matches',
  pages: [[
    makeIssue({ number: 62, url: `${REPOSITORY_URL}/issues/62` }),
    makeIssue({ number: 63, url: `${REPOSITORY_URL}/issues/63` }),
  ], []],
  issues: {},
}));

test('CYCLE 3: foreign-owned exact match stops for manual resolution', () => assertManualResolution({
  name: 'foreign-owned exact match',
  pages: [[makeIssue({ number: 64, url: 'https://github.com/other/repo/issues/64' })], []],
  issues: {},
}));

test('CYCLE 3: conflicting title and full-spec path stop for manual resolution', () => {
  const issue = makeIssue({
    number: 65,
    url: `${REPOSITORY_URL}/issues/65`,
    body: 'Approved specification: docs/pocket/spec/some-other-plan/approved-spec.md',
  });
  assertManualResolution({
    name: 'manually conflicting exact title and full-spec path',
    pages: [[issue], []],
    issues: { 65: issue },
  });
});

test('CYCLE 3: valid positive metadata is validated before search and reused', () => {
  const fixture = makeProject();
  const existing = makeIssue({ number: 66, url: `${REPOSITORY_URL}/issues/66` });
  writeIssueMetadata(fixture.specDir, existing);
  const transport = makeReconciliationTransport({ pages: [[]], issues: { 66: existing } });
  const result = runHandler(loadIssueHandler(), fixture, transport);
  assert.equal(result.status, 'succeeded');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'view').length, 1);
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'list').length, 0,
    'valid metadata should be reconciled before search');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 0);
});

test('CYCLE 3: a spec-path prefix near-match does not establish exact plan identity', () => {
  const fixture = makeProject();
  const targetPath = `docs/pocket/spec/${PLAN_ID}/approved-spec.md`;
  const nearMatch = makeIssue({ number: 67, url: `${REPOSITORY_URL}/issues/67`, title: 'Manual plan context', body: `Related artifact: ${targetPath}.backup` });
  const createdIssue = makeIssue({ number: 68, url: `${REPOSITORY_URL}/issues/68` });
  const transport = makeNearMatchThenCreateTransport(nearMatch, createdIssue);
  const result = runHandler(loadIssueHandler(), fixture, transport);
  assert.equal(result.status, 'succeeded');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 1,
    'a non-exact path must not suppress creation of the unique exact plan issue');
  const metadata = JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8'));
  assert.equal(metadata.github_issue.number, 68, 'ownership must point to the issue with exact identity, not a path-prefix near-match');
});
