'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, createLifecycleProject, mkdtempSync, parseJson, path, readFileSync,
  readJsonLines, registerAdapter, rmSync, runCli, seedLifecycleEvent, sha256Hex,
  tmpdir, writeExecutable, writeFileSync,
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
    owner_pid: 2147483647,
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
  // Given a claimed event with an expired 60-second lease,
  // When a later worker drains,
  // Then it may reclaim the event, records the new owner, and does not overlap
  // the expired worker's invocation. Use a fixed clock and real claim/ledger files.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-expired-claim-'));
  try {
    assertExpiredClaimReclaimed(createExpiredClaimFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
