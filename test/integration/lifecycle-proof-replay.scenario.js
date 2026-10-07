'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CORE_CLI, FIXED_NOW, PLAN_ID, PHASE_MARKER, PR_NUMBER } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { installLedgerFaultGate } = require('./support/failure-gates');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');
const { startProcess } = require('./support/process');

test('remote phase proof survives a local ledger timeout without another remote effect', async (t) => {
  const fixture = createFixture(t);
  const eventId = preparePhaseEvent(fixture);
  const faultGate = installLedgerFaultGate(fixture);
  const effectsBeforeReplay = await assertTimeoutAfterRemoteProof(fixture, faultGate, eventId);
  replayExistingPhaseProof(fixture, eventId, effectsBeforeReplay);
});

function preparePhaseEvent(fixture) {
  initializePlan(fixture);
  assert.equal(transitionApprovedSpec(fixture).event_id, `${PLAN_ID}:spec-approved:r1`);
  const initialDrain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  assert.equal(assertCliOk(initialDrain, 'public initial lifecycle drain').deliveries[0].status, 'succeeded');
  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, 'execution-plan/phase-1.md', 'REVIEW', '--json', '--contract', '3',
  ]);
  const eventId = assertCliOk(review, 'public log update REVIEW').event.event_id;
  assert.equal(eventId, `${PLAN_ID}:phase-complete:r2`);
  return eventId;
}

async function assertTimeoutAfterRemoteProof(fixture, faultGate, eventId) {
  const worker = startTimedOutWorker(fixture, faultGate, eventId);
  const output = await worker.done;
  assert.equal(output.exit, 1, 'the injected local ledger timeout must fail the first delivery attempt');
  assert.equal(fs.readFileSync(faultGate.hitPath, 'utf8'), 'timeout-before-success-write');
  const envelope = JSON.parse(output.stdout);
  assert.equal(envelope.error.code, 'TEST_LEDGER_TIMEOUT');
  assertClaimRemainsPending(fixture, worker, eventId);
  assertCanonicalMarkerWasWritten(fixture, eventId);
  return readRemote(fixture).effects;
}

function startTimedOutWorker(fixture, faultGate, eventId) {
  return startProcess(process.execPath, [
    CORE_CLI, 'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    cwd: fixture.root,
    env: {
      ...fixture.env,
      NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' '),
      LIFECYCLE_LEDGER_FAULT_EVENT_ID: eventId,
      LIFECYCLE_LEDGER_FAULT_HIT_FILE: faultGate.hitPath,
      LIFECYCLE_LEDGER_FAULT_MODE: 'timeout-before-success-write',
    },
  });
}

function assertClaimRemainsPending(fixture, worker, eventId) {
  const event = readLifecycle(fixture).events[1];
  assert.equal(event.event_id, eventId);
  assert.equal(event.delivery.status, 'claimed',
    'the local ledger must remain at the pre-success claim state after its writer times out');
  assert.equal(event.delivery.attempts, 1);
  const claim = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.lifecycle.lock'), 'utf8'));
  assert.equal(claim.event_id, eventId);
  assert.equal(claim.owner_pid, worker.child.pid);
}

function assertCanonicalMarkerWasWritten(fixture, eventId) {
  const remote = readRemote(fixture);
  const markers = (remote.comments[String(PR_NUMBER)] || []).filter(({ body }) => body.startsWith(PHASE_MARKER));
  assert.equal(markers.length, 1, 'the real Enterprise phase handler must write one canonical marker before the local timeout');
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadata.phases['phase-1'].review.proof.event_id, eventId,
    'the adapter must have persisted event-bound proof before Core reports the ledger timeout');
}

function replayExistingPhaseProof(fixture, eventId, effectsBeforeReplay) {
  const recoveryNow = new Date(Date.parse(FIXED_NOW) + 60_001).toISOString();
  const replay = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], { ...fixture.env, POCKETTO_LIFECYCLE_NOW: recoveryNow });
  assert.deepEqual(assertCliOk(replay, 'public phase-event replay after local ledger timeout').deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: eventId, status: 'succeeded' },
  ]);
  assertReconciledProof(fixture, eventId, effectsBeforeReplay);
}

function assertReconciledProof(fixture, eventId, effectsBeforeReplay) {
  const event = readLifecycle(fixture).events[1];
  assert.equal(event.delivery.status, 'succeeded');
  assert.equal(event.delivery.attempts, 2);
  assert.equal(event.delivery.proof_ref, 'meta:phases.phase-1.github_pr+meta:phases.phase-1.review.fingerprints');
  const remote = readRemote(fixture);
  assert.deepEqual(remote.effects, effectsBeforeReplay,
    'replay must find the canonical remote marker before mutation and must not duplicate its effect');
  assert.equal((remote.comments[String(PR_NUMBER)] || []).filter(({ body }) => body.startsWith(PHASE_MARKER)).length, 1);
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadata.phases['phase-1'].review.proof.event_id, eventId);
  assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false,
    'successful proof reconciliation must release the recovered claim');
}
