'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID, PR_NUMBER } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');
const {
  installLifecycleWatermarkWriteFaultGate,
  installLifecycleHandlerCallTraceGate,
} = require('./support/failure-gates');
const { validateEvent } = require('../../cli/lib/lifecycle-contract');
const { responseDeliveryPatch } = require('../../cli/lib/lifecycle-retry');
const scenarioHelpers = require('./lifecycle-gap.helpers');

test('the registered Enterprise adapter defers an out-of-order revision until its predecessor is applied', (t) => {
  const scenario = prepareGapScenario(createFixture(t));
  assertGapHasNoMutation(scenario);
  const failedAttempt = failWatermarkWriteAfterProof(scenario);
  const recovered = replayCanonicalProofBeforeMutation(scenario, failedAttempt);
  completeNextRevision(scenario, recovered);
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

  assert.equal(scenarioHelpers.appendPhaseEvent(fixture, 3).event_id, `${PLAN_ID}:phase-complete:r4`);
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
  const remoteAfterProof = readRemote(fixture);
  assert.deepEqual(remoteAfterProof.effects.slice(remoteBeforeGap.effects.length), [{
    kind: 'phase-summary-create', number: PR_NUMBER + 2, marker: '<!-- pocket-phase-3-summary -->',
  }], 'the event proof and remote effect must be durable before the injected watermark write failure');
  return { claimedEvent4, reconciling4, metadataAfterProof, remoteAfterProof };
}

function buildReconcilingReplayEvent(event4, claimedEvent4, reconciling4) {
  const reconcilingEvent4 = {
    ...claimedEvent4,
    delivery: {
      ...claimedEvent4.delivery,
      ...responseDeliveryPatch(reconciling4, claimedEvent4.delivery.attempts, Date.parse(FIXED_NOW)),
    },
  };
  assert.equal(reconcilingEvent4.delivery.status, 'reconciling',
    'replay must use the actual reconciling delivery state returned after the failed watermark write');
  assert.equal(reconcilingEvent4.event_id, event4.event_id);
  assert.equal(reconcilingEvent4.revision, event4.revision);
  assert.equal(reconcilingEvent4.payload_hash, event4.payload_hash,
    'reconciling delivery must retain the exact canonical payload hash');
  assert.equal(reconcilingEvent4.delivery.proof_ref, reconciling4.proof_ref,
    'the replay event must retain the proof reference returned by the failed attempt');
  assert.equal(reconcilingEvent4.delivery.proof_hash, reconciling4.proof_hash,
    'the replay event must retain the proof hash returned by the failed attempt');
  assert.deepEqual(reconcilingEvent4.artifact_refs, event4.artifact_refs);
  assert.deepEqual(validateEvent(reconcilingEvent4), { ok: true, code: null, message: null });
  return reconcilingEvent4;
}

function replayCanonicalProofBeforeMutation(scenario, failedAttempt) {
  const { fixture, event4, event5, handlerTrace, lifecyclePath, journalBeforeDelivery } = scenario;
  const { claimedEvent4, reconciling4, metadataAfterProof, remoteAfterProof } = failedAttempt;
  const reconcilingEvent4 = buildReconcilingReplayEvent(event4, claimedEvent4, reconciling4);
  const applied4 = scenarioHelpers.deliverRegisteredEvent(fixture, reconcilingEvent4, { handlerTrace });
  scenarioHelpers.assertSuccessfulProof(applied4, event4);
  assert.equal(applied4.event_id, reconciling4.event_id);
  assert.equal(applied4.proof_ref, reconciling4.proof_ref,
    'proof-first replay must return the exact persisted proof reference');
  assert.equal(applied4.proof_hash, reconciling4.proof_hash,
    'proof-first replay must return the exact persisted proof hash');
  const remoteAfterReplay = readRemote(fixture);
  assert.deepEqual(remoteAfterReplay.calls, remoteAfterProof.calls,
    'proof-first replay must not make another fake GitHub transport call');
  assert.deepEqual(remoteAfterReplay.effects, remoteAfterProof.effects,
    'proof-first replay must not repeat any remote effect');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id, revision: 4, status: 'claimed',
  }], 'proof-first replay must not invoke the phase handler a second time');
  assert.deepEqual(scenarioHelpers.withoutLifecycleWatermark(scenarioHelpers.readMetadata(fixture)),
    scenarioHelpers.withoutLifecycleWatermark(metadataAfterProof),
    'proof-first recovery may only mutate the watermark, not handler-owned proof metadata');
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 4 },
    'replaying the missing predecessor must repair and advance the watermark exactly once');
  return {
    applied4,
    event4,
    event5,
    fixture,
    handlerTrace,
    lifecyclePath,
    journalBeforeDelivery,
    remoteAfterReplay,
  };
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
