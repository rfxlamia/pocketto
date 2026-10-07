'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { invokeAdapter, readAdapterRegistration } = require('../../cli/lib/lifecycle-adapter');
const { FIXED_NOW, PHASE_PATH, PLAN_ID } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');

const ENTERPRISE_DISPATCH = path.resolve(__dirname, '../../enterprise/dispatch.js');
const METADATA_PATH = '.pocket-meta.json';
const PHASE_PROOF_PATH = ['phases', 'phase-1', 'review', 'proof'];
const CLOSURE_PROOF_PATH = ['github_issue', 'tasklist'];

const {
  preparePendingPhaseEvent,
  preparePendingClosureEvent,
  installRegisteredPathFaultGate,
  assertRegisteredFault,
  invokeRegistered,
  withEnvironment,
  drain,
  assertEventAttempt,
  assertWatermark,
  assertPhaseProofAndSingleRemoteEffect,
  readMetadata,
  readMetadataBytes,
  nestedValue,
} = require('./lifecycle-error-taxonomy.helpers.js');

test('phase-complete retries recorded plan-path realpath EIO before mutation, then applies proof once', (t) => {
  const fixture = createFixture(t);
  const event = preparePendingPhaseEvent(fixture);
  const faultGate = installRegisteredPathFaultGate(fixture, {
    method: 'realpathSync',
    targetPath: path.resolve(fixture.planDir),
  });
  const remoteBefore = readRemote(fixture);
  const metadataBefore = readMetadataBytes(fixture);

  const failed = drain(fixture, faultGate.environment);
  const failure = assertCliOk(failed, 'registered phase delivery after recorded plan-path realpath EIO');
  assertRegisteredFault(faultGate, failed);
  assert.deepEqual(failure.deliveries.map(({ event_id, status, error }) => ({
    event_id, status, code: error && error.code, retryable: error && error.retryable,
  })), [{ event_id: event.event_id, status: 'retryable', code: 'PHASE_LIFECYCLE_UNAVAILABLE', retryable: true }]);
  assertEventAttempt(fixture, event.event_id, 'retryable', 1);
  assert.deepEqual(readRemote(fixture), remoteBefore, 'path-resolution EIO must precede every remote operation');
  assert.deepEqual(readMetadataBytes(fixture), metadataBefore, 'failed path validation must not write proof or watermark');
  assert.equal(nestedValue(readMetadata(fixture), PHASE_PROOF_PATH), undefined);
  assertWatermark(fixture, 1);

  const retryNow = new Date(Date.parse(FIXED_NOW) + 1001).toISOString();
  const retried = assertCliOk(drain(fixture, { ...fixture.env, POCKETTO_LIFECYCLE_NOW: retryNow }),
    'registered phase delivery after recorded plan-path recovery');
  assert.deepEqual(retried.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: event.event_id, status: 'succeeded' },
  ]);
  assertEventAttempt(fixture, event.event_id, 'succeeded', 2);
  assertPhaseProofAndSingleRemoteEffect(fixture, event.event_id, remoteBefore);
  assertWatermark(fixture, 2);
});

function assertRetryableLifecyclePathRealpathFailure(fixture, event, faultGate, response,
  externalPath, lifecycleBytes, remoteBefore, metadataBefore) {
  assertRegisteredFault(faultGate, response);
  assert.equal(fs.readFileSync(faultGate.readTracePath, 'utf8'), '',
    'the registered Enterprise process must not read lifecycle.json after realpath failed');
  assert.equal(response.event_id, event.event_id);
  assert.equal(response.status, 'retryable');
  assert.equal(response.error.retryable, true);
  assert.equal(response.error.code, 'PHASE_LIFECYCLE_UNAVAILABLE');
  assert.deepEqual(fs.readFileSync(externalPath), lifecycleBytes, 'the external lifecycle target must remain unchanged');
  assert.deepEqual(readRemote(fixture), remoteBefore, 'an unverified lifecycle path must not reach GitHub');
  assert.deepEqual(readMetadataBytes(fixture), metadataBefore, 'failed lifecycle validation must not write proof or watermark');
  assert.equal(nestedValue(readMetadata(fixture), PHASE_PROOF_PATH), undefined);
  assertEventAttempt(fixture, event.event_id, 'pending', 0);
  assertWatermark(fixture, 1);
}

