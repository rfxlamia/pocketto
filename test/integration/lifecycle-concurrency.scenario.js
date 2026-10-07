'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CORE_CLI, PLAN_ID } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { installStaleCandidateGate } = require('./support/failure-gates');
const { runCore, assertCliOk } = require('./support/core-cli');
const { startProcess, waitForFile } = require('./support/process');
const { writeFile } = require('./support/files');

test('concurrent public drains produce one claim and one real Enterprise remote effect', async (t) => {
  const scenario = prepareConcurrentDrains(t);
  try {
    await assertBothWorkersQueued(scenario);
    const remoteBeforeWorkerB = await releaseWinnerAndPauseAtRemote(scenario);
    await rejectCompetingWorker(scenario, remoteBeforeWorkerB);
    await completeWinningWorker(scenario);
  } finally {
    await releaseAndWaitForWorkers(scenario);
  }
});

function prepareConcurrentDrains(t) {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const eventId = transitionApprovedSpec(fixture).event_id;
  const remoteGate = {
    readyPath: path.join(fixture.root, 'fake-github-create.ready'),
    releasePath: path.join(fixture.root, 'fake-github-create.release'),
  };
  const env = {
    ...fixture.env,
    FAKE_GH_GATE_EFFECT: 'issue-create',
    FAKE_GH_GATE_READY_FILE: remoteGate.readyPath,
    FAKE_GH_GATE_RELEASE_FILE: remoteGate.releasePath,
  };
  const gateA = installStaleCandidateGate(fixture, 'worker-a');
  const gateB = installStaleCandidateGate(fixture, 'worker-b');
  const workerA = startGatedDrain(fixture, env, gateA, eventId);
  const workerB = null;
  return { fixture, eventId, remoteGate, env, gateA, gateB, workerA, workerB };
}

function startGatedDrain(fixture, env, gate, eventId) {
  return startProcess(process.execPath, [
    CORE_CLI, 'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    cwd: fixture.root,
    env: {
      ...env,
      NODE_OPTIONS: [env.NODE_OPTIONS, `--require=${gate.hookPath}`].filter(Boolean).join(' '),
      STALE_QUEUE_EVENT_ID: eventId,
      STALE_QUEUE_READY_FILE: gate.readyPath,
      STALE_QUEUE_RELEASE_FILE: gate.releasePath,
    },
  });
}

async function assertBothWorkersQueued(scenario) {
  await waitForFile(scenario.gateA.readyPath, scenario.workerA.child);
  scenario.workerB = startGatedDrain(scenario.fixture, scenario.env, scenario.gateB, scenario.eventId);
  await waitForFile(scenario.gateB.readyPath, scenario.workerB.child);
  assert.equal(fs.existsSync(path.join(scenario.fixture.specDir, '.lifecycle.lock')), false,
    'both workers must have observed the same pending event before either acquires its claim');
}

async function releaseWinnerAndPauseAtRemote(scenario) {
  writeFile(scenario.gateA.releasePath, 'claim');
  await waitForFile(scenario.remoteGate.readyPath, scenario.workerA.child);
  const claimPath = path.join(scenario.fixture.specDir, '.lifecycle.lock');
  const activeClaim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  assert.equal(activeClaim.event_id, scenario.eventId);
  assert.equal(activeClaim.owner_pid, scenario.workerA.child.pid,
    'worker A must hold the real event claim while the Enterprise issue handler is at the fake GitHub boundary');
  const event = readLifecycle(scenario.fixture).events[0];
  assert.equal(event.delivery.status, 'claimed');
  assert.equal(event.delivery.attempts, 1);
  const remoteBeforeWorkerB = readRemote(scenario.fixture);
  assert.deepEqual(remoteBeforeWorkerB.effects, [],
    'the fake GitHub gate must pause before the real Enterprise handler mutates the remote state');
  return remoteBeforeWorkerB;
}

async function rejectCompetingWorker(scenario, remoteBeforeWorkerB) {
  writeFile(scenario.gateB.releasePath, 'claim');
  const output = await scenario.workerB.done;
  const data = assertCliOk(parseResult(output), 'concurrent public drain worker B');
  assert.deepEqual(data.deliveries, [{
    event_id: scenario.eventId, revision: 1, status: 'pending', deferred: true, reason: 'claim-held',
  }], 'the competing worker must fail the real claim rather than invoke the Enterprise handler');
  assert.deepEqual(readRemote(scenario.fixture), remoteBeforeWorkerB,
    'the competing worker must not call the fake GitHub transport or mutate remote state');
  assert.equal(JSON.parse(fs.readFileSync(path.join(scenario.fixture.specDir, '.lifecycle.lock'), 'utf8')).owner_pid,
    scenario.workerA.child.pid, 'worker B must not replace or release worker A’s claim');
}

async function completeWinningWorker(scenario) {
  writeFile(scenario.remoteGate.releasePath, 'complete');
  const output = await scenario.workerA.done;
  const data = assertCliOk(parseResult(output), 'concurrent public drain worker A');
  assert.deepEqual(data.deliveries.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
    { event_id: scenario.eventId, revision: 1, status: 'succeeded' },
  ]);
  const event = readLifecycle(scenario.fixture).events[0];
  assert.equal(event.delivery.status, 'succeeded');
  assert.equal(event.delivery.attempts, 1, 'the shared ledger must record one invocation, not a second delivery attempt');
  const remote = readRemote(scenario.fixture);
  assert.deepEqual(remote.effects.map((effect) => effect.kind), ['issue-create'],
    'both workers must converge on exactly one real Enterprise issue effect');
  assert.equal(remote.issues.length, 1);
  assert.equal(fs.existsSync(path.join(scenario.fixture.specDir, '.lifecycle.lock')), false,
    'the successful owner must release the real claim');
}

async function releaseAndWaitForWorkers(scenario) {
  writeFile(scenario.gateA.releasePath, 'claim');
  writeFile(scenario.gateB.releasePath, 'claim');
  writeFile(scenario.remoteGate.releasePath, 'complete');
  await scenario.workerA.done.catch(() => {});
  if (scenario.workerB) await scenario.workerB.done.catch(() => {});
}

function parseResult(output) {
  let json = null;
  try { json = JSON.parse(output.stdout); } catch { /* Preserve raw output for the assertion. */ }
  return { ...output, json };
}
