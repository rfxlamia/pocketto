'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIXED_NOW, PHASE_PATH, PLAN_ID } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { installRegisteredEnterpriseReadFaultGate } = require('./support/failure-gates');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');

const ENTERPRISE_DISPATCH = path.resolve(__dirname, '../../enterprise/dispatch.js');

test('phase-complete retries an EIO from registered Enterprise phase-evidence validation', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  deliverApprovedSpec(fixture);
  const eventId = emitPhaseComplete(fixture);
  const faultGate = installRegisteredEnterpriseReadFaultGate(fixture);
  const remoteBeforeFailure = readRemote(fixture);
  const metadataBeforeFailure = readMetadata(fixture);

  const failedAttempt = drainWithRegisteredReadFault(fixture, faultGate, path.join(fixture.planDir, PHASE_PATH));
  const failure = assertCliOk(failedAttempt, 'Core drain after registered Enterprise phase-evidence EIO');
  assertRegisteredReadWasInjected(faultGate, path.join(fixture.planDir, PHASE_PATH), failedAttempt);
  assertRetryableFailure(failure, eventId, 'PHASE_EVIDENCE_UNAVAILABLE');
  assertEventAttempt(fixture, eventId, 'retryable', 1);
  assert.deepEqual(readRemote(fixture), remoteBeforeFailure,
    'the failed Enterprise validation attempt must not call or mutate the fake GitHub transport');
  assert.deepEqual(readMetadata(fixture), metadataBeforeFailure,
    'the failed phase validation must not write handler proof or lifecycle metadata');
  assertWatermark(fixture, 1);
  assert.equal(readPhaseProof(fixture), undefined,
    'phase proof must not be written before phase evidence can be read');

  const retry = drainAfterRecovery(fixture);
  assert.deepEqual(retry.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: eventId, status: 'succeeded' },
  ], 'Core must replay the original event ID after the transient Enterprise read failure');
  assertEventAttempt(fixture, eventId, 'succeeded', 2);
  assertPhaseProofAndRemoteEffect(fixture, eventId, remoteBeforeFailure);
  assertWatermark(fixture, 2);
});

test('plan-closed retries an EIO from registered Enterprise closure plan-state validation', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  emitAndDeliverPhaseComplete(fixture);
  const eventId = emitPlanClosed(fixture);
  const faultGate = installRegisteredEnterpriseReadFaultGate(fixture);
  const remoteBeforeFailure = readRemote(fixture);
  const metadataBeforeFailure = readMetadata(fixture);

  const failedAttempt = drainWithRegisteredReadFault(fixture, faultGate, path.join(fixture.planDir, 'log.json'));
  const failure = assertCliOk(failedAttempt, 'Core drain after registered Enterprise closure plan-state EIO');
  assertRegisteredReadWasInjected(faultGate, path.join(fixture.planDir, 'log.json'), failedAttempt);
  assertRetryableFailure(failure, eventId, 'PLAN_STATE_UNAVAILABLE');
  assertEventAttempt(fixture, eventId, 'retryable', 1);
  assert.deepEqual(readRemote(fixture), remoteBeforeFailure,
    'the failed closure validation attempt must not call or mutate the fake GitHub transport');
  assert.deepEqual(readMetadata(fixture), metadataBeforeFailure,
    'the failed closure validation must not write handler proof or lifecycle metadata');
  assertWatermark(fixture, 2);
  assert.equal(readClosureProof(fixture), undefined,
    'closure proof must not be written before final plan state can be read');

  const retry = drainAfterRecovery(fixture);
  assert.deepEqual(retry.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: eventId, status: 'succeeded' },
  ], 'Core must replay the original closure event ID after the transient Enterprise read failure');
  assertEventAttempt(fixture, eventId, 'succeeded', 2);
  assertClosureProofAndRemoteEffect(fixture, eventId, remoteBeforeFailure);
  assertWatermark(fixture, 3);
});

function deliverApprovedSpec(fixture) {
  const eventId = transitionApprovedSpec(fixture).event_id;
  const drained = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  const result = assertCliOk(drained, 'registered Enterprise delivery for approved spec');
  assert.deepEqual(result.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: eventId, status: 'succeeded' },
  ]);
  assertWatermark(fixture, 1);
}

function emitPhaseComplete(fixture) {
  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'REVIEW', '--json', '--contract', '3',
  ]);
  const event = assertCliOk(review, 'public log update REVIEW').event;
  assert.equal(event.event_id, `${PLAN_ID}:phase-complete:r2`);
  return event.event_id;
}

function emitAndDeliverPhaseComplete(fixture) {
  deliverApprovedSpec(fixture);
  const eventId = emitPhaseComplete(fixture);
  const drained = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  const result = assertCliOk(drained, 'registered Enterprise phase-complete delivery');
  assert.deepEqual(result.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: eventId, status: 'succeeded' },
  ]);
  assertWatermark(fixture, 2);
}

function emitPlanClosed(fixture) {
  const phaseDone = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'DONE', '--json', '--contract', '3',
  ]);
  assertCliOk(phaseDone, 'public log update DONE');
  const closed = runCore(fixture, ['log', 'close', fixture.planDir, '--json', '--contract', '3']);
  const event = assertCliOk(closed, 'public log close').event;
  assert.equal(event.event_id, `${PLAN_ID}:plan-closed:r3`);
  assert.equal(event.status, 'pending');
  return event.event_id;
}

