'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLAN_ID, PR_NUMBER } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');
const {
  installLifecycleWatermarkWriteFaultGate,
  installLifecycleHandlerCallTraceGate,
} = require('./support/failure-gates');
const scenarioHelpers = require('./lifecycle-gap.helpers');
const replayHelpers = require('./lifecycle-gap-replay.helpers');

test('the registered Enterprise adapter defers an out-of-order revision until its predecessor is applied', (t) => {
  const scenario = prepareGapScenario(createFixture(t));
  assertGapHasNoMutation(scenario);
  const failedAttempt = failWatermarkWriteAfterProof(scenario);
  const recovered = replayCanonicalProofBeforeMutation(scenario, failedAttempt);
  completeNextRevision(scenario, recovered);
});

test('proof-first recovery rejects a changed second artifact before advancing the watermark', (t) => {
  const scenario = prepareGapScenario(createFixture(t));
  assertGapHasNoMutation(scenario);
  const failedAttempt = failWatermarkWriteAfterProof(scenario);
  rejectChangedSecondArtifactDuringReplay(scenario, failedAttempt);
});

function prepareGapScenario(fixture) {
  initializePlan(fixture);
  scenarioHelpers.preparePhaseFixtures(fixture);
  scenarioHelpers.seedPhasePullRequests(fixture);

  const approval = transitionApprovedSpec(fixture);
  assert.equal(approval.event_id, `${PLAN_ID}:spec-approved:r1`);
  assert.equal(scenarioHelpers.appendPhaseEvent(fixture, 1).event_id, `${PLAN_ID}:phase-complete:r2`);
  assert.equal(scenarioHelpers.appendPhaseEvent(fixture, 2).event_id, `${PLAN_ID}:phase-complete:r3`);
  const initialDrain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  assert.deepEqual(assertCliOk(initialDrain, 'registered Enterprise delivery through Core drain').deliveries.map(({ revision, status }) => ({ revision, status })), [
    { revision: 1, status: 'succeeded' },
    { revision: 2, status: 'succeeded' },
    { revision: 3, status: 'succeeded' },
  ]);
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'the real registered adapter must persist the contiguous watermark after r1-r3 proofs');

  assert.equal(scenarioHelpers.appendPhaseEvent(fixture, 3, [{ root: 'spec', path: 'approved-spec.md' }]).event_id,
    `${PLAN_ID}:phase-complete:r4`);
  assert.equal(scenarioHelpers.appendPhaseEvent(fixture, 4).event_id, `${PLAN_ID}:phase-complete:r5`);
  const lifecyclePath = path.join(fixture.specDir, 'lifecycle.json');
  const journalBeforeDelivery = fs.readFileSync(lifecyclePath);
  scenarioHelpers.assertValidOrderedJournal(fixture);
  const lifecycle = readLifecycle(fixture);
  const event4 = lifecycle.events.find((event) => event.revision === 4);
  const event5 = lifecycle.events.find((event) => event.revision === 5);
  assert.equal(event4.event_id, `${PLAN_ID}:phase-complete:r4`);
  assert.equal(event5.event_id, `${PLAN_ID}:phase-complete:r5`);
  assert.match(event4.payload_hash, /^[0-9a-f]{64}$/);
  assert.match(event5.payload_hash, /^[0-9a-f]{64}$/);
  return {
    fixture,
    event4,
    event5,
    lifecyclePath,
    journalBeforeDelivery,
    handlerTrace: installLifecycleHandlerCallTraceGate(fixture),
    metadataBeforeGap: scenarioHelpers.readMetadataBytes(fixture),
    remoteBeforeGap: readRemote(fixture),
  };
}

