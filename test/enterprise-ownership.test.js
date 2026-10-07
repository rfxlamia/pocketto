'use strict';

// RED cycle 1 — integration.
// Given an open current-repository issue whose title identifies plan A and
// full-spec path identifies plan B, when T8/T10 reconcile plan A, both require
// manual resolution without tasklist/create/comment or metadata mutation.
// Exercise: both real Enterprise handlers, fake paginated gh, real metadata,
// valid plan/event fixtures. Do not mock the validator, handlers, or metadata.
// Expected RED: T8 rejects the title/path conflict while T10 accepts its title.
// Exact command: `node --test test/enterprise-ownership.test.js`
//
// RED cycle 2 — integration.
// Given positive issue-number metadata with a missing URL and an otherwise
// exact open issue candidate, when both handlers validate ownership, neither
// may accept an unverified recorded/candidate URL; stop or use only a fully
// verified exact-search result, without mutating an unverified target/metadata.
// Exercise: both handlers' metadata-first/fallback boundary with real metadata
// and fake paginated gh only; no live network.
// Expected RED: T10 accepts a missing URL where T8 rejects it.
// Exact command: `node --test test/enterprise-ownership.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPOSITORY_URL: T8_REPOSITORY_URL,
  loadIssueHandler,
  makeIssue: makeT8Issue,
  makeProject,
  makeReconciliationTransport,
  runHandler,
  snapshotMetadata,
  writeIssueMetadata,
} = require('../test-support/enterprise-issue/fixtures');
const {
  fs: t10Fs,
  path: t10Path,
  enterpriseMeta: t10Meta,
  ISSUE,
  PLAN_ID: T10_PLAN_ID,
  makeFixture,
  makeEvent,
  makeFakeGh,
} = require('../test-support/enterprise-closeout/fixtures');
const { handlePlanClosed } = require('../enterprise/closure-handler');

function assertNoT8Mutation(transport, specDir, beforeMetadata) {
  assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'create'), false,
    'T8 must not create an issue for an unverified candidate');
  assert.equal(transport.calls.some((args) => args.some((arg) => /comment|tasklist/i.test(String(arg)))), false,
    'T8 must not create a comment or tasklist for an unverified candidate');
  assert.equal(snapshotMetadata(specDir), beforeMetadata,
    'T8 must leave issue metadata unchanged for an unverified candidate');
}

function assertNoT10Mutation(gh, fixture, beforeMetadata) {
  assert.equal(gh.comments.length, 0, 'T10 must not create or update a tasklist comment');
  assert.equal(gh.calls.some(({ args }) => ['POST', 'PATCH', 'DELETE'].some((method) => args.includes(method))), false,
    'T10 must not mutate GitHub comments');
  assert.equal(t10Fs.existsSync(t10Path.join(fixture.planDir, 'closeout.md')), false,
    'T10 must not write closeout.md');
  assert.equal(t10Fs.readFileSync(t10Path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'), beforeMetadata,
    'T10 must leave issue metadata unchanged');
}

test('CYCLE 1: T8 and T10 reject conflicting title and full-spec-path ownership', async (t) => {
  await t.test('T8 spec-approved rejects the conflicting candidate without mutation', () => {
    const fixture = makeProject();
    const issue = makeT8Issue({
      number: 81,
      url: `${T8_REPOSITORY_URL}/issues/81`,
      body: 'Approved specification: docs/pocket/spec/another-approved-plan/approved-spec.md',
    });
    writeIssueMetadata(fixture.specDir, { number: issue.number, url: issue.url });
    const beforeMetadata = snapshotMetadata(fixture.specDir);
    const transport = makeReconciliationTransport({ pages: [[issue], []], issues: { 81: issue } });

    const result = runHandler(loadIssueHandler(), fixture, transport);

    assert.equal(result.status, 'terminal');
    assert.equal(result.error.code, 'ISSUE_MANUAL_RESOLUTION');
    assertNoT8Mutation(transport, fixture.specDir, beforeMetadata);
  });

  await t.test('T10 plan-closed rejects the conflicting candidate without mutation', async (t) => {
    const fixture = makeFixture(t);
    const issue = {
      ...ISSUE,
      title: `Pocket Plan: ${T10_PLAN_ID}`,
      body: 'Full spec: docs/pocket/spec/another-plan/core.md',
    };
    const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
    const beforeMetadata = fs.readFileSync(metadataPath, 'utf8');
    const gh = makeFakeGh([], issue);

    const result = await handlePlanClosed(makeEvent(fixture.planDir), {
      specDir: fixture.specDir,
      planDir: fixture.planDir,
      ghRunner: gh.runner,
    });

    assert.equal(result.status, 'terminal', 'T10 must reject conflicting title/path identity');
    assert.equal(result.error.code, 'ISSUE_OWNERSHIP_AMBIGUOUS');
    assertNoT10Mutation(gh, fixture, beforeMetadata);
  });
});

test('CYCLE 2: T8 and T10 reject incomplete recorded and candidate issue URLs', async (t) => {
  await t.test('T8 does not accept a candidate without a current-origin issue URL', () => {
    const fixture = makeProject();
    const issue = makeT8Issue({ number: 82, url: `${T8_REPOSITORY_URL}/issues/82` });
    delete issue.url;
    writeIssueMetadata(fixture.specDir, { number: issue.number });
    const beforeMetadata = snapshotMetadata(fixture.specDir);
    const transport = makeReconciliationTransport({ pages: [[issue], []], issues: { 82: issue } });

    const result = runHandler(loadIssueHandler(), fixture, transport);

    assert.equal(result.status, 'terminal');
    assert.equal(result.error.code, 'ISSUE_MANUAL_RESOLUTION');
    assertNoT8Mutation(transport, fixture.specDir, beforeMetadata);
  });

  await t.test('T10 rejects a candidate without a current-origin URL even when metadata has one', async (t) => {
    const fixture = makeFixture(t);
    const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
    const beforeMetadata = fs.readFileSync(metadataPath, 'utf8');
    const issue = { ...ISSUE };
    delete issue.html_url;
    delete issue.url;
    const gh = makeFakeGh([], issue);

    const result = await handlePlanClosed(makeEvent(fixture.planDir), {
      specDir: fixture.specDir,
      planDir: fixture.planDir,
      ghRunner: gh.runner,
    });

    assert.equal(result.status, 'terminal', 'T10 must reject missing candidate URL ownership');
    assert.equal(result.error.code, 'ISSUE_OWNERSHIP_AMBIGUOUS');
    assertNoT10Mutation(gh, fixture, beforeMetadata);
  });

  await t.test('T10 rejects missing metadata and candidate URLs', async (t) => {
    const fixture = makeFixture(t);
    const metadata = t10Meta.readMetaFor(fixture.specDir);
    delete metadata.github_issue.url;
    t10Meta.writeMetaFor(fixture.specDir, metadata);
    const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
    const beforeMetadata = fs.readFileSync(metadataPath, 'utf8');
    const issue = { ...ISSUE };
    delete issue.html_url;
    delete issue.url;
    const gh = makeFakeGh([], issue);

    const result = await handlePlanClosed(makeEvent(fixture.planDir), {
      specDir: fixture.specDir,
      planDir: fixture.planDir,
      ghRunner: gh.runner,
    });

    assert.equal(result.status, 'terminal', 'T10 must reject missing metadata URL ownership');
    assert.equal(result.error.code, 'ISSUE_OWNERSHIP_AMBIGUOUS');
    assertNoT10Mutation(gh, fixture, beforeMetadata);
  });
});
