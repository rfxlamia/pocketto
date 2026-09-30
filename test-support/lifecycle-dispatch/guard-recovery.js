'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, execFileSync, existsSync, mkdirSync, mkdtempSync, parseJson, path,
  readFileSync, readJsonLines, registerAdapter, rmSync, runCli, seedLifecycleEvent,
  sha256Hex, tmpdir, writeExecutable, writeFileSync,
} = require('./common');

function writeSuccessAdapter(root) {
  const adapterPath = writeExecutable(path.join(root, 'fake-adapter'), `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
  return adapterPath;
}

function makePendingPlan(specRoot, planId, projectDir) {
  const specDir = path.join(specRoot, planId);
  mkdirSync(specDir, { recursive: true });
  const content = `approved spec for ${planId}\n`;
  writeFileSync(path.join(specDir, 'spec.md'), content);
  const seeded = seedLifecycleEvent({
    specDir,
    planId,
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: sha256Hex(content), revision: 1 }],
  });
  const lifecyclePath = require('../../cli/lib/lifecycle-store').lifecyclePathFor(specDir);
  return { specDir, eventId: seeded.event.event_id, lifecyclePath, projectDir };
}

function drain(fixture) {
  return runCli(
    ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
    {
      cwd: fixture.projectDir,
      env: { ADAPTER_CALLS: fixture.callsPath, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK },
    },
  );
}

function createDeadGuardOwner(projectDir, guardPath, ownerId) {
  return Number(execFileSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fd = fs.openSync(process.env.GUARD_PATH, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ owner_id: process.env.GUARD_OWNER_ID, owner_pid: process.pid }) + '\\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      process.stdout.write(String(process.pid));
    `], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, GUARD_PATH: guardPath, GUARD_OWNER_ID: ownerId },
  }).trim());
}

function assertDeadGuardExited(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, 'guard fixture must record its creator PID');
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err && err.code === 'ESRCH') alive = false;
    else throw err;
  }
  assert.equal(alive, false, 'dead-guard fixture owner must have exited before drain');
}

function assertDeadGuardRecovered(fixture, callsPath) {
  const response = drain(fixture);
  const envelope = parseJson(response.stdout.trim(), 'dead guard drain response');
  assert.equal(envelope.ok, true, `drain should reclaim a dead guard: ${JSON.stringify(envelope)}${response.stderr}`);
  assert.equal(response.code, 0);
  assert.deepEqual(readJsonLines(callsPath), [{ event_id: fixture.eventId }], 'the reclaimed event must invoke the adapter exactly once');
  assert.equal(existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false, 'successful delivery must release the per-plan event lease');
  const deadLedger = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'dead guard lifecycle state');
  assert.equal(deadLedger.events[0].delivery.status, 'succeeded');
  assert.equal(deadLedger.events[0].delivery.attempts, 1, 'guard recovery must preserve one initial attempt');

  const repeatDeadDrain = drain(fixture);
  assert.equal(parseJson(repeatDeadDrain.stdout.trim(), 'repeat dead guard drain response').ok, true);
  assert.equal(readJsonLines(callsPath).length, 1, 'a completed event must not be invoked again');
}

function assertLiveGuardPreserved(fixture) {
  const liveGuardPath = path.join(fixture.specDir, '.lifecycle.lock.guard');
  const liveGuardBytes = `${JSON.stringify({
    owner_id: '00000000-0000-4000-8000-000000000092',
    owner_pid: process.pid,
  })}\n`;
  writeFileSync(liveGuardPath, liveGuardBytes, { flag: 'wx', mode: 0o600 });

  const response = drain(fixture);
  const envelope = parseJson(response.stdout.trim(), 'live guard drain response');
  assert.equal(envelope.ok, true, `drain should defer to a live guard owner: ${JSON.stringify(envelope)}${response.stderr}`);
  assert.equal(response.code, 0);
  assert.equal(readFileSync(liveGuardPath, 'utf8'), liveGuardBytes, "a live owner's guard must not be replaced or removed");
  const liveLedger = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'live guard lifecycle state');
  assert.equal(liveLedger.events[0].delivery.status, 'pending');
  assert.equal(liveLedger.events[0].delivery.attempts, 0, 'a live guard must block claim attempts');
}

test('lifecycle drain reclaims a dead guard owner but never steals from a live owner', () => {
  // Given a real per-plan guard written by an exited owner and another guard
  // owned by this live process, When drain runs, Then only the dead owner's
  // guard is reclaimed and each pending event can be invoked at most once.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-stale-guard-'));
  const projectDir = path.join(root, 'project');
  const specRoot = path.join(projectDir, 'spec');
  const pocketDir = path.join(projectDir, '.pocket');
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  mkdirSync(specRoot, { recursive: true });
  mkdirSync(pocketDir, { recursive: true });
  writeFileSync(callsPath, '');

  try {
    registerAdapter(pocketDir, writeSuccessAdapter(root), { events: ['spec-approved'] });
    const deadOwnerPlan = makePendingPlan(specRoot, 'dead-guard-plan', projectDir);
    const deadGuardPath = path.join(deadOwnerPlan.specDir, '.lifecycle.lock.guard');
    const deadOwnerId = '00000000-0000-4000-8000-000000000091';
    assertDeadGuardExited(createDeadGuardOwner(projectDir, deadGuardPath, deadOwnerId));
    assertDeadGuardRecovered(deadOwnerPlan, callsPath);

    const liveOwnerPlan = makePendingPlan(specRoot, 'live-guard-plan', projectDir);
    assertLiveGuardPreserved(liveOwnerPlan);
    assert.deepEqual(readJsonLines(callsPath), [{ event_id: deadOwnerPlan.eventId }], 'the live guard must not permit a second adapter invocation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
