'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CORE_CLI, FIXED_NOW } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { installArtifactReadFaultGate } = require('./support/failure-gates');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');
const { sha256 } = require('./support/files');

test('temporary artifact read failures stay retryable and recover without premature remote mutation', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const eventId = transitionApprovedSpec(fixture).event_id;
  const faultGate = installArtifactReadFaultGate(fixture);
  const failedAttempt = drainWithArtifactReadFault(fixture, faultGate);
  assertRetryableArtifactFailure(fixture, faultGate, failedAttempt, eventId);
  retryAfterArtifactReadRecovers(fixture, eventId);
});

function drainWithArtifactReadFault(fixture, faultGate) {
  return runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'], {
    ...fixture.env,
    NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' '),
    LIFECYCLE_ARTIFACT_READ_FAILURE_PATH: path.join(fixture.specDir, 'approved-spec.md'),
    LIFECYCLE_ARTIFACT_READ_FAILURE_HIT_FILE: faultGate.hitPath,
  });
}

function assertRetryableArtifactFailure(fixture, faultGate, failedAttempt, eventId) {
  const data = assertCliOk(failedAttempt, 'public drain with a temporary artifact read failure');
  assert.equal(fs.existsSync(faultGate.hitPath), true,
    `the real artifact reader fault must be injected during delivery: ${failedAttempt.stdout}${failedAttempt.stderr}`);
  assert.equal(fs.readFileSync(faultGate.hitPath, 'utf8'), 'EIO');
  assert.deepEqual(data.deliveries.map(({ event_id, revision, status, error }) => ({
    event_id, revision, status, code: error && error.code,
  })), [{ event_id: eventId, revision: 1, status: 'retryable', code: 'ARTIFACT_READ_FAILED' }]);
  const event = readLifecycle(fixture).events[0];
  assert.equal(event.delivery.status, 'retryable');
  assert.equal(event.delivery.attempts, 1);
  assert.equal(event.delivery.next_attempt_at, new Date(Date.parse(FIXED_NOW) + 1000).toISOString());
  assert.deepEqual(readRemote(fixture).calls, [], 'temporary artifact I/O must not reach GitHub');
  assert.deepEqual(readRemote(fixture).effects, []);
  assert.deepEqual(readRemote(fixture).issues, []);
}

function retryAfterArtifactReadRecovers(fixture, eventId) {
  const retryNow = new Date(Date.parse(FIXED_NOW) + 1001).toISOString();
  const recovered = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], { ...fixture.env, POCKETTO_LIFECYCLE_NOW: retryNow });
  assert.deepEqual(assertCliOk(recovered, 'public retry after transient artifact I/O').deliveries.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
    { event_id: eventId, revision: 1, status: 'succeeded' },
  ]);
  const event = readLifecycle(fixture).events[0];
  assert.equal(event.delivery.status, 'succeeded');
  assert.equal(event.delivery.attempts, 2);
  assert.equal(readRemote(fixture).effects.length, 1);
  assert.equal(readRemote(fixture).issues.length, 1);
  assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false);
}