function assertGapHasNoMutation(scenario) {
  const { fixture, event5, handlerTrace, lifecyclePath, journalBeforeDelivery, metadataBeforeGap, remoteBeforeGap } = scenario;
  const blocked = scenarioHelpers.deliverRegisteredEvent(fixture, event5, { handlerTrace });
  assert.equal(blocked.event_id, event5.event_id);
  assert.equal(blocked.status, 'retryable');
  assert.deepEqual(blocked.error && { code: blocked.error.code, retryable: blocked.error.retryable },
    { code: 'REVISION_GAP', retryable: true });
  assert.match(blocked.error.message, new RegExp(PLAN_ID));
  assert.match(blocked.error.message, /revision\s+5/i, 'diagnostic must identify blocked revision 5');
  assert.match(blocked.error.message, /(?:predecessor|revision)\s+4/i, 'diagnostic must identify missing predecessor 4');
  assert.deepEqual(Object.keys(blocked).sort(), ['error', 'event_id', 'status'],
    'the gap response must stay within the existing adapter response contract');
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'a gap must leave the Enterprise watermark at revision 3');
  assert.deepEqual(scenarioHelpers.readMetadataBytes(fixture), metadataBeforeGap,
    'a gap must invoke no handler and must not write proof or metadata');
  assert.deepEqual(readRemote(fixture), remoteBeforeGap,
    'a gap must perform zero fake GitHub operations or mutations');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [], 'a gap must invoke no Enterprise phase handler');
  assert.deepEqual(fs.readFileSync(lifecyclePath), journalBeforeDelivery,
    'reordered adapter delivery must not mutate Core’s authoritative append-ordered journal');
}

function failWatermarkWriteAfterProof(scenario) {
  const { fixture, event4, handlerTrace, remoteBeforeGap } = scenario;
  const watermarkFault = installLifecycleWatermarkWriteFaultGate(fixture);
  const claimedEvent4 = {
    ...event4,
    delivery: { ...event4.delivery, status: 'claimed', attempts: event4.delivery.attempts + 1 },
  };
  const reconciling4 = scenarioHelpers.deliverRegisteredEvent(fixture, claimedEvent4, {
    faultGate: watermarkFault,
    failWatermarkRevision: 4,
    handlerTrace,
  });
  assert.equal(reconciling4.status, 'reconciling');
  assert.deepEqual(reconciling4.error && { code: reconciling4.error.code, retryable: reconciling4.error.retryable },
    { code: 'LIFECYCLE_WATERMARK_WRITE_FAILED', retryable: true });
  assert.equal(fs.readFileSync(watermarkFault.hitPath, 'utf8'), 'revision-4');
  let metadataAfterWatermarkFailure;
  try {
    metadataAfterWatermarkFailure = scenarioHelpers.readMetadata(fixture);
  } catch (error) {
    assert.fail(`a failed watermark write must preserve parseable metadata and the existing proof: ${error.message}`);
  }
  assert.deepEqual(metadataAfterWatermarkFailure.lifecycle_delivery,
    { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'a failed watermark write must preserve the previous contiguous revision');
  scenarioHelpers.assertCanonicalPersistedProof(fixture, event4, reconciling4);
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'the contiguous watermark must stay at 3 after proof persistence but before recovery');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id,
    revision: 4,
    status: 'claimed',
  }], 'the initial r4 attempt must invoke its handler exactly once');
  const metadataAfterProof = scenarioHelpers.readMetadata(fixture);
  const metadataAfterProofBytes = scenarioHelpers.readMetadataBytes(fixture);
  const remoteAfterProof = readRemote(fixture);
  assert.deepEqual(remoteAfterProof.effects.slice(remoteBeforeGap.effects.length), [{
    kind: 'phase-summary-create', number: PR_NUMBER + 2, marker: '<!-- pocket-phase-3-summary -->',
  }], 'the event proof and remote effect must be durable before the injected watermark write failure');
  return { claimedEvent4, reconciling4, metadataAfterProof, metadataAfterProofBytes, remoteAfterProof };
}

