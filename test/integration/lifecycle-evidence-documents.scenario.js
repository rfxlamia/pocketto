'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('./support/fixture');
const { initializePlan } = require('./support/plan-commands');
const { installRegisteredEnterpriseReadFaultGate } = require('./support/failure-gates');
const { readRemote } = require('./support/lifecycle-state');
const { assertCliOk } = require('./support/core-cli');

const PLAN_LOG_PATH = path.join('log.json');
const REVIEW_REPORT_PATH = path.join('reviews', 'T1-review.json');

const {
  deliverApprovedSpec,
  emitPhaseComplete,
  drain,
  drainWithReadFailure,
  assertRegisteredReadWasInjected,
  assertRetryableFailure,
  assertTerminalFailure,
  assertEventAttempt,
  drainAfterRecovery,
  readMetadata,
  readPhaseProof,
  assertWatermark,
  assertPhaseProofAndRemoteEffect,
} = require('./lifecycle-evidence-classification.helpers.js');

test('phase-complete keeps missing and malformed required plan logs terminal without side effects', async (t) => {
  const cases = [
    {
      name: 'missing plan log',
      alter(planDir) { fs.rmSync(path.join(planDir, PLAN_LOG_PATH)); },
    },
    {
      name: 'malformed plan log JSON',
      alter(planDir) { fs.writeFileSync(path.join(planDir, PLAN_LOG_PATH), '{'); },
    },
    {
      name: 'non-object plan log JSON',
      alter(planDir) { fs.writeFileSync(path.join(planDir, PLAN_LOG_PATH), 'null'); },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, (t) => {
      const fixture = createFixture(t);
      initializePlan(fixture);
      deliverApprovedSpec(fixture);
      const eventId = emitPhaseComplete(fixture);
      const metadataBefore = readMetadata(fixture);
      const remoteBefore = readRemote(fixture);
      scenario.alter(fixture.planDir);

      const result = assertCliOk(drain(fixture), `phase-complete with ${scenario.name}`);
      assertTerminalFailure(result, eventId, 'PHASE_EVIDENCE_INVALID');
      assertEventAttempt(fixture, eventId, 'terminal', 1);
      assert.deepEqual(readRemote(fixture), remoteBefore,
        'invalid required plan evidence must not call or mutate the fake GitHub transport');
      assert.deepEqual(readMetadata(fixture), metadataBefore,
        'invalid required plan evidence must not write proof or advance lifecycle metadata');
      assert.equal(readPhaseProof(fixture), undefined);
      assertWatermark(fixture, 1);
    });
  }
});

test('phase-complete keeps EIO reading the required plan log retryable until proof is applied', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  deliverApprovedSpec(fixture);
  const eventId = emitPhaseComplete(fixture);
  const faultGate = installRegisteredEnterpriseReadFaultGate(fixture);
  const targetPath = path.join(fixture.planDir, PLAN_LOG_PATH);
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);

  const failed = drainWithReadFailure(fixture, faultGate, targetPath);
  const failure = assertCliOk(failed, 'phase-complete after registered Enterprise plan-log EIO');
  assertRegisteredReadWasInjected(faultGate, targetPath, failed);
  assertRetryableFailure(failure, eventId, 'PHASE_EVIDENCE_UNAVAILABLE');
  assertEventAttempt(fixture, eventId, 'retryable', 1);
  assert.deepEqual(readRemote(fixture), remoteBefore,
    'plan-log EIO must not call or mutate the fake GitHub transport');
  assert.deepEqual(readMetadata(fixture), metadataBefore,
    'plan-log EIO must not write handler proof or advance lifecycle metadata');
  assert.equal(readPhaseProof(fixture), undefined);
  assertWatermark(fixture, 1);

  const retried = assertCliOk(drainAfterRecovery(fixture), 'phase-complete retry after plan-log EIO');
  assert.deepEqual(retried.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: eventId, status: 'succeeded' },
  ]);
  assertEventAttempt(fixture, eventId, 'succeeded', 2);
  assertPhaseProofAndRemoteEffect(fixture, eventId, remoteBefore);
  assertWatermark(fixture, 2);
});

test('phase-complete retries EIO while reading an existing review report and applies proof once after recovery', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  deliverApprovedSpec(fixture);
  const eventId = emitPhaseComplete(fixture);
  const faultGate = installRegisteredEnterpriseReadFaultGate(fixture);
  const targetPath = path.join(fixture.planDir, REVIEW_REPORT_PATH);
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);

  const failed = drainWithReadFailure(fixture, faultGate, targetPath);
  const failure = assertCliOk(failed, 'phase-complete after registered Enterprise review-read EIO');
  assertRegisteredReadWasInjected(faultGate, targetPath, failed);
  assertRetryableFailure(failure, eventId, 'PHASE_REVIEW_EVIDENCE_UNAVAILABLE');
  assertEventAttempt(fixture, eventId, 'retryable', 1);
  assert.deepEqual(readRemote(fixture), remoteBefore,
    'review-report EIO must not call or mutate the fake GitHub transport');
  assert.deepEqual(readMetadata(fixture), metadataBefore,
    'review-report EIO must not write handler proof or advance lifecycle metadata');
  assert.equal(readPhaseProof(fixture), undefined);
  assertWatermark(fixture, 1);

  const retried = assertCliOk(drainAfterRecovery(fixture), 'phase-complete retry after review-read EIO');
  assert.deepEqual(retried.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: eventId, status: 'succeeded' },
  ]);
  assertEventAttempt(fixture, eventId, 'succeeded', 2);
  assertPhaseProofAndRemoteEffect(fixture, eventId, remoteBefore);
  assertWatermark(fixture, 2);
});

test('phase-complete keeps malformed review report JSON terminal before remote reconciliation', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  deliverApprovedSpec(fixture);
  const eventId = emitPhaseComplete(fixture);
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);
  fs.writeFileSync(path.join(fixture.planDir, REVIEW_REPORT_PATH), '{');

  const result = assertCliOk(drain(fixture), 'phase-complete with malformed review report JSON');

  assertTerminalFailure(result, eventId, 'PHASE_REVIEW_EVIDENCE_INVALID');
  assertEventAttempt(fixture, eventId, 'terminal', 1);
  assert.deepEqual(readRemote(fixture), remoteBefore,
    'malformed review evidence must not call or mutate the fake GitHub transport');
  assert.deepEqual(readMetadata(fixture), metadataBefore,
    'malformed review evidence must not write proof or advance lifecycle metadata');
  assert.equal(readPhaseProof(fixture), undefined);
  assertWatermark(fixture, 1);
});
