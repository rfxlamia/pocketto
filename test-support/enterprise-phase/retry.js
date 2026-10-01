'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const enterpriseMeta = require('../../enterprise/meta');
const identity = require('../../cli/lib/identity');
const { FIXED_CLOCK, PR_NUMBER, createFixture } = require('./fixture');
const { allThreads, fakeGh } = require('./remote');
const { loadPhaseHandler } = require('./test-utils');
const { handlerOptions, inlinePostCount, staleResolveCount } = require('./replay-utils');

// T9 cycle-2 corrective RED
// Test file: `test/enterprise-phase.test.js`
// Level: integration.
// Test intent: Given a legacy `phases.<phase>.fingerprints` entry with an untagged remote thread ID and the matching finding is removed, When GitHub thread resolution fails transiently, Then the handler must not report success, must retain the legacy/thread ID in durable canonical proof for retry, must not repost the finding, and must not mutate/delete the legacy field; when the same event is replayed and resolution succeeds, Then it resolves that same thread ID exactly once, completes without duplicate post, and updates canonical proof safely while the legacy field remains unchanged.
// Exercise through: `enterprise/phase-handler.js` with fake paginated review-thread/issue-comment transport and real metadata serialization.
// Test doubles: fake GitHub transport only; no network; do not mock reconciliation, proof serialization, or identity computation.
// Expected RED: the current handler swallows the resolve error, returns success, drops the only untagged thread ID from canonical metadata, and replay cannot resolve the thread.
// Exact command: `node --test test/enterprise-phase.test.js`

test('T9 corrective RED: failed legacy thread resolution preserves proof through same-event replay', (t) => {
  assertFailedThreadResolutionReplay(prepareFailedResolutionScenario(t));
});

function prepareFailedResolutionScenario(t) {
  const fixture = createFixture(t);
  const fingerprint = identity.fingerprint({
    file: 'src/worker.js',
    ruleId: 'stage-1:spec-compliance',
    message: 'Missing error handling for invalid input',
    occurrence: 0,
  });
  const legacy = [{ fingerprint, thread: 'PRRT_LEGACY_RETRY' }];
  const legacyJson = JSON.stringify(legacy);
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  delete meta.phases['phase-1'].review;
  meta.phases['phase-1'].fingerprints = legacy;
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  fixture.remote.prs[0].threadPages[1].push({
    id: 'PRRT_LEGACY_RETRY',
    isResolved: false,
    comments: { nodes: [{ body: 'Removed finding without a pocket-fp tag', path: 'src/worker.js', line: 18 }] },
  });
  markFindingRemoved(fixture);
  fixture.remote.resolveFailuresRemaining = 1;
  const handler = loadPhaseHandler();
  assert.ok(handler && typeof handler.handlePhaseComplete === 'function');
  return { fixture, handler, legacy, legacyJson, options: handlerOptions(fixture) };
}

function markFindingRemoved(fixture) {
  fs.writeFileSync(path.join(fixture.planDir, 'reviews', 'T1-review.json'), JSON.stringify({
    task_id: 'T1',
    overall: 'REVIEW_PASS',
    stage_1: { issues: [] },
    stage_2: { issues: [] },
  }, null, 2) + '\n');
}

function assertFailedThreadResolutionReplay(scenario) {
  const { fixture, handler, legacy, legacyJson, options } = scenario;
  const metaPath = path.join(fixture.specDir, '.pocket-meta.json');
  const firstResponse = handler.handlePhaseComplete(fixture.event, options);
  const afterFailure = enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'];
  assertFailedResolutionProof(fixture, firstResponse, afterFailure, legacy, metaPath);
  const replayResponse = handler.handlePhaseComplete(fixture.event, options);
  const afterReplay = enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'];
  assertSuccessfulResolutionReplay(fixture, replayResponse, afterReplay, legacy, legacyJson);
}

function assertFailedResolutionProof(fixture, response, phaseMeta, legacy, metaPath) {
  assert.deepEqual({
    retryStatus: ['retryable', 'reconciling'].includes(response.status),
    canonicalProof: phaseMeta.review && phaseMeta.review.fingerprints,
  }, {
    retryStatus: true,
    canonicalProof: legacy,
  }, 'an unconfirmed resolution failure must retry without dropping the legacy thread ID');
  assert.deepEqual(phaseMeta.fingerprints, legacy, 'the legacy fingerprint field must remain unchanged');
  assert.equal(fs.readFileSync(metaPath, 'utf8').includes('PRRT_LEGACY_RETRY'), true,
    'serialized metadata must durably retain the only thread ID');
  assert.equal(inlinePostCount(fixture.remote), 0, 'failed resolution must not repost the removed finding');
  assert.equal(allThreads(fixture.remote).find((thread) => thread.id === 'PRRT_LEGACY_RETRY').isResolved, false,
    'transient failure must leave the remote thread unresolved');
  assertPaginatedTransportUsed(fixture.remote);
}

function assertPaginatedTransportUsed(remote) {
  assert.ok(remote.calls.some((args) => args[0] === 'api'
    && args[1] === 'graphql' && args.includes('after=cursor-1')),
  'the legacy thread must be discovered through paginated review-thread transport');
  assert.ok(remote.calls.some((args) => args[0] === 'api'
    && String(args[1]).endsWith(`/issues/${PR_NUMBER}/comments`)
    && args.includes('--paginate')),
  'phase comments must use the paginated issue-comment transport');
}

function assertSuccessfulResolutionReplay(fixture, response, phaseMeta, legacy, legacyJson) {
  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.equal(staleResolveCount(fixture.remote), 2, 'replay must retry the same legacy thread ID once after the failed attempt');
  assert.equal(fixture.remote.successfulResolutions, 1, 'the thread must be successfully resolved exactly once');
  assert.equal(allThreads(fixture.remote).find((thread) => thread.id === 'PRRT_LEGACY_RETRY').isResolved, true);
  assert.equal(inlinePostCount(fixture.remote), 0, 'replay must not create a duplicate inline finding');
  assert.deepEqual(phaseMeta.review.fingerprints, [], 'canonical proof may drop the ID only after resolution is confirmed');
  assert.deepEqual(phaseMeta.fingerprints, legacy, 'successful replay must not mutate the legacy field');
  assert.equal(JSON.stringify(phaseMeta.fingerprints), legacyJson);
}

test('confirmed missing review thread is an idempotent resolution outcome', (t) => {
  const fixture = createFixture(t);
  const legacy = [{ fingerprint: '8'.repeat(16), thread: 'PRRT_ALREADY_MISSING' }];
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  delete meta.phases['phase-1'].review;
  meta.phases['phase-1'].fingerprints = legacy;
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  markFindingRemoved(fixture);
  const handler = loadPhaseHandler();

  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.equal(staleResolveCount(fixture.remote), 1, 'the missing ID must be submitted for remote resolution');
  assert.ok(fixture.remote.calls.some((args) => args[0] === 'api'
    && args[1] === 'graphql' && args.includes('after=cursor-1')),
  'absence must be confirmed by re-reading all paginated review threads');
  assert.deepEqual(enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'].review.fingerprints, []);
  assert.deepEqual(enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'].fingerprints, legacy);
  assert.equal(inlinePostCount(fixture.remote), 0);
});
