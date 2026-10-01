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

// Corrective RED subcycle (T9 cycle-1 finding)
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given a legacy fingerprint with a thread ID, a currently matching finding, and a remote thread without a `pocket-fp` tag, When the phase handler reconciles the finding, Then the canonical `phases.<phase>.review.fingerprints` record retains the legacy thread ID, the legacy field remains byte/semantically unchanged, and no duplicate finding post occurs; when a subsequent event removes that finding, the handler uses the retained ID to resolve the thread exactly once and leaves the legacy field unchanged.
// Exercise through: `enterprise/phase-handler.js` with fake paginated GitHub thread/comment transport and real `.pocket-meta.json` serialization.
// Test doubles: fake GitHub API only; no network; do not mock fingerprint/set-diff reconciliation or metadata store.
// Expected RED: current merge of prior legacy records and newly derived `keep` records loses the untagged thread ID; the later removal cannot resolve the remote thread.
// Exact command: `node --test test/enterprise-phase.test.js`

test('corrective RED: legacy untagged thread proof survives finding keep and resolves on removal', (t) => {
  const scenario = prepareLegacyScenario(t);
  const match = runLegacyMatch(scenario);
  const removalEvent = writeRemovalEvidence(scenario.fixture);
  const removal = runLegacyRemoval(scenario, removalEvent);
  assertLegacyRemovalProof(scenario, match, removal);
});

function prepareLegacyScenario(t) {
  const fixture = createFixture(t);
  const legacy = [{
    fingerprint: identity.fingerprint({
      file: 'src/worker.js',
      ruleId: 'stage-1:spec-compliance',
      message: 'Missing error handling for invalid input',
      occurrence: 0,
    }),
    thread: 'PRRT_LEGACY',
  }];
  const legacyJson = JSON.stringify(legacy);
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  delete meta.phases['phase-1'].review;
  meta.phases['phase-1'].fingerprints = legacy;
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  fixture.remote.prs[0].threadPages[1].push({
    id: 'PRRT_LEGACY',
    isResolved: false,
    comments: { nodes: [{ body: 'Existing finding without a pocket-fp tag', path: 'src/worker.js', line: 18 }] },
  });
  const handler = loadPhaseHandler();
  assert.ok(handler && typeof handler.handlePhaseComplete === 'function');
  const options = {
    projectRoot: fixture.root,
    ghRunner: fakeGh(fixture.remote),
    now: () => new Date(FIXED_CLOCK),
  };
  return { fixture, handler, legacy, legacyJson, options };
}

function runLegacyMatch({ fixture, handler, options }) {
  const response = handler.handlePhaseComplete(fixture.event, options);
  const afterMatch = enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'];
  return {
    response,
    canonical: afterMatch.review.fingerprints,
    legacyJson: JSON.stringify(afterMatch.fingerprints),
    inlinePosts: inlinePostCount(fixture.remote),
  };
}

function writeRemovalEvidence(fixture) {
  const reviewPath = path.join(fixture.planDir, 'reviews', 'T1-review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({
    task_id: 'T1',
    overall: 'REVIEW_PASS',
    stage_1: { issues: [] },
    stage_2: { issues: [] },
  }, null, 2) + '\n');
  const removalEvent = {
    ...fixture.event,
    event_id: `${fixture.event.plan_id}:phase-complete:r2`,
    revision: 2,
    occurred_at: '2026-09-19T12:01:00.000Z',
    delivery: { status: 'pending', attempts: 1 },
  };
  const lifecyclePath = path.join(fixture.specDir, 'lifecycle.json');
  const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  lifecycle.events.push(removalEvent);
  fs.writeFileSync(lifecyclePath, JSON.stringify(lifecycle, null, 2) + '\n');
  return removalEvent;
}

function runLegacyRemoval({ fixture, handler, options }, event) {
  const response = handler.handlePhaseComplete(event, options);
  const afterRemoval = enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'];
  const resolutionCalls = fixture.remote.calls.filter((args) => args[0] === 'api'
    && args[1] === 'graphql'
    && args.some((arg) => String(arg).includes('resolveReviewThread'))
    && args.includes('threadId=PRRT_LEGACY'));
  return { response, afterRemoval, resolutionCalls, inlinePosts: inlinePostCount(fixture.remote) };
}

function assertLegacyRemovalProof({ fixture, legacy, legacyJson }, match, removal) {
  assert.equal(match.response.status, 'succeeded', JSON.stringify(match.response));
  assert.equal(removal.response.status, 'succeeded', JSON.stringify(removal.response));
  assert.ok(fixture.remote.calls.some((args) => args[0] === 'api'
    && args[1] === 'graphql'
    && args.includes('after=cursor-1')),
  'the untagged legacy thread must be read from the later paginated thread page');
  assert.ok(fixture.remote.calls.some((args) => args[0] === 'api'
    && String(args[1]).endsWith(`/issues/${PR_NUMBER}/comments`)
    && args.includes('--paginate')),
  'phase comments must use the paginated GitHub API transport');
  assert.deepEqual({
    retained: match.canonical,
    legacyAfterMatch: match.legacyJson,
    legacyAfterRemoval: JSON.stringify(removal.afterRemoval.fingerprints),
    inlinePosts: [match.inlinePosts, removal.inlinePosts],
    canonicalAfterRemoval: removal.afterRemoval.review.fingerprints,
    resolvedThreadIds: removal.resolutionCalls.map((args) => args[args.indexOf('threadId=PRRT_LEGACY')]),
    threadResolved: allThreads(fixture.remote).find((thread) => thread.id === 'PRRT_LEGACY').isResolved,
  }, {
    retained: [{ fingerprint: legacy[0].fingerprint, thread: 'PRRT_LEGACY' }],
    legacyAfterMatch: legacyJson,
    legacyAfterRemoval: legacyJson,
    inlinePosts: [0, 0],
    canonicalAfterRemoval: [],
    resolvedThreadIds: ['threadId=PRRT_LEGACY'],
    threadResolved: true,
  }, 'legacy thread proof must survive migration and resolve once after its finding disappears');
}

function inlinePostCount(remote) {
  return remote.calls.filter((args) => args[0] === 'api'
    && String(args[1]).includes('/pulls/')
    && String(args[1]).endsWith('/comments')
    && args.some((arg) => String(arg).includes('pocket-fp:'))).length;
}