function assertTerminalExternalLifecycleSymlink(fixture, event, terminalPathGate, unsafe,
  remoteBefore, metadataBefore) {
  assert.equal(unsafe.event_id, event.event_id);
  assert.equal(unsafe.status, 'terminal');
  assert.equal(unsafe.error.retryable, false);
  assert.equal(unsafe.error.code, 'PHASE_LIFECYCLE_PATH_INVALID');
  assert.equal(fs.existsSync(terminalPathGate.hitPath), false, 'the deterministic symlink rejection must not inject an I/O failure');
  assert.equal(fs.readFileSync(terminalPathGate.readTracePath, 'utf8'), '',
    'the registered Enterprise process must reject a resolved external lifecycle target before reading it');
  assert.deepEqual(readRemote(fixture), remoteBefore);
  assert.deepEqual(readMetadataBytes(fixture), metadataBefore);
  assertEventAttempt(fixture, event.event_id, 'pending', 0);
  assertWatermark(fixture, 1);
}

function assertLifecyclePathRecovery(fixture, event, remoteBefore, retried) {
  assert.deepEqual(retried.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: event.event_id, status: 'succeeded' },
  ]);
  assertEventAttempt(fixture, event.event_id, 'succeeded', 1);
  assertPhaseProofAndSingleRemoteEffect(fixture, event.event_id, remoteBefore);
  assertWatermark(fixture, 2);
}

test('phase-complete fails closed on lifecycle realpath EIO without reading an external symlink target', (t) => {
  const fixture = createFixture(t);
  const event = preparePendingPhaseEvent(fixture);
  const lifecyclePath = path.join(fs.realpathSync(fixture.specDir), 'lifecycle.json');
  const lifecycleBytes = fs.readFileSync(lifecyclePath);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-enterprise-context-'));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const externalPath = path.join(externalRoot, 'lifecycle.json');
  fs.writeFileSync(externalPath, lifecycleBytes);
  fs.rmSync(lifecyclePath);
  fs.symlinkSync(externalPath, lifecyclePath, 'file');

  const faultGate = installRegisteredPathFaultGate(fixture, {
    method: 'realpathSync',
    targetPath: lifecyclePath,
    readWatchPath: lifecyclePath,
  });
  const remoteBefore = readRemote(fixture);
  const metadataBefore = readMetadataBytes(fixture);
  const response = invokeRegistered(fixture, event, faultGate.environment);

  assertRetryableLifecyclePathRealpathFailure(fixture, event, faultGate, response,
    externalPath, lifecycleBytes, remoteBefore, metadataBefore);

  const terminalPathGate = installRegisteredPathFaultGate(fixture, {
    method: 'statSync',
    targetPath: path.join(externalRoot, 'fault-must-not-match'),
    readWatchPath: lifecyclePath,
  });
  const unsafe = invokeRegistered(fixture, event, terminalPathGate.environment);
  assertTerminalExternalLifecycleSymlink(fixture, event, terminalPathGate, unsafe,
    remoteBefore, metadataBefore);

  fs.rmSync(lifecyclePath);
  fs.writeFileSync(lifecyclePath, lifecycleBytes);
  const retried = assertCliOk(drain(fixture), 'registered phase delivery after lifecycle-path recovery');
  assertLifecyclePathRecovery(fixture, event, remoteBefore, retried);
});

test('registered phase-complete keeps missing and malformed lifecycle documents terminal and read-only', async (t) => {
  const cases = [
    {
      name: 'missing lifecycle document',
      code: 'PHASE_LIFECYCLE_PATH_INVALID',
      alter(lifecyclePath) { fs.rmSync(lifecyclePath); },
    },
    {
      name: 'malformed lifecycle document',
      code: 'PHASE_LIFECYCLE_INVALID',
      alter(lifecyclePath) { fs.writeFileSync(lifecyclePath, '{'); },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, (t) => {
      const fixture = createFixture(t);
      const event = preparePendingPhaseEvent(fixture);
      const remoteBefore = readRemote(fixture);
      const metadataBefore = readMetadataBytes(fixture);
      scenario.alter(path.join(fixture.specDir, 'lifecycle.json'));

      const response = invokeRegistered(fixture, event, fixture.env);

      assert.equal(response.event_id, event.event_id, 'adapter must preserve the original event ID');
      assert.equal(response.status, 'terminal');
      assert.equal(response.error.retryable, false);
      assert.equal(response.error.code, scenario.code);
      assert.deepEqual(readRemote(fixture), remoteBefore, 'invalid lifecycle evidence must not reach GitHub');
      assert.deepEqual(readMetadataBytes(fixture), metadataBefore, 'invalid lifecycle evidence must not write proof or watermark');
      assert.equal(nestedValue(readMetadata(fixture), PHASE_PROOF_PATH), undefined);
      assertWatermark(fixture, 1);
    });
  }
});
