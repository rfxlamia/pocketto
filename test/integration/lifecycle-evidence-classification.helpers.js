'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FIXED_NOW,
  PHASE_MARKER,
  PHASE_PATH,
  PLAN_ID,
  PR_NUMBER,
} = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const {
  installRegisteredEnterprisePathFaultGate,
  installRegisteredEnterpriseReadFaultGate,
} = require('./support/failure-gates');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');

const ENTERPRISE_DISPATCH = path.resolve(__dirname, '../../enterprise/dispatch.js');
const PHASE_EVIDENCE_PATH = path.join('execution-plan', 'phase-1.md');
const PLAN_LOG_PATH = path.join('log.json');
const REVIEW_REPORT_PATH = path.join('reviews', 'T1-review.json');

function deliverApprovedSpec(fixture) {
  const emitted = transitionApprovedSpec(fixture);
  const delivered = assertCliOk(drain(fixture), 'registered Enterprise spec-approved delivery');
  assert.deepEqual(delivered.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: emitted.event_id, status: 'succeeded' },
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

function drain(fixture, env = fixture.env) {
  return runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'], env);
}

function drainWithReadFailure(fixture, faultGate, targetPath) {
  return drain(fixture, {
    ...fixture.env,
    NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' '),
    LIFECYCLE_ENTERPRISE_READ_FAILURE_PATH: targetPath,
    LIFECYCLE_ENTERPRISE_DISPATCH_PATH: faultGate.dispatchPath,
    LIFECYCLE_ENTERPRISE_READ_FAILURE_HIT_FILE: faultGate.hitPath,
  });
}

function drainWithPathFailure(fixture, faultGate, method) {
  return drain(fixture, {
    ...fixture.env,
    NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' '),
    LIFECYCLE_ENTERPRISE_PATH_FAILURE_METHOD: method,
    LIFECYCLE_ENTERPRISE_PATH_FAILURE_ROOT: fixture.planDir,
    LIFECYCLE_ENTERPRISE_PATH_FAILURE_HIT_FILE: faultGate.hitPath,
    LIFECYCLE_ENTERPRISE_DISPATCH_PATH: faultGate.dispatchPath,
  });
}

function assertRegisteredReadWasInjected(faultGate, targetPath, failedAttempt) {
  assert.equal(fs.existsSync(faultGate.hitPath), true,
    `review EIO must be injected by the registered Enterprise executable: ${failedAttempt.stdout}${failedAttempt.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(faultGate.hitPath, 'utf8')), {
    code: 'EIO', executable: ENTERPRISE_DISPATCH, target: fs.realpathSync(targetPath),
  });
}

function assertRegisteredPathFailureWasInjected(faultGate, targetPath, method, failedAttempt) {
  assert.equal(fs.existsSync(faultGate.hitPath), true,
    `${method} EIO must be injected by the registered Enterprise executable: ${failedAttempt.stdout}${failedAttempt.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(faultGate.hitPath, 'utf8')), {
    code: 'EIO', executable: ENTERPRISE_DISPATCH, method,
    target: fs.realpathSync(targetPath),
  });
}

function assertRetryableFailure(result, eventId, code) {
  assert.deepEqual(result.deliveries.map(({ event_id, status, error }) => ({
    event_id, status, code: error && error.code, retryable: error && error.retryable,
  })), [{ event_id: eventId, status: 'retryable', code, retryable: true }]);
}

function assertTerminalFailure(result, eventId, code) {
  const delivery = result.deliveries.find(({ event_id }) => event_id === eventId);
  assert.ok(delivery, `Core must preserve the original event ID ${eventId}`);
  assert.equal(delivery.status, 'terminal');
  assert.equal(delivery.error.retryable, false);
  if (code) assert.equal(delivery.error.code, code);
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
  return drain(fixture, { ...fixture.env, POCKETTO_LIFECYCLE_NOW: retryNow });
}

function readMetadata(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
}

function readPhaseProof(fixture) {
  const metadata = readMetadata(fixture);
  return metadata.phases && metadata.phases['phase-1']
    && metadata.phases['phase-1'].review && metadata.phases['phase-1'].review.proof;
}

function assertWatermark(fixture, revision) {
  assert.deepEqual(readMetadata(fixture).lifecycle_delivery, {
    schema: 1, plan_id: PLAN_ID, last_applied_revision: revision,
  });
}

function assertPhaseProofAndRemoteEffect(fixture, eventId, remoteBefore) {
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
  assert.deepEqual(remote.effects.slice(remoteBefore.effects.length).map(({ kind }) => kind), ['phase-summary-create']);
  assert.equal(remote.comments[String(PR_NUMBER)].filter(({ body }) => body.startsWith(PHASE_MARKER)).length, 1);
}

module.exports = {
  deliverApprovedSpec,
  emitPhaseComplete,
  drain,
  drainWithReadFailure,
  drainWithPathFailure,
  assertRegisteredReadWasInjected,
  assertRegisteredPathFailureWasInjected,
  assertRetryableFailure,
  assertTerminalFailure,
  assertEventAttempt,
  drainAfterRecovery,
  readMetadata,
  readPhaseProof,
  assertWatermark,
  assertPhaseProofAndRemoteEffect,
};