function rejectChangedSecondArtifactDuringReplay(scenario, failedAttempt) {
  const { fixture, event4, handlerTrace } = scenario;
  const { claimedEvent4, reconciling4, metadataAfterProof, metadataAfterProofBytes, remoteAfterProof } = failedAttempt;
  const reconcilingEvent4 = replayHelpers.buildReconcilingReplayEvent(event4, claimedEvent4, reconciling4);
  assert.equal(reconcilingEvent4.artifact_refs.length, 2,
    'the proof-first regression must exercise a second committed artifact ref');
  const secondRef = reconcilingEvent4.artifact_refs[1];
  assert.equal(secondRef.root, 'spec', 'the recovery regression must cover the selected spec-root artifact');
  const secondArtifactPath = path.join(fixture.specDir, secondRef.path);
  const secondArtifactBytes = fs.readFileSync(secondArtifactPath);
  fs.writeFileSync(secondArtifactPath, Buffer.concat([secondArtifactBytes, Buffer.from('\nchanged after proof persistence\n')]));
  assert.notDeepEqual(fs.readFileSync(secondArtifactPath), secondArtifactBytes,
    'the second committed artifact must be changed after canonical proof persistence');

  const stale = scenarioHelpers.deliverRegisteredEvent(fixture, reconcilingEvent4, { handlerTrace });
  assert.equal(stale.event_id, event4.event_id, 'recovery must preserve the original event identity');
  assert.equal(stale.status, 'terminal');
  assert.deepEqual(stale.error && { code: stale.error.code, retryable: stale.error.retryable },
    { code: 'STALE_ARTIFACT', retryable: false });
  assert.deepEqual(scenarioHelpers.readWatermark(fixture),
    { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'a stale second ref must not advance the contiguous watermark');
  assert.deepEqual(scenarioHelpers.readMetadataBytes(fixture), metadataAfterProofBytes,
    'stale replay must leave proof and watermark metadata byte-identical');
  assert.deepEqual(scenarioHelpers.readMetadata(fixture).phases['phase-3'].review.proof,
    metadataAfterProof.phases['phase-3'].review.proof,
    'stale replay must not mutate the canonical proof contents');
  assert.deepEqual(readRemote(fixture), remoteAfterProof,
    'stale proof-first recovery must perform zero additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id, revision: 4, status: 'claimed',
  }], 'stale proof-first recovery must not rerun the phase handler');
}

function replayCanonicalProofBeforeMutation(scenario, failedAttempt) {
  const replayState = replayHelpers.prepareProofFirstReplay(scenario, failedAttempt);
  replayHelpers.assertRetryableProofFirstRead(scenario, failedAttempt, replayState);
  return replayHelpers.applyProofFirstReplay(scenario, failedAttempt, replayState);
}

function completeNextRevision(scenario, recovered) {
  const { applied4, event4, event5, fixture, handlerTrace, lifecyclePath, journalBeforeDelivery, remoteAfterReplay } = recovered;
  const applied5 = scenarioHelpers.deliverRegisteredEvent(fixture, event5, { handlerTrace });
  scenarioHelpers.assertSuccessfulProof(applied5, event5);
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace).map(({ event_id, revision }) => ({ event_id, revision })), [
    { event_id: applied4.event_id, revision: 4 },
    { event_id: event5.event_id, revision: 5 },
  ], 'r5 must invoke its handler once after proof-first recovery applies r4');
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 5 },
    'retrying revision 5 after revision 4 must advance the contiguous watermark');
  const remoteAfterRevision5 = readRemote(fixture);
  assert.ok(remoteAfterRevision5.calls.length > remoteAfterReplay.calls.length,
    'applying r5 must invoke its remote reconciliation path after the no-call proof-first replay');
  scenarioHelpers.assertCanonicalPhaseProof(fixture, 3, event4, applied4);
  scenarioHelpers.assertCanonicalPhaseProof(fixture, 4, event5, applied5);
  scenarioHelpers.assertOrderedRemoteEffects(fixture, scenario.remoteBeforeGap, [3, 4]);
  assert.deepEqual(fs.readFileSync(lifecyclePath), journalBeforeDelivery,
    'direct adapter delivery must leave Core’s authoritative journal byte-identical');
}
