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

const {
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
} = require('./lifecycle-evidence-classification.helpers.js');

test('phase-complete retries EIO from plan artifact realpath/stat and recovers after one failed delivery', async (t) => {
  for (const method of ['realpathSync', 'statSync']) {
    await t.test(method, (t) => {
      const fixture = createFixture(t);
      initializePlan(fixture);
      deliverApprovedSpec(fixture);
      const eventId = emitPhaseComplete(fixture);
      const faultGate = installRegisteredEnterprisePathFaultGate(fixture);
      const metadataBefore = readMetadata(fixture);
      const remoteBefore = readRemote(fixture);

      const failed = drainWithPathFailure(fixture, faultGate, method);
      const failure = assertCliOk(failed, `phase-complete after registered Enterprise ${method} EIO`);
      assertRegisteredPathFailureWasInjected(faultGate, fixture.planDir, method, failed);
      assertRetryableFailure(failure, eventId, 'PHASE_EVIDENCE_UNAVAILABLE');
      assertEventAttempt(fixture, eventId, 'retryable', 1);
      assert.deepEqual(readRemote(fixture), remoteBefore,
        `${method} EIO must not call or mutate the fake GitHub transport`);
      assert.deepEqual(readMetadata(fixture), metadataBefore,
        `${method} EIO must not write handler proof or advance lifecycle metadata`);
      assert.equal(readPhaseProof(fixture), undefined);
      assertWatermark(fixture, 1);

      const retried = assertCliOk(drainAfterRecovery(fixture), `phase-complete retry after ${method} EIO`);
      assert.deepEqual(retried.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
        { event_id: eventId, status: 'succeeded' },
      ]);
      assertEventAttempt(fixture, eventId, 'succeeded', 2);
      assertPhaseProofAndRemoteEffect(fixture, eventId, remoteBefore);
      assertWatermark(fixture, 2);
    });
  }
});

test('phase-complete keeps missing roots and sibling/outside artifact symlinks terminal', async (t) => {
  await t.test('missing plan root', (t) => {
    const fixture = createFixture(t);
    initializePlan(fixture);
    deliverApprovedSpec(fixture);
    const eventId = emitPhaseComplete(fixture);
    const metadataBefore = readMetadata(fixture);
    const remoteBefore = readRemote(fixture);
    fs.rmSync(fixture.planDir, { recursive: true, force: true });

    const result = assertCliOk(drain(fixture), 'phase-complete with a missing selected plan root');
    assertTerminalFailure(result, eventId);
    assertEventAttempt(fixture, eventId, 'terminal', 1);
    assert.deepEqual(readRemote(fixture), remoteBefore);
    assert.deepEqual(readMetadata(fixture), metadataBefore);
    assertWatermark(fixture, 1);
  });

  for (const targetKind of ['sibling', 'outside']) {
    await t.test(`${targetKind} phase-evidence symlink`, (t) => {
      const fixture = createFixture(t);
      initializePlan(fixture);
      deliverApprovedSpec(fixture);
      const eventId = emitPhaseComplete(fixture);
      const metadataBefore = readMetadata(fixture);
      const remoteBefore = readRemote(fixture);
      const evidencePath = path.join(fixture.planDir, PHASE_EVIDENCE_PATH);
      const targetRoot = targetKind === 'sibling'
        ? path.join(path.dirname(fixture.planDir), `${path.basename(fixture.planDir)}-sibling`)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-enterprise-outside-'));
      if (targetKind === 'outside') t.after(() => fs.rmSync(targetRoot, { recursive: true, force: true }));
      fs.mkdirSync(targetRoot, { recursive: true });
      const targetPath = path.join(targetRoot, 'phase-1.md');
      fs.writeFileSync(targetPath, fixture.phaseEvidence);
      fs.rmSync(evidencePath);
      fs.symlinkSync(targetPath, evidencePath, 'file');

      const result = assertCliOk(drain(fixture), `phase-complete with ${targetKind} phase evidence symlink`);
      assertTerminalFailure(result, eventId, 'STALE_ARTIFACT');
      assertEventAttempt(fixture, eventId, 'terminal', 1);
      assert.deepEqual(readRemote(fixture), remoteBefore,
        'an escaping phase-evidence symlink must not call or mutate the fake GitHub transport');
      assert.deepEqual(readMetadata(fixture), metadataBefore,
        'an escaping phase-evidence symlink must not write proof or advance lifecycle metadata');
      assertWatermark(fixture, 1);
    });
  }
});
