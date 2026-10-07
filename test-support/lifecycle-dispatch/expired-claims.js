'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, createLifecycleProject, existsSync, mkdtempSync, parseJson, path, readFileSync,
  readJsonLines, registerAdapter, rmSync, runCli, seedLifecycleEvent, sha256Hex,
  startDrainWorker, tmpdir, writeExecutable, writeFileSync,
} = require('./common');

function activeCounterAdapterSource() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(process.env.LIFECYCLE_LOCK, 'utf8'));
const active = Number(fs.readFileSync(process.env.ACTIVE_INVOCATIONS, 'utf8')) + 1;
fs.writeFileSync(process.env.ACTIVE_INVOCATIONS, String(active));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({
  event_id: event.event_id,
  owner_id: lock.owner_id,
  overlapping: active > 1,
}) + '\\n');
fs.writeFileSync(process.env.ACTIVE_INVOCATIONS, String(active - 1));
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`;
}

function writeExpiredClaim(lockPath, eventId) {
  const ownerId = '00000000-0000-4000-8000-000000000001';
  const expiredClaim = {
    plan_id: 'demo-plan',
    event_id: eventId,
    owner_id: ownerId,
    owner_pid: process.pid,
    claimed_at: '2026-09-19T11:58:59.000Z',
    lease_expires_at: '2026-09-19T11:59:59.000Z',
  };
  assert.equal(
    Date.parse(expiredClaim.lease_expires_at) - Date.parse(expiredClaim.claimed_at),
    60_000,
    'fixture lease must be exactly 60 seconds',
  );
  assert.ok(Date.parse(expiredClaim.lease_expires_at) < Date.parse(FIXED_CLOCK), 'fixture lease must be expired');
  writeFileSync(lockPath, `${JSON.stringify(expiredClaim)}\n`);
  return ownerId;
}

function createExpiredClaimFixture(root) {
  const { projectDir, specDir, pocketDir } = createLifecycleProject(root);
  const specContent = 'approved spec for expired claim test\n';
  writeFileSync(path.join(specDir, 'spec.md'), specContent);
  const seeded = seedLifecycleEvent({
    specDir,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: sha256Hex(specContent), revision: 1 }],
  });
  const eventId = seeded.event.event_id;
  const store = require('../../cli/lib/lifecycle-store');
  const claimed = store.updateEventDelivery(specDir, eventId, { status: 'claimed', attempts: 1 });
  assert.equal(claimed.ok, true, `claimed event fixture should persist: ${JSON.stringify(claimed)}`);
  const lockPath = path.join(specDir, '.lifecycle.lock');
  const oldOwnerId = writeExpiredClaim(lockPath, eventId);
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  const activePath = path.join(root, 'active-invocations.txt');
  writeFileSync(callsPath, '');
  writeFileSync(activePath, '0');
  const adapterPath = writeExecutable(path.join(root, 'fake-adapter'), activeCounterAdapterSource());
  registerAdapter(pocketDir, adapterPath, { events: ['spec-approved'] });
  return { projectDir, specDir, eventId, oldOwnerId, lockPath, callsPath, activePath, lifecyclePath: store.lifecyclePathFor(specDir) };
}

function assertExpiredClaimReclaimed(fixture) {
  const result = runCli(
    ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
    {
      cwd: fixture.projectDir,
      env: {
        POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK,
        ADAPTER_CALLS: fixture.callsPath,
        ACTIVE_INVOCATIONS: fixture.activePath,
        LIFECYCLE_LOCK: fixture.lockPath,
      },
    },
  );
  const envelope = parseJson(result.stdout.trim(), 'later drain response');
  assert.equal(envelope.ok, true, `later lifecycle drain should complete: ${JSON.stringify(envelope)}${result.stderr}`);
  assert.equal(result.code, 0);
  const calls = readJsonLines(fixture.callsPath);
  assert.equal(calls.length, 1, 'later worker should reclaim the expired event and invoke the adapter once');
  assert.equal(calls[0].event_id, fixture.eventId);
  assert.notEqual(calls[0].owner_id, fixture.oldOwnerId, 'reclaim must persist a new UUID owner before invocation');
  assert.match(calls[0].owner_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(calls[0].overlapping, false, 'reclaimed invocation must not overlap another adapter invocation');
  assert.equal(readFileSync(fixture.activePath, 'utf8'), '0');
  const after = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'lifecycle state after reclaim');
  assert.equal(after.plan.revision, 1);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].event_id, fixture.eventId);
  assert.equal(after.events[0].delivery.status, 'succeeded');
  assert.equal(after.events[0].delivery.attempts, 2);
}

test('lifecycle drain reclaims an expired 60-second claim without overlapping invocation', () => {
  // Given a claimed event with an expired 60-second lease whose owner_pid is
  // still alive (this process), When a later worker drains, Then lease expiry
  // reclaims the event. A live pid must not pin the claim.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-expired-claim-'));
  try {
    assertExpiredClaimReclaimed(createExpiredClaimFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function heldAdapterSource() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 15000;
while (!fs.existsSync(process.env.ADAPTER_RELEASE) && Date.now() < deadline) Atomics.wait(waitBuffer, 0, 0, 10);
if (!fs.existsSync(process.env.ADAPTER_RELEASE)) process.exit(3);
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`;
}

