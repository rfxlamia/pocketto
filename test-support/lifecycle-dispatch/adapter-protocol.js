'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, createLifecycleProject, mkdirSync, mkdtempSync, parseJson, path,
  readFileSync, readJsonLines, registerAdapter, rmSync, runCli,
  seedLifecycleEvent, sha256Hex, tmpdir, writeExecutable, writeFileSync,
} = require('./common');

function createGhTrap(root) {
  const binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const callsPath = path.join(root, 'gh-calls.txt');
  writeFileSync(callsPath, '');
  writeExecutable(path.join(binDir, 'gh'), `#!/usr/bin/env node
'use strict';
require('node:fs').appendFileSync(process.env.GH_CALLS, 'called\\n');
process.exit(91);
`);
  return { binDir, callsPath };
}

function protocolAdapterSource() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const mode = process.env.ADAPTER_MODE;
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id, mode }) + '\\n');
if (mode === 'timeout') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
} else if (mode === 'non-zero') {
  process.stderr.write('injected adapter exit\\n');
  process.exit(7);
} else if (mode === 'malformed') {
  process.stdout.write('{malformed response\\n');
} else if (mode === 'rate-limit') {
  process.stdout.write(JSON.stringify({
    event_id: event.event_id,
    status: 'retryable',
    error: { code: 'RATE_LIMIT', retryable: true, message: 'injected rate limit' },
  }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
}
`;
}

function createProtocolPlan(root, adapterPath, slug) {
  const fixture = createLifecycleProject(root, { projectName: slug, planId: slug });
  const specContent = `approved spec for ${slug}\n`;
  writeFileSync(path.join(fixture.specDir, 'spec.md'), specContent);
  const seeded = seedLifecycleEvent({
    specDir: fixture.specDir,
    planId: slug,
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: sha256Hex(specContent), revision: 1 }],
  });
  fixture.callsPath = path.join(fixture.projectDir, 'adapter-calls.jsonl');
  fixture.lifecyclePath = require('../../cli/lib/lifecycle-store').lifecyclePathFor(fixture.specDir);
  fixture.eventId = seeded.event.event_id;
  writeFileSync(fixture.callsPath, '');
  fixture.register = ({ adapterContract = 1, timeoutMs = 1000 } = {}) => registerAdapter(
    fixture.pocketDir,
    adapterPath,
    { adapterContract, events: ['spec-approved'], timeoutMs },
  );
  return fixture;
}

function runDrain(fixture, { mode = 'success', now = FIXED_CLOCK, binDir, ghCallsPath }) {
  return runCli(
    ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
    {
      cwd: fixture.projectDir,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        GH_CALLS: ghCallsPath,
        ADAPTER_CALLS: fixture.callsPath,
        ADAPTER_MODE: mode,
        POCKETTO_LIFECYCLE_NOW: now,
      },
    },
  );
}

function readDelivery(fixture) {
  return parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'protocol lifecycle state').events[0].delivery;
}

function assertRetryableFailure(fixture, label) {
  const doc = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), `${label} lifecycle state`);
  assert.equal(doc.plan.revision, 1, `${label} must not create lifecycle events`);
  assert.equal(doc.events.length, 1, `${label} must preserve the journal length`);
  assert.equal(doc.events[0].event_id, fixture.eventId, `${label} must preserve the original event ID`);
  assert.equal(doc.events[0].delivery.status, 'retryable', `${label} must be classified as retryable`);
  assert.equal(doc.events[0].delivery.attempts, 1, `${label} must record one bounded attempt`);
  assert.ok(doc.events[0].delivery.error, `${label} must record a protocol error`);
  assert.equal(doc.events[0].delivery.error.retryable, true, `${label} error must be marked retryable`);
  assert.equal(doc.events[0].delivery.error.attempts, 1, `${label} error must carry the bounded attempt count`);
  return doc.events[0].delivery;
}

function createRetrySchedule() {
  const baseMs = Date.parse(FIXED_CLOCK);
  return {
    baseMs,
    delays: [1_000, 5_000, 30_000, 120_000, 600_000],
    isoAt: (milliseconds) => new Date(milliseconds).toISOString(),
  };
}

function assertInitialRetry(fixture, schedule) {
  const event = readDelivery(fixture);
  assert.equal(event.status, 'retryable');
  assert.equal(event.attempts, 1);
  assert.equal(event.next_attempt_at, schedule.isoAt(schedule.baseMs + schedule.delays[0]));
}

function assertRetryDeferred(fixture, run, retryAt, attemptCount) {
  run(fixture, { mode: 'rate-limit', now: new Date(retryAt - 1).toISOString() });
  const event = readDelivery(fixture);
  assert.equal(event.attempts, attemptCount, 'drain must not retry before its scheduled delay');
  assert.equal(readJsonLines(fixture.callsPath).length, attemptCount, 'no adapter invocation may occur before the delay');
}

function assertRetryAttempt(fixture, run, retryAt, nextDelay, attemptCount, schedule) {
  run(fixture, { mode: 'rate-limit', now: schedule.isoAt(retryAt) });
  const event = readDelivery(fixture);
  assert.equal(event.attempts, attemptCount);
  assert.equal(readJsonLines(fixture.callsPath).length, attemptCount);
  if (attemptCount < 6) {
    assert.equal(event.status, 'retryable');
    assert.equal(event.next_attempt_at, schedule.isoAt(retryAt + nextDelay));
  } else {
    assert.equal(event.status, 'terminal', 'event must become terminal after five retries');
    assert.equal(event.error.retryable, false);
  }
}

function assertRetrySchedule(fixture, run) {
  const schedule = createRetrySchedule();
  run(fixture, { mode: 'rate-limit', now: FIXED_CLOCK });
  assertInitialRetry(fixture, schedule);
  let previousAttemptCount = 1;
  let scheduledAt = schedule.baseMs;
  for (let index = 0; index < schedule.delays.length; index += 1) {
    const retryAt = scheduledAt + schedule.delays[index];
    assertRetryDeferred(fixture, run, retryAt, previousAttemptCount);
    previousAttemptCount += 1;
    scheduledAt = retryAt;
    assertRetryAttempt(fixture, run, retryAt, schedule.delays[index + 1], previousAttemptCount, schedule);
  }
}

test('Core classifies adapter protocol failures with bounded retry scheduling and no GitHub calls', () => {
  // Given missing registration, wrong adapter contract, timeout, non-zero exit,
  // malformed response, or rate-limit failure, When Core drains committed events,
  // Then it records retryable protocol errors with original IDs and bounded attempts.
  // Timeout/rate-limit retries use 1s, 5s, 30s, 120s, and 600s before terminal state.
  // All remote command calls are trapped by a recording fake `gh`; no network is used.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-adapter-protocol-'));
  try {
    const { binDir, callsPath: ghCallsPath } = createGhTrap(root);
    const adapterPath = writeExecutable(path.join(root, 'fake-adapter'), protocolAdapterSource());
    const run = (fixture, options = {}) => runDrain(fixture, { ...options, binDir, ghCallsPath });
    const scenarios = [
      { label: 'missing-registration', mode: 'success', registration: null },
      { label: 'wrong-adapter-contract', mode: 'success', registration: { adapterContract: 2 } },
      { label: 'timeout', mode: 'timeout', registration: { timeoutMs: 150 } },
      { label: 'non-zero-exit', mode: 'non-zero', registration: {} },
      { label: 'malformed-response', mode: 'malformed', registration: {} },
    ];
    for (const scenario of scenarios) {
      const fixture = createProtocolPlan(root, adapterPath, `plan-${scenario.label}`);
      if (scenario.registration) fixture.register(scenario.registration);
      run(fixture, { mode: scenario.mode });
      assertRetryableFailure(fixture, scenario.label);
    }

    const retryFixture = createProtocolPlan(root, adapterPath, 'plan-rate-limit-retry');
    retryFixture.register({ timeoutMs: 1000 });
    assertRetrySchedule(retryFixture, run);
    assert.equal(readFileSync(ghCallsPath, 'utf8'), '', 'Core must perform zero GitHub calls');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
