'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLAN_ID } = require('./support/constants');
const { readRemote } = require('./support/lifecycle-state');
const { installRegisteredEnterpriseReadFaultGate } = require('./support/failure-gates');
const scenarioHelpers = require('./lifecycle-gap.helpers');
const { preparePrePlanningSpecApprovedProofFirstScenario } = require('./lifecycle-gap-spec-approved.helpers');

test('spec-approved proof-first recovery works before planning with two intact spec refs', (t) => {
  const scenario = preparePrePlanningSpecApprovedProofFirstScenario(t);
  const replay = scenarioHelpers.deliverRegisteredEvent(scenario.fixture, scenario.reconcilingEvent, {
    handlerTrace: scenario.handlerTrace,
  });

  scenarioHelpers.assertSuccessfulProof(replay, scenario.event);
  assert.equal(replay.event_id, scenario.event.event_id);
  assert.equal(replay.proof_ref, scenario.reconcilingEvent.delivery.proof_ref);
  assert.equal(replay.proof_hash, scenario.reconcilingEvent.delivery.proof_hash);
  const persisted = scenarioHelpers.persistRegisteredAdapterResponse(
    scenario.fixture, scenario.reconcilingEvent, replay,
  );
  assert.equal(persisted.ok, true, 'Core must persist the registered adapter replay result');
  assert.equal(persisted.event.delivery.status, 'succeeded');
  assert.deepEqual(scenarioHelpers.readWatermark(scenario.fixture), {
    schema: 1, plan_id: PLAN_ID, last_applied_revision: 1,
  }, 'intact pre-planning spec refs must allow proof-first watermark recovery');
  assert.deepEqual(scenarioHelpers.readMetadata(scenario.fixture).github_issue.ownership,
    scenario.proof, 'proof-first replay must leave the canonical issue proof unchanged');
  assert.deepEqual(readRemote(scenario.fixture), scenario.remoteAfterProof,
    'proof-first replay must make no additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(scenario.handlerTrace), [{
    event_id: scenario.event.event_id, revision: 1, status: 'claimed',
  }], 'proof-first replay must not rerun the real spec-approved handler');
});

test('spec-approved proof-first recovery retries ref EIO, then rejects stale ref 2', (t) => {
  const scenario = preparePrePlanningSpecApprovedProofFirstScenario(t);
  const secondRef = scenario.event.artifact_refs[1];
  const secondArtifactPath = path.join(scenario.fixture.specDir, secondRef.path);
  const committedBytes = fs.readFileSync(secondArtifactPath);
  fs.writeFileSync(secondArtifactPath, Buffer.concat([committedBytes, Buffer.from('changed after proof persistence\n')]));
  assert.notDeepEqual(fs.readFileSync(secondArtifactPath), committedBytes,
    'only the second committed spec ref must be stale before replay');

  const readFaultGate = installRegisteredEnterpriseReadFaultGate(scenario.fixture);
  const transient = scenarioHelpers.deliverRegisteredEvent(scenario.fixture, scenario.reconcilingEvent, {
    handlerTrace: scenario.handlerTrace,
    readFaultGate,
    readArtifactPath: secondArtifactPath,
  });
  assert.equal(transient.event_id, scenario.event.event_id);
  assert.equal(transient.status, 'retryable');
  assert.deepEqual(transient.error && { code: transient.error.code, retryable: transient.error.retryable }, {
    code: 'ARTIFACT_READ_FAILED', retryable: true,
  }, 'an injected EIO while reading ref 2 must remain retryable before its stale digest is known');
  assert.equal(fs.existsSync(readFaultGate.hitPath), true,
    'proof-first recovery must attempt to read ref 2 through the registered adapter');
  const injected = JSON.parse(fs.readFileSync(readFaultGate.hitPath, 'utf8'));
  assert.equal(injected.code, 'EIO');
  assert.equal(injected.target, fs.realpathSync(secondArtifactPath));
  assert.deepEqual(scenarioHelpers.readMetadataBytes(scenario.fixture), scenario.metadataAfterProofBytes,
    'a transient ref-read failure must not mutate the proof or watermark');
  assert.deepEqual(readRemote(scenario.fixture), scenario.remoteAfterProof,
    'a transient ref-read failure must make no additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(scenario.handlerTrace), [{
    event_id: scenario.event.event_id, revision: 1, status: 'claimed',
  }], 'a transient proof-first retry must not rerun the real spec-approved handler');

  const stale = scenarioHelpers.deliverRegisteredEvent(scenario.fixture, scenario.reconcilingEvent, {
    handlerTrace: scenario.handlerTrace,
  });
  assert.equal(stale.event_id, scenario.event.event_id);
  assert.equal(stale.status, 'terminal');
  assert.deepEqual(stale.error && { code: stale.error.code, retryable: stale.error.retryable }, {
    code: 'STALE_ARTIFACT', retryable: false,
  });
  const persisted = scenarioHelpers.persistRegisteredAdapterResponse(
    scenario.fixture, scenario.reconcilingEvent, stale,
  );
  assert.equal(persisted.ok, true, 'Core must persist the terminal stale replay result');
  assert.equal(persisted.event.event_id, scenario.event.event_id);
  assert.equal(persisted.event.delivery.status, 'terminal');
  assert.equal(persisted.event.delivery.error.code, 'STALE_ARTIFACT');
  assert.deepEqual(scenarioHelpers.readMetadataBytes(scenario.fixture), scenario.metadataAfterProofBytes,
    'stale ref 2 must leave the proof and watermark byte-identical');
  assert.equal(scenarioHelpers.readMetadata(scenario.fixture).lifecycle_delivery, undefined,
    'stale proof-first replay must not create or advance a lifecycle watermark');
  assert.deepEqual(scenarioHelpers.readMetadata(scenario.fixture).github_issue.ownership,
    scenario.proof, 'stale proof-first replay must not mutate canonical proof');
  assert.deepEqual(readRemote(scenario.fixture), scenario.remoteAfterProof,
    'stale proof-first replay must make no additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(scenario.handlerTrace), [{
    event_id: scenario.event.event_id, revision: 1, status: 'claimed',
  }], 'stale proof-first replay must not rerun the real spec-approved handler');
});