test('an in-flight adapter timeout keeps the claim past the 60-second idle lease', async () => {
  // Given a registration timeout longer than the idle lease, When the first
  // drain is still inside the adapter, Then a second drain whose clock is
  // past 60 seconds cannot reclaim or invoke that event.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-inflight-lease-'));
  const releasePath = path.join(root, 'release-adapter');
  const workers = [];
  try {
    const project = createLifecycleProject(root);
    const callsPath = path.join(root, 'adapter-calls.jsonl');
    const specContent = 'approved spec for in-flight lease\n';
    writeFileSync(callsPath, '');
    writeFileSync(path.join(project.specDir, 'spec.md'), specContent);
    seedLifecycleEvent({
      specDir: project.specDir,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: sha256Hex(specContent), revision: 1 }],
    });
    const timeoutMs = 120_000;
    const adapterPath = writeExecutable(path.join(root, 'fake-adapter'), heldAdapterSource());
    registerAdapter(project.pocketDir, adapterPath, { events: ['spec-approved'], timeoutMs });
    const first = startDrainWorker(project.specDir, project.projectDir, {
      ...process.env,
      POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK,
      ADAPTER_CALLS: callsPath,
      ADAPTER_RELEASE: releasePath,
    });
    workers.push(first);
    const deadline = Date.now() + 5000;
    while (readJsonLines(callsPath).length < 1) {
      if (Date.now() > deadline) assert.fail(`adapter was not invoked: ${(await first.done).stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const lock = parseJson(readFileSync(path.join(project.specDir, '.lifecycle.lock'), 'utf8'), 'in-flight claim');
    const leaseMs = Date.parse(lock.lease_expires_at) - Date.parse(FIXED_CLOCK);
    assert.ok(leaseMs >= timeoutMs, `in-flight lease must cover the adapter timeout, got ${leaseMs}`);
    const laterClock = new Date(Date.parse(FIXED_CLOCK) + 90_000).toISOString();
    const second = startDrainWorker(project.specDir, project.projectDir, {
      ...process.env,
      POCKETTO_LIFECYCLE_NOW: laterClock,
      ADAPTER_CALLS: callsPath,
      ADAPTER_RELEASE: releasePath,
    });
    workers.push(second);
    const secondResult = await second.done;
    assert.equal(secondResult.code, 0, `later drain should finish while the first invocation is running: ${secondResult.stderr}`);
    const secondEnvelope = parseJson(secondResult.stdout.trim(), 'later drain response');
    assert.equal(secondEnvelope.ok, true);
    assert.equal(secondEnvelope.data.deliveries[0].reason, 'claim-held');
    assert.equal(readJsonLines(callsPath).length, 1, 'the later drain must not invoke the adapter');
    writeFileSync(releasePath, 'release');
    const firstResult = await first.done;
    assert.equal(firstResult.code, 0, `first drain should complete after release: ${firstResult.stderr}`);
    assert.equal(readJsonLines(callsPath).length, 1);
  } finally {
    try { writeFileSync(releasePath, 'release'); } catch {}
    await Promise.all(workers.map((worker) => worker.done));
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseEventClaim does not unlink a lock replaced while the guard is held', async () => {
  const { Worker } = require('node:worker_threads');
  const { acquireLifecycleGuard, releaseLifecycleGuard } = require('../../cli/lib/lifecycle-lock');
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-release-owner-'));
  const lockPath = path.join(root, '.lifecycle.lock');
  const entered = path.join(root, 'entered');
  const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const claimBody = {
    plan_id: 'demo-plan',
    event_id: 'demo-plan:spec-approved:r1',
    owner_pid: process.pid,
    claimed_at: FIXED_CLOCK,
    lease_expires_at: '2026-09-19T12:01:00.000Z',
  };
  writeFileSync(lockPath, `${JSON.stringify({ ...claimBody, owner_id: ownerA })}\n`);
  const guard = acquireLifecycleGuard(lockPath);
  assert.ok(guard, 'the test must hold the lifecycle guard before release starts');
  const worker = new Worker(`
    const fs = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    const { releaseEventClaim } = require(workerData.claims);
    fs.writeFileSync(workerData.entered, '1');
    releaseEventClaim({ lockPath: workerData.lockPath, owner_id: workerData.ownerA });
    parentPort.postMessage('done');
  `, {
    eval: true,
    workerData: {
      claims: require.resolve('../../cli/lib/lifecycle-claims.js'),
      entered,
      lockPath,
      ownerA,
    },
  });
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(entered)) {
      if (Date.now() > deadline) throw new Error('release worker did not start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      parseJson(readFileSync(lockPath, 'utf8'), 'claim while release waits').owner_id,
      ownerA,
      'release must observe the owner only after it holds the lifecycle guard',
    );
    writeFileSync(lockPath, `${JSON.stringify({ ...claimBody, owner_id: ownerB })}\n`);
    releaseLifecycleGuard(guard);
    const message = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    assert.equal(message, 'done');
    assert.equal(parseJson(readFileSync(lockPath, 'utf8'), 'replacement claim').owner_id, ownerB);
  } finally {
    try { releaseLifecycleGuard(guard); } catch {}
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  }
});