function drainWithRegisteredReadFault(fixture, faultGate, targetPath) {
  const nodeOptions = [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' ');
  return runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'], {
    ...fixture.env,
    NODE_OPTIONS: nodeOptions,
    LIFECYCLE_ENTERPRISE_READ_FAILURE_PATH: targetPath,
    LIFECYCLE_ENTERPRISE_DISPATCH_PATH: faultGate.dispatchPath,
    LIFECYCLE_ENTERPRISE_READ_FAILURE_HIT_FILE: faultGate.hitPath,
  });
}

function assertRegisteredReadWasInjected(faultGate, targetPath, failedAttempt) {
  assert.equal(fs.existsSync(faultGate.hitPath), true,
    `EIO must be injected by the real registered Enterprise executable, after Core dispatch: ${failedAttempt.stdout}${failedAttempt.stderr}`);
  const injection = JSON.parse(fs.readFileSync(faultGate.hitPath, 'utf8'));
  assert.deepEqual(injection, {
    code: 'EIO', executable: ENTERPRISE_DISPATCH, target: fs.realpathSync(targetPath),
  });
}

function assertRetryableFailure(result, eventId, code) {
  assert.deepEqual(result.deliveries.map(({ event_id, status, error }) => ({
    event_id, status, code: error && error.code, retryable: error && error.retryable,
  })), [{ event_id: eventId, status: 'retryable', code, retryable: true }]);
}

function assertEventAttempt(fixture, eventId, status, attempts) {
  const event = readLifecycle(fixture).events.find((entry) => entry.event_id === eventId);
  assert.ok(event, `Core journal must retain original event ${eventId}`);
  assert.equal(event.delivery.status, status);
  assert.equal(event.delivery.attempts, attempts);
  assert.equal(event.event_id, eventId);
}

function drainAfterRecovery(fixture) {
  const retryNow = new Date(Date.parse(FIXED_NOW) + 1001).toISOString();
  const result = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'], {
    ...fixture.env,
    POCKETTO_LIFECYCLE_NOW: retryNow,
  });
  return assertCliOk(result, 'public lifecycle retry after registered Enterprise EIO');
}

function readMetadata(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
}

function assertWatermark(fixture, revision) {
  assert.deepEqual(readMetadata(fixture).lifecycle_delivery, {
    schema: 1, plan_id: PLAN_ID, last_applied_revision: revision,
  });
}

function readPhaseProof(fixture) {
  const metadata = readMetadata(fixture);
  return metadata.phases && metadata.phases['phase-1']
    && metadata.phases['phase-1'].review && metadata.phases['phase-1'].review.proof;
}

function assertPhaseProofAndRemoteEffect(fixture, eventId, remoteBeforeFailure) {
  const proof = readPhaseProof(fixture);
  assert.equal(proof.event_id, eventId);
  assert.equal(proof.plan_id, PLAN_ID);
  assert.equal(proof.phase_key, 'phase-1');
  assert.equal(proof.proof_ref, 'meta:phases.phase-1.github_pr+meta:phases.phase-1.review.fingerprints');
  assert.match(proof.proof_hash, /^[0-9a-f]{64}$/);
  const event = readLifecycle(fixture).events.find((entry) => entry.event_id === eventId);
  assert.equal(event.delivery.proof_ref, proof.proof_ref);
  assert.equal(event.delivery.proof_hash, proof.proof_hash);
  const remote = readRemote(fixture);
  assert.deepEqual(remote.effects.slice(remoteBeforeFailure.effects.length).map(({ kind }) => kind), ['phase-summary-create']);
  assert.equal(remote.comments['84'].filter(({ body }) => body.startsWith('<!-- pocket-phase-1-summary -->')).length, 1);
}

function readClosureProof(fixture) {
  const metadata = readMetadata(fixture);
  return metadata.github_issue && metadata.github_issue.tasklist;
}

function assertClosureProofAndRemoteEffect(fixture, eventId, remoteBeforeFailure) {
  const proof = readClosureProof(fixture);
  assert.equal(proof.event_id, eventId);
  assert.equal(proof.plan_id, PLAN_ID);
  assert.equal(proof.revision, 3);
  assert.equal(proof.marker, '<!-- pocket-tasklist -->');
  assert.equal(proof.proof_ref, 'meta:github_issue|marker:issue-tasklist');
  assert.match(proof.proof_hash, /^[0-9a-f]{64}$/);
  const event = readLifecycle(fixture).events.find((entry) => entry.event_id === eventId);
  assert.equal(event.delivery.proof_ref, proof.proof_ref);
  assert.equal(event.delivery.proof_hash, proof.proof_hash);
  const remote = readRemote(fixture);
  assert.deepEqual(remote.effects.slice(remoteBeforeFailure.effects.length).map(({ kind }) => kind), ['tasklist-create']);
  assert.equal(remote.comments['73'].filter(({ body }) => body.startsWith('<!-- pocket-tasklist -->')).length, 1);
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true);
}
