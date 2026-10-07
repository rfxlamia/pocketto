'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CORE_CLI, FIXED_NOW, PLAN_ID } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { installLedgerFaultGate } = require('./support/failure-gates');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');
const { startProcess } = require('./support/process');

test('expired event claims are reclaimed without overlapping the prior worker or duplicating remote proof', async (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const eventId = transitionApprovedSpec(fixture).event_id;
  const faultGate = installLedgerFaultGate(fixture);
  const expiredClaim = await crashWorkerAfterRemoteProof(fixture, faultGate, eventId);
  const effectsBeforeRecovery = assertExpiredClaimHasRemoteProof(fixture, expiredClaim, eventId);
  recoverExpiredClaim(fixture, eventId, effectsBeforeRecovery);
});

async function crashWorkerAfterRemoteProof(fixture, faultGate, eventId) {
  const worker = startProcess(process.execPath, [
    CORE_CLI, 'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    cwd: fixture.root,
    env: {
      ...fixture.env,
      NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' '),
      LIFECYCLE_LEDGER_FAULT_EVENT_ID: eventId,
      LIFECYCLE_LEDGER_FAULT_HIT_FILE: faultGate.hitPath,
      LIFECYCLE_LEDGER_FAULT_MODE: 'crash-before-success-write',
    },
  });
  const output = await worker.done;
  assert.equal(output.signal, 'SIGKILL',
    'the first worker must terminate after the real Enterprise handler writes remote proof but before local success persists');
  assert.equal(fs.readFileSync(faultGate.hitPath, 'utf8'), 'crash-before-success-write');
  assert.throws(() => process.kill(worker.child.pid, 0), (error) => error.code === 'ESRCH',
    'the expired claim owner must be dead before the later worker starts');
  return {
    claim: JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.lifecycle.lock'), 'utf8')),
    ownerPid: worker.child.pid,
  };
}

function assertExpiredClaimHasRemoteProof(fixture, expiredClaim, eventId) {
  const event = readLifecycle(fixture).events[0];
  assert.equal(event.event_id, eventId);
  assert.equal(event.delivery.status, 'claimed');
  assert.equal(event.delivery.attempts, 1);
  assert.equal(expiredClaim.claim.event_id, eventId);
  assert.equal(expiredClaim.claim.owner_pid, expiredClaim.ownerPid,
    'the real claim ledger must retain the crashed worker as owner');
  assert.equal(readRemote(fixture).effects.length, 1,
    'the real issue handler must have committed one remote proof before the worker died');
  assert.equal(readRemote(fixture).issues.length, 1);
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadata.github_issue.ownership.event_id, eventId);
  return readRemote(fixture).effects;
}

function recoverExpiredClaim(fixture, eventId, effectsBeforeRecovery) {
  const claimPath = path.join(fixture.specDir, '.lifecycle.lock');
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  const recoveryNow = new Date(Date.parse(FIXED_NOW) + 60_001).toISOString();
  assert.ok(Date.parse(claim.lease_expires_at) < Date.parse(recoveryNow),
    'the deterministic recovery clock must be beyond the original lease expiry');
  const recovered = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], { ...fixture.env, POCKETTO_LIFECYCLE_NOW: recoveryNow });
  assert.deepEqual(assertCliOk(recovered, 'public drain after event-claim lease expiry').deliveries.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
    { event_id: eventId, revision: 1, status: 'succeeded' },
  ]);
  assertReclaimedProofIsCanonical(fixture, claimPath, effectsBeforeRecovery);
}

function assertReclaimedProofIsCanonical(fixture, claimPath, effectsBeforeRecovery) {
  const event = readLifecycle(fixture).events[0];
  assert.equal(event.delivery.status, 'succeeded');
  assert.equal(event.delivery.attempts, 2, 'the recovered worker must record exactly one later invocation');
  assert.equal(event.delivery.proof_ref, 'meta:github_issue');
  assert.equal(readRemote(fixture).effects.length, 1, 'recovery must reuse the existing issue proof without a duplicate remote effect');
  assert.equal(readRemote(fixture).issues.length, 1);
  assert.deepEqual(readRemote(fixture).effects, effectsBeforeRecovery);
  assert.equal(fs.existsSync(claimPath), false, 'the reclaimed worker must release the real lock after success');
}
