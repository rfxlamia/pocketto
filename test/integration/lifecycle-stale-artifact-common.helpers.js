'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID, PHASE_PATH } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { runCore, assertCliOk } = require('./support/core-cli');
const { readRemote, readLifecycle } = require('./support/lifecycle-state');
const { installRegisteredEnterpriseReadFaultGate } = require('./support/failure-gates');
const { sha256, writeFile } = require('./support/files');
const { commitTransition } = require('../../cli/lib/lifecycle-store');
const { isDeepStrictEqual } = require('node:util');

function commitPhaseComplete(fixture, refs) {
  const result = commitTransition({
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: PLAN_ID,
    type: 'phase-complete',
    artifacts: refs,
    branch: `feature/${PLAN_ID}`,
    deps: { now: () => FIXED_NOW },
  });
  assert.equal(result.ok, true, `real Core commitTransition must accept valid multi-ref phase evidence: ${JSON.stringify(result)}`);
  const committed = readLifecycle(fixture).events.find(({ event_id }) => event_id === result.event.event_id);
  assert.deepEqual(committed, result.event, 'the real lifecycle store must persist the committed event');
  return committed;
}

function artifactFlag(ref) {
  return `${ref.root}:${ref.kind}:${ref.path}:${ref.sha256}`;
}

function deliverySummary(result, eventId) {
  const delivery = result.deliveries.find(({ event_id }) => event_id === eventId);
  return delivery && { event_id: delivery.event_id, revision: delivery.revision, status: delivery.status };
}

function assertTerminalStaleDelivery(fixture, result, committedEvent) {
  const delivery = result.deliveries.find(({ event_id }) => event_id === committedEvent.event_id);
  assert.ok(delivery, `public drain must preserve event ID ${committedEvent.event_id}`);
  assert.deepEqual({
    event_id: delivery.event_id,
    revision: delivery.revision,
    status: delivery.status,
    code: delivery.error && delivery.error.code,
    retryable: delivery.error && delivery.error.retryable,
  }, {
    event_id: committedEvent.event_id,
    revision: committedEvent.revision,
    status: 'terminal',
    code: 'STALE_ARTIFACT',
    retryable: false,
  }, 'a changed second ref must produce terminal STALE_ARTIFACT at registered Enterprise delivery');
  const persistedEvent = readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id);
  assert.ok(persistedEvent, `Core journal must retain event ID ${committedEvent.event_id}`);
  assert.equal(persistedEvent.event_id, committedEvent.event_id);
  assert.deepEqual(persistedEvent.artifact_refs, committedEvent.artifact_refs,
    'delivery must not replace or reorder committed refs');
  assert.equal(persistedEvent.delivery.status, 'terminal');
  assert.equal(persistedEvent.delivery.error.code, 'STALE_ARTIFACT');
  assert.equal(persistedEvent.delivery.error.retryable, false);
}

function assertRemoteUnchanged(remoteBefore, fixture, label) {
  const remoteAfter = readRemote(fixture);
  assert.equal(remoteAfter.calls.length - remoteBefore.calls.length, 0, `${label} must make zero fake GitHub calls`);
  assert.equal(remoteAfter.effects.length - remoteBefore.effects.length, 0, `${label} must create zero fake GitHub effects`);
  assert.deepEqual(remoteAfter, remoteBefore, `${label} must leave the fake GitHub state unchanged`);
}

function readMetadata(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
}


module.exports = {
  commitPhaseComplete,
  artifactFlag,
  deliverySummary,
  assertTerminalStaleDelivery,
  assertRemoteUnchanged,
  readMetadata,
};
