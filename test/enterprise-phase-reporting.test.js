'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const enterpriseMeta = require('../enterprise/meta');
const identity = require('../cli/lib/identity');
const { summaryBody } = require('../cli/lib/bodies');
const { FIXED_CLOCK, createFixture } = require('./helpers/enterprise-phase-fixture');
const { allComments, allThreads, fakeGh } = require('./helpers/enterprise-phase-remote');
const { isRemoteMutation, loadPhaseHandler } = require('./helpers/enterprise-phase-test-utils');

// Keep the five behavioral RED cycles verbatim and in source order.
//
// RED cycle 1
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given phase evidence, a valid open PR identified by metadata or exact branch/phase search, and new findings, When the handler runs, Then it updates or creates exactly one `pocket-phase-<N>-summary` marker, reconciles inline findings by the shared fingerprint algorithm, and persists fingerprints at `phases.<phase>.review.fingerprints`.
// Exercise through: `enterprise/phase-handler.js` with fake paginated comments/review-thread APIs and real metadata.
// Test doubles: fake `gh` transport and fixed clock; do not mock marker selection or fingerprint computation.
// Expected RED: current reporting is manual skill prose and no v4 handler owns the complete PR reconciliation transaction.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 1: phase-complete upserts one marker and canonical fingerprints', (t) => {
  const fixture = createFixture(t);
  const handler = loadPhaseHandler();
  assert.ok(handler && typeof handler.handlePhaseComplete === 'function',
    'Expected enterprise/phase-handler.js to own the complete v4 PR reconciliation transaction');

  const response = handler.handlePhaseComplete(fixture.event, {
    projectRoot: fixture.root,
    ghRunner: fakeGh(fixture.remote),
    now: () => new Date(FIXED_CLOCK),
  });

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.equal(response.event_id, fixture.event.event_id);

  const marker = identity.markerFor('1');
  const markerComments = allComments(fixture.remote).filter((comment) => comment.body.startsWith(marker));
  assert.equal(markerComments.length, 1, 'exactly one canonical phase marker must remain');
  assert.equal(markerComments[0].body, summaryBody({
    phase: 1,
    verdicts: [{ task: 'T1', verdict: 'FAIL' }],
    prLinked: true,
  }));

  const expectedFingerprint = identity.fingerprint({
    file: 'src/worker.js',
    ruleId: 'stage-1:spec-compliance',
    message: 'Missing error handling for invalid input',
    occurrence: 0,
  });
  const threads = allThreads(fixture.remote);
  assert.equal(threads.length, 1, 'one new inline finding thread must be posted');
  assert.match(threads[0].comments.nodes[0].body, new RegExp(`<!-- pocket-fp:${expectedFingerprint} -->`));
  assert.deepEqual(enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'].review.fingerprints, [
    { fingerprint: expectedFingerprint, thread: threads[0].id },
  ]);
  assert.ok(fixture.remote.calls.some((args) => args.includes('--paginate')),
    'PR comments must be fetched through the paginated API');
});

// RED cycle 2
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given a valid phase-complete event and PR but no owned issue for the plan, When the handler runs, Then it returns `ISSUE_REQUIRED`, writes no PR comment or metadata proof, and performs no issue creation or other remote mutation.
// Exercise through: the full phase handler using fake issue/PR responses.
// Test doubles: fake `gh issue`/`gh pr` transport; no real network.
// Expected RED: no phase handler enforces the normative existing-issue requirement.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 2: missing owned issue blocks phase reporting without mutation', (t) => {
  const fixture = createFixture(t);
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  delete meta.github_issue;
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  fixture.remote.issue = null;
  fixture.remote.issueSearch = [];
  const metaPath = path.join(fixture.specDir, '.pocket-meta.json');
  const beforeMeta = fs.readFileSync(metaPath, 'utf8');
  const handler = loadPhaseHandler();
  assert.ok(handler && typeof handler.handlePhaseComplete === 'function');

  const response = handler.handlePhaseComplete(fixture.event, {
    projectRoot: fixture.root,
    ghRunner: fakeGh(fixture.remote),
    now: () => new Date(FIXED_CLOCK),
  });

  assert.equal(response.error && response.error.code, 'ISSUE_REQUIRED', JSON.stringify(response));
  assert.equal(allComments(fixture.remote).length, 0, 'missing issue must not write a PR comment');
  assert.equal(allThreads(fixture.remote).length, 0, 'missing issue must not write review threads');
  assert.equal(fixture.remote.calls.filter(isRemoteMutation).length, 0, 'missing issue must perform no remote mutation');
  assert.equal(fs.readFileSync(metaPath, 'utf8'), beforeMeta, 'missing issue must not write metadata proof');
});

