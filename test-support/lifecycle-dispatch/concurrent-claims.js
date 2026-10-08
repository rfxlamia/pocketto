'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, createLifecycleProject, existsSync, mkdtempSync, parseJson, path,
  readFileSync, readJsonLines, registerAdapter, rmSync, seedLifecycleEvent,
  sha256Hex, startDrainWorker, tmpdir, writeExecutable, writeFileSync,
} = require('./common');

async function waitForFirstInvocation(callsPath) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (readJsonLines(callsPath).length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readJsonLines(callsPath).length > 0;
}

function blockingAdapterSource() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ worker_id: process.env.WORKER_ID, event_id: event.event_id }) + '\\n');
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 5000;
while (!fs.existsSync(process.env.ADAPTER_RELEASE) && Date.now() < deadline) Atomics.wait(waitBuffer, 0, 0, 10);
if (!fs.existsSync(process.env.ADAPTER_RELEASE)) process.exit(3);
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`;
}

function createClaimFixture(root, releasePath) {
  const project = createLifecycleProject(root);
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  const lockPath = path.join(project.specDir, '.lifecycle.lock');
  const specContent = 'approved spec for claim test\n';
  writeFileSync(path.join(project.specDir, 'spec.md'), specContent);
  writeFileSync(callsPath, '');
  seedLifecycleEvent({
    specDir: project.specDir,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: sha256Hex(specContent), revision: 1 }],
  });
  const adapterPath = writeExecutable(path.join(root, 'fake-adapter'), blockingAdapterSource());
  registerAdapter(project.pocketDir, adapterPath, { events: ['spec-approved'] });
  return { ...project, callsPath, lockPath, releasePath };
}

function claimWorkerEnv(fixture, workerId) {
  return {
    ...process.env,
    POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK,
    ADAPTER_CALLS: fixture.callsPath,
    ADAPTER_RELEASE: fixture.releasePath,
    WORKER_ID: workerId,
  };
}

async function observeConcurrentClaim(fixture, workers) {
  const spawned = await Promise.all(workers.map((worker) => worker.spawned));
  assert.ok(spawned.every(Boolean), 'both drain workers should start');
  const adapterStarted = await waitForFirstInvocation(fixture.callsPath);
  let callsDuringClaim = [];
  let lockOwner = null;
  let deliveryDuringClaim = null;
  if (adapterStarted) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    callsDuringClaim = readJsonLines(fixture.callsPath);
    if (existsSync(fixture.lockPath)) {
      try {
        lockOwner = parseJson(readFileSync(fixture.lockPath, 'utf8'), 'claim owner record');
      } catch {
        lockOwner = null;
      }
    }
    const lifecyclePath = require('../../cli/lib/lifecycle-store').lifecyclePathFor(fixture.specDir);
    const during = parseJson(readFileSync(lifecyclePath, 'utf8'), 'lifecycle state during claim');
    deliveryDuringClaim = during.events[0].delivery;
  }
  writeFileSync(fixture.releasePath, 'release');
  const results = await Promise.all(workers.map((worker) => worker.done));
  const callsAfterRelease = readJsonLines(fixture.callsPath);
  const lifecyclePath = require('../../cli/lib/lifecycle-store').lifecyclePathFor(fixture.specDir);
  const after = parseJson(readFileSync(lifecyclePath, 'utf8'), 'lifecycle state after claim');
  return { adapterStarted, callsDuringClaim, callsAfterRelease, deliveryDuringClaim, results, lockOwner, after };
}

function assertSingleClaim(observation) {
  assert.ok(observation.adapterStarted, 'the claimed event should reach the fake adapter');
  assert.ok(observation.lockOwner, 'the per-plan .lifecycle.lock must contain an owner record during invocation');
  assert.equal(observation.lockOwner.event_id, 'demo-plan:spec-approved:r1');
  assert.match(observation.lockOwner.owner_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(observation.deliveryDuringClaim.status, 'claimed', 'the ledger must record the event claim before invocation');
  assert.equal(observation.deliveryDuringClaim.attempts, 1, 'the first claim must increment attempts before invocation');
  assert.equal(observation.callsDuringClaim.length, 1, 'only one worker may invoke the adapter for the event');
  assert.equal(observation.callsAfterRelease.length, 1, 'the competing worker must not invoke after the first completes');
  assert.equal(observation.results.length, 2);
  for (const result of observation.results) {
    assert.equal(result.code, 0, `drain worker should exit cleanly: ${result.stdout}${result.stderr}`);
    assert.equal(parseJson(result.stdout.trim(), 'worker drain response').ok, true);
  }
  assert.equal(observation.after.plan.revision, 1, 'claiming and delivering must not create a lifecycle event');
  assert.equal(observation.after.events.length, 1);
  assert.equal(observation.after.events[0].event_id, 'demo-plan:spec-approved:r1');
  assert.equal(observation.after.events[0].delivery.status, 'succeeded');
  assert.equal(observation.after.events[0].delivery.attempts, 1);
}

async function runConcurrentClaimScenario(root) {
  const releasePath = path.join(root, 'release-adapter');
  const workers = [];
  try {
    const fixture = createClaimFixture(root, releasePath);
    workers.push(startDrainWorker(fixture.specDir, fixture.projectDir, claimWorkerEnv(fixture, 'worker-a')));
    workers.push(startDrainWorker(fixture.specDir, fixture.projectDir, claimWorkerEnv(fixture, 'worker-b')));
    assertSingleClaim(await observeConcurrentClaim(fixture, workers));
  } finally {
    try { writeFileSync(releasePath, 'release'); } catch {}
    await Promise.all(workers.map((worker) => worker.done));
    rmSync(root, { recursive: true, force: true });
  }
}

test('concurrent lifecycle drains allow only one UUID-owned event claim', async () => {
  // Given two workers receive the same pending event,
  // When both attempt processing,
  // Then only one UUID-owned claim succeeds and only one adapter invocation is possible.
  // Exercise public drain workers concurrently; use a real .lifecycle.lock and ledger.
  await runConcurrentClaimScenario(mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-claim-')));
});
