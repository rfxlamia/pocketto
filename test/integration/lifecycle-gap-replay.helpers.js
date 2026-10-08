'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID } = require('./support/constants');
const { readRemote } = require('./support/lifecycle-state');
const { installRegisteredEnterpriseReadFaultGate } = require('./support/failure-gates');
const { validateEvent } = require('../../cli/lib/lifecycle-contract');
const { responseDeliveryPatch } = require('../../cli/lib/lifecycle-retry');
const scenarioHelpers = require('./lifecycle-gap.helpers');

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

function prepareProofFirstReplay(scenario, failedAttempt) {
  const { fixture, event4 } = scenario;
  const { claimedEvent4, reconciling4 } = failedAttempt;
  const reconcilingEvent4 = buildReconcilingReplayEvent(event4, claimedEvent4, reconciling4);
  const secondRef = event4.artifact_refs[1];
  const secondRoot = secondRef.root === 'spec' ? fixture.specDir : fixture.planDir;
  const secondArtifactPath = path.join(secondRoot, secondRef.path);
  const secondArtifactBytes = fs.readFileSync(secondArtifactPath);
  const safeTargetPath = `${secondArtifactPath}.matching-content`;
  fs.writeFileSync(safeTargetPath, secondArtifactBytes);
  fs.unlinkSync(secondArtifactPath);
  fs.symlinkSync(path.basename(safeTargetPath), secondArtifactPath);
  assert.equal(fs.lstatSync(secondArtifactPath).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(secondArtifactPath), secondArtifactBytes,
    'a safe in-root symlink must still resolve to the exact committed bytes');
  return { reconcilingEvent4, secondArtifactPath };
}

function assertRetryableProofFirstRead(scenario, failedAttempt, replayState) {
  const { fixture, event4, handlerTrace } = scenario;
  const { metadataAfterProofBytes, remoteAfterProof } = failedAttempt;
  const { reconcilingEvent4, secondArtifactPath } = replayState;
  const readFaultGate = installRegisteredEnterpriseReadFaultGate(fixture);
  const transient = scenarioHelpers.deliverRegisteredEvent(fixture, reconcilingEvent4, {
    handlerTrace,
    readFaultGate,
    readArtifactPath: secondArtifactPath,
  });
  assert.equal(transient.event_id, event4.event_id);
  assert.equal(transient.status, 'retryable');
  assert.deepEqual(transient.error && { code: transient.error.code, retryable: transient.error.retryable },
    { code: 'ARTIFACT_READ_FAILED', retryable: true });
  assert.equal(fs.existsSync(readFaultGate.hitPath), true,
    'proof-first recovery must read the committed artifact through the registered Enterprise process');
  const injected = JSON.parse(fs.readFileSync(readFaultGate.hitPath, 'utf8'));
  assert.equal(injected.code, 'EIO');
  assert.equal(injected.target, fs.realpathSync(secondArtifactPath));
  assert.deepEqual(scenarioHelpers.readWatermark(fixture),
    { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'transient artifact I/O must not advance the watermark');
  assert.deepEqual(scenarioHelpers.readMetadataBytes(fixture), metadataAfterProofBytes,
    'transient artifact I/O must not mutate proof or metadata');
  assert.deepEqual(readRemote(fixture), remoteAfterProof,
    'transient artifact I/O must perform zero additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id, revision: 4, status: 'claimed',
  }], 'transient proof-first recovery must not rerun the phase handler');
}

function applyProofFirstReplay(scenario, failedAttempt, replayState) {
  const { fixture, event4, event5, handlerTrace, lifecyclePath, journalBeforeDelivery } = scenario;
  const { reconciling4, metadataAfterProof, remoteAfterProof } = failedAttempt;
  const { reconcilingEvent4 } = replayState;
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

module.exports = {
  buildReconcilingReplayEvent,
  prepareProofFirstReplay,
  assertRetryableProofFirstRead,
  applyProofFirstReplay,
};
