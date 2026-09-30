'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');
const FIXED_CLOCK = '2026-09-19T12:00:00.000Z';

function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

function runCli(args, { cwd, env } = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
      code: err.status === null ? 1 : err.status,
    };
  }
}

test('lifecycle drain delivers contiguous events serially in revision order without creating events', () => {
  // Given pending/retryable events for one plan at contiguous revisions 1, 2, and 3,
  // When public `lifecycle drain` runs with a temporary plan and fake adapter,
  // Then it dispatches serially in ascending revision, creates no event, and
  // preserves each original event ID. The fixed clock and lifecycle store/files are real.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-order-'));
  try {
    const projectDir = path.join(root, 'project');
    const specDir = path.join(projectDir, 'spec', 'demo-plan');
    const planDir = path.join(projectDir, 'plans', 'demo-plan');
    const pocketDir = path.join(projectDir, '.pocket');
    mkdirSync(specDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });

    const specContent = 'approved spec\n';
    const phaseOneContent = 'phase one evidence\n';
    const phaseTwoContent = 'phase two evidence\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    writeFileSync(path.join(planDir, 'phase-one.md'), phaseOneContent);
    writeFileSync(path.join(planDir, 'phase-two.md'), phaseTwoContent);

    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const commit = (type, rootName, kind, relativePath, content, evidenceRevision) => {
      const result = commitTransition({
        specDir,
        planDir: type === 'spec-approved' ? null : planDir,
        planId: 'demo-plan',
        type,
        artifacts: [{
          root: rootName,
          kind,
          path: relativePath,
          sha256: sha256Hex(content),
          revision: evidenceRevision,
        }],
        deps: { now: () => FIXED_CLOCK },
      });
      assert.equal(result.ok, true, `event seed should succeed: ${JSON.stringify(result)}`);
      return result.event;
    };

    commit('spec-approved', 'spec', 'spec-doc', 'spec.md', specContent, 1);
    commit('phase-complete', 'plan', 'phase-evidence', 'phase-one.md', phaseOneContent, 1);
    commit('phase-complete', 'plan', 'phase-evidence', 'phase-two.md', phaseTwoContent, 2);

    const lifecyclePath = lifecyclePathFor(specDir);
    const before = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    before.events[1].delivery.status = 'retryable';
    before.events[1].delivery.attempts = 1;
    writeFileSync(lifecyclePath, `${JSON.stringify(before, null, 2)}\n`);
    const originalEventIds = before.events.map((event) => event.event_id);

    const callsPath = path.join(root, 'adapter-calls.jsonl');
    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) {
  process.stderr.write('event file argument is missing\\n');
  process.exit(2);
}
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const delayMs = { 1: 150, 2: 75, 3: 0 }[event.revision] || 0;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id, revision: event.revision }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved', 'phase-complete', 'plan-closed'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const result = runCli(
      ['lifecycle', 'drain', specDir, '--json', '--contract', '3'],
      {
        cwd: projectDir,
        env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: callsPath },
      },
    );
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(
      envelope.ok,
      true,
      `public lifecycle drain should succeed: ${JSON.stringify(envelope)}${result.stderr}`,
    );
    assert.equal(result.code, 0);
    assert.equal(envelope.command, 'lifecycle drain');
    assert.equal(envelope.contract, 3);

    const delivered = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      delivered,
      before.events.map((event) => ({ event_id: event.event_id, revision: event.revision })),
      'adapter completion order must remain serial and ascending by revision',
    );

    const after = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(after.plan.revision, before.plan.revision, 'drain must not create a lifecycle revision');
    assert.equal(after.events.length, before.events.length, 'drain must not append lifecycle events');
    assert.deepEqual(
      after.events.map((event) => event.event_id),
      originalEventIds,
      'drain must preserve every original event ID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle drain leaves revision gaps pending with an actionable diagnostic', () => {
  // Given revision 5 arrives while revision 4 is unavailable,
  // When public `lifecycle drain` runs,
  // Then revision 5 remains pending and the JSON envelope identifies the plan,
  // blocked revision, missing predecessor, and next actionable recovery step.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-gap-'));
  try {
    const projectDir = path.join(root, 'project');
    const specDir = path.join(projectDir, 'spec', 'demo-plan');
    const planDir = path.join(projectDir, 'plans', 'demo-plan');
    const pocketDir = path.join(projectDir, '.pocket');
    mkdirSync(specDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });

    const specContent = 'approved spec for gap test\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const seeded = commitTransition({
      specDir,
      planDir: null,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec.md',
        sha256: sha256Hex(specContent),
        revision: 1,
      }],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(seeded.ok, true, `revision 1 seed should succeed: ${JSON.stringify(seeded)}`);

    for (let revision = 2; revision <= 5; revision += 1) {
      const content = `phase ${revision} evidence\n`;
      const relativePath = `phase-${revision}.md`;
      writeFileSync(path.join(planDir, relativePath), content);
      const result = commitTransition({
        specDir,
        planDir,
        planId: 'demo-plan',
        type: 'phase-complete',
        artifacts: [{
          root: 'plan',
          kind: 'phase-evidence',
          path: relativePath,
          sha256: sha256Hex(content),
          revision,
        }],
        deps: { now: () => FIXED_CLOCK },
      });
      assert.equal(result.ok, true, `revision ${revision} seed should succeed: ${JSON.stringify(result)}`);
    }

    const lifecyclePath = lifecyclePathFor(specDir);
    const before = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    before.events = before.events
      .filter((event) => event.revision !== 4)
      .map((event) => {
        if (event.revision < 5) event.delivery.status = 'succeeded';
        return event;
      });
    writeFileSync(lifecyclePath, `${JSON.stringify(before, null, 2)}\n`);

    const callsPath = path.join(root, 'adapter-calls.jsonl');
    writeFileSync(callsPath, '');
    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved', 'phase-complete', 'plan-closed'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const result = runCli(
      ['lifecycle', 'drain', specDir, '--json', '--contract', '3'],
      {
        cwd: projectDir,
        env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: callsPath },
      },
    );
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.ok, true, `lifecycle drain should return a gap result: ${JSON.stringify(envelope)}`);
    assert.equal(envelope.command, 'lifecycle drain');
    assert.equal(envelope.contract, 3);

    const gaps = Array.isArray(envelope.data.gaps) ? envelope.data.gaps : [];
    assert.equal(gaps.length, 1, 'drain must classify the blocked revision gap');
    assert.equal(gaps[0].plan_id, 'demo-plan');
    assert.equal(gaps[0].blocked_revision, 5);
    assert.equal(gaps[0].missing_predecessor, 4);
    assert.ok(
      typeof gaps[0].next_step === 'string'
        && /4/.test(gaps[0].next_step)
        && /(restore|replay|recover)/i.test(gaps[0].next_step),
      'gap diagnostic must give an actionable recovery step for revision 4',
    );

    const after = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(after.plan.revision, 5);
    assert.equal(after.events.length, before.events.length);
    const revisionFive = after.events.find((event) => event.revision === 5);
    assert.equal(revisionFive.delivery.status, 'pending', 'revision 5 must remain pending behind the gap');
    assert.equal(readFileSync(callsPath, 'utf8'), '', 'revision 5 must not be dispatched out of order');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle repair rebuilds the log projection without emitting an event or dispatching', () => {
  // Given committed lifecycle state and event revision 4 with a stale log.json,
  // When public `lifecycle repair <spec_dir> --json --contract 3` runs,
  // Then log.json is rebuilt while revision, journal length, event IDs, and
  // delivery state remain unchanged. Only the projection writer is injected.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-repair-'));
  const planDir = path.join(root, 'plan-90');
  mkdirSync(planDir, { recursive: true });
  const executionDir = path.join(planDir, 'execution-plan');
  mkdirSync(executionDir, { recursive: true });

  const specContent = 'approved spec content\n';
  const phaseOne = 'seed evidence one\n';
  const phaseTwo = 'seed evidence two\n';
  const phaseContent = '# Phase 1\n\n### Task 1: First\n\nWork done.\n';
  writeFileSync(path.join(planDir, 'spec-doc.md'), specContent);
  writeFileSync(path.join(planDir, 'seed-one.md'), phaseOne);
  writeFileSync(path.join(planDir, 'seed-two.md'), phaseTwo);
  writeFileSync(path.join(planDir, 'execution-plan.md'), '# Execution Plan\n\n### Task 1: First\n\nBody.\n');
  writeFileSync(path.join(executionDir, 'index.md'), '# Plan Index\n\n**Source Plan:** ../execution-plan.md\n');
  writeFileSync(path.join(executionDir, 'phase-1.md'), phaseContent);

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Pocket Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Pocket Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args) => execFileSync('git', args, {
    cwd: planDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: gitEnv,
  });

  const originalClock = process.env.POCKETTO_LIFECYCLE_NOW;
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Pocket Test']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'plan snapshot']);
    git(['checkout', '-q', '-b', 'feature/issue-90']);

    const initialized = runCli(['log', 'init', planDir, '--json', '--contract', '3'], { cwd: planDir });
    assert.equal(JSON.parse(initialized.stdout.trim()).ok, true, `log init should succeed: ${initialized.stdout}`);
    const logPath = path.join(planDir, 'log.json');
    const initialProjection = JSON.parse(readFileSync(logPath, 'utf8'));
    const phaseFile = initialProjection.phases[0].file;

    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const seed = (input) => {
      const result = commitTransition({ ...input, deps: { now: () => FIXED_CLOCK } });
      assert.equal(result.ok, true, `lifecycle seed should succeed: ${JSON.stringify(result)}`);
      return result;
    };
    seed({
      specDir: planDir,
      planDir: null,
      planId: 'plan-90',
      type: 'spec-approved',
      artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(specContent), revision: 1 }],
    });
    seed({
      specDir: planDir,
      planDir,
      planId: 'plan-90',
      type: 'phase-complete',
      artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'seed-one.md', sha256: sha256Hex(phaseOne), revision: 1 }],
    });
    seed({
      specDir: planDir,
      planDir,
      planId: 'plan-90',
      type: 'phase-complete',
      artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'seed-two.md', sha256: sha256Hex(phaseTwo), revision: 1 }],
    });

    process.env.POCKETTO_LIFECYCLE_NOW = FIXED_CLOCK;
    const logCmd = require('../cli/commands/log');
    const failingProjectionWriter = () => {
      throw new Error('injected projection writer failure');
    };
    let projectionError = null;
    try {
      logCmd.run({
        sub: 'update',
        positionals: [planDir, phaseFile, 'REVIEW'],
        projectionWriter: failingProjectionWriter,
      });
    } catch (err) {
      projectionError = err;
    }
    assert.ok(projectionError, 'projection writer failure should be injected');
    assert.equal(projectionError.code, 'PROJECTION_REPAIR_REQUIRED');

    const lifecyclePath = lifecyclePathFor(planDir);
    const before = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(before.plan.revision, 4);
    assert.equal(before.events.length, 4);
    assert.equal(before.events[3].event_id, 'plan-90:phase-complete:r4');
    assert.equal(before.events[3].delivery.status, 'pending');
    assert.equal(JSON.parse(readFileSync(logPath, 'utf8')).phases[0].status, 'WAITING');
    rmSync(logPath);

    const repaired = runCli(
      ['lifecycle', 'repair', planDir, '--json', '--contract', '3'],
      { cwd: planDir, env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK } },
    );
    const envelope = JSON.parse(repaired.stdout.trim());
    assert.equal(envelope.ok, true, `public lifecycle repair should succeed: ${JSON.stringify(envelope)}${repaired.stderr}`);
    assert.equal(repaired.code, 0);
    assert.equal(envelope.command, 'lifecycle repair');
    assert.equal(envelope.contract, 3);

    const rebuiltProjection = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.equal(rebuiltProjection.phases[0].status, 'REVIEW');
    const after = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(after.plan.revision, before.plan.revision, 'repair must not change lifecycle revision');
    assert.equal(after.events.length, before.events.length, 'repair must not append an event');
    assert.deepEqual(after.events, before.events, 'repair must not dispatch or mutate lifecycle events');
  } finally {
    if (originalClock === undefined) delete process.env.POCKETTO_LIFECYCLE_NOW;
    else process.env.POCKETTO_LIFECYCLE_NOW = originalClock;
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent lifecycle drains allow only one UUID-owned event claim', async () => {
  // Given two workers receive the same pending event,
  // When both attempt processing,
  // Then only one UUID-owned claim succeeds and only one adapter invocation is possible.
  // Exercise public drain workers concurrently; use a real .lifecycle.lock and ledger.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-claim-'));
  const projectDir = path.join(root, 'project');
  const specDir = path.join(projectDir, 'spec', 'demo-plan');
  const pocketDir = path.join(projectDir, '.pocket');
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  const releasePath = path.join(root, 'release-adapter');
  const lockPath = path.join(specDir, '.lifecycle.lock');
  const workers = [];
  let results = [];
  let callsDuringClaim = [];
  let callsAfterRelease = [];
  let lockOwner = null;
  let deliveryDuringClaim = null;
  let after = null;
  let adapterStarted = false;

  try {
    mkdirSync(specDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });
    const specContent = 'approved spec for claim test\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    writeFileSync(callsPath, '');

    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const seeded = commitTransition({
      specDir,
      planDir: null,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec.md',
        sha256: sha256Hex(specContent),
        revision: 1,
      }],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(seeded.ok, true, `pending event seed should succeed: ${JSON.stringify(seeded)}`);

    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
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
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const startWorker = (workerId) => {
      const child = spawn('node', [
        CLI,
        'lifecycle',
        'drain',
        specDir,
        '--json',
        '--contract',
        '3',
      ], {
        cwd: projectDir,
        env: {
          ...process.env,
          POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK,
          ADAPTER_CALLS: callsPath,
          ADAPTER_RELEASE: releasePath,
          WORKER_ID: workerId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const spawned = new Promise((resolve) => {
        child.once('spawn', () => resolve(true));
        child.once('error', () => resolve(false));
      });
      const done = new Promise((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
        child.once('error', (err) => resolve({ code: -1, signal: null, stdout, stderr: `${stderr}${err.message}` }));
      });
      return { child, spawned, done };
    };

    const readCalls = () => {
      const content = readFileSync(callsPath, 'utf8').trim();
      return content ? content.split('\n').map((line) => JSON.parse(line)) : [];
    };
    const waitForFirstInvocation = async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (readCalls().length > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return readCalls().length > 0;
    };

    workers.push(startWorker('worker-a'));
    workers.push(startWorker('worker-b'));
    const spawned = await Promise.all(workers.map((worker) => worker.spawned));
    assert.ok(spawned.every(Boolean), 'both drain workers should start');
    adapterStarted = await waitForFirstInvocation();
    if (adapterStarted) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      callsDuringClaim = readCalls();
      if (existsSync(lockPath)) {
        try {
          lockOwner = JSON.parse(readFileSync(lockPath, 'utf8'));
        } catch {
          lockOwner = null;
        }
      }
      const during = JSON.parse(readFileSync(lifecyclePathFor(specDir), 'utf8'));
      deliveryDuringClaim = during.events[0].delivery;
    }

    writeFileSync(releasePath, 'release');
    results = await Promise.all(workers.map((worker) => worker.done));
    callsAfterRelease = readCalls();
    after = JSON.parse(readFileSync(lifecyclePathFor(specDir), 'utf8'));
  } finally {
    try {
      writeFileSync(releasePath, 'release');
    } catch {}
    await Promise.all(workers.map((worker) => worker.done));
    rmSync(root, { recursive: true, force: true });
  }

  assert.ok(adapterStarted, 'the claimed event should reach the fake adapter');
  assert.ok(lockOwner, 'the per-plan .lifecycle.lock must contain an owner record during invocation');
  assert.equal(lockOwner.event_id, 'demo-plan:spec-approved:r1');
  assert.match(lockOwner.owner_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(deliveryDuringClaim.status, 'claimed', 'the ledger must record the event claim before invocation');
  assert.equal(deliveryDuringClaim.attempts, 1, 'the first claim must increment attempts before invocation');
  assert.equal(callsDuringClaim.length, 1, 'only one worker may invoke the adapter for the event');
  assert.equal(callsAfterRelease.length, 1, 'the competing worker must not invoke after the first completes');
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.code, 0, `drain worker should exit cleanly: ${result.stdout}${result.stderr}`);
    assert.equal(JSON.parse(result.stdout.trim()).ok, true);
  }
  assert.equal(after.plan.revision, 1, 'claiming and delivering must not create a lifecycle event');
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].event_id, 'demo-plan:spec-approved:r1');
  assert.equal(after.events[0].delivery.status, 'succeeded');
  assert.equal(after.events[0].delivery.attempts, 1);
});

test('lifecycle drain reclaims an expired 60-second claim without overlapping invocation', () => {
  // Given a claimed event with an expired 60-second lease,
  // When a later worker drains,
  // Then it may reclaim the event, records the new owner, and does not overlap
  // the expired worker's invocation. Use a fixed clock and real claim/ledger files.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-expired-claim-'));
  try {
    const projectDir = path.join(root, 'project');
    const specDir = path.join(projectDir, 'spec', 'demo-plan');
    const pocketDir = path.join(projectDir, '.pocket');
    mkdirSync(specDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });

    const specContent = 'approved spec for expired claim test\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    const { commitTransition, lifecyclePathFor, updateEventDelivery } = require('../cli/lib/lifecycle-store');
    const seeded = commitTransition({
      specDir,
      planDir: null,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec.md',
        sha256: sha256Hex(specContent),
        revision: 1,
      }],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(seeded.ok, true, `pending event seed should succeed: ${JSON.stringify(seeded)}`);
    const eventId = seeded.event.event_id;
    const claimed = updateEventDelivery(specDir, eventId, { status: 'claimed', attempts: 1 });
    assert.equal(claimed.ok, true, `claimed event fixture should persist: ${JSON.stringify(claimed)}`);

    const oldOwnerId = '00000000-0000-4000-8000-000000000001';
    const oldOwnerPid = 2147483647;
    const lockPath = path.join(specDir, '.lifecycle.lock');
    const expiredClaim = {
      plan_id: 'demo-plan',
      event_id: eventId,
      owner_id: oldOwnerId,
      owner_pid: oldOwnerPid,
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

    const callsPath = path.join(root, 'adapter-calls.jsonl');
    const activePath = path.join(root, 'active-invocations.txt');
    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(callsPath, '');
    writeFileSync(activePath, '0');
    writeFileSync(adapterPath, `#!/usr/bin/env node
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
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const result = runCli(
      ['lifecycle', 'drain', specDir, '--json', '--contract', '3'],
      {
        cwd: projectDir,
        env: {
          POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK,
          ADAPTER_CALLS: callsPath,
          ACTIVE_INVOCATIONS: activePath,
          LIFECYCLE_LOCK: lockPath,
        },
      },
    );
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.ok, true, `later lifecycle drain should complete: ${JSON.stringify(envelope)}${result.stderr}`);
    assert.equal(result.code, 0);

    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, 1, 'later worker should reclaim the expired event and invoke the adapter once');
    assert.equal(calls[0].event_id, eventId);
    assert.notEqual(calls[0].owner_id, oldOwnerId, 'reclaim must persist a new UUID owner before invocation');
    assert.match(calls[0].owner_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    assert.equal(calls[0].overlapping, false, 'reclaimed invocation must not overlap another adapter invocation');
    assert.equal(readFileSync(activePath, 'utf8'), '0');

    const after = JSON.parse(readFileSync(lifecyclePathFor(specDir), 'utf8'));
    assert.equal(after.plan.revision, 1);
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].event_id, eventId);
    assert.equal(after.events[0].delivery.status, 'succeeded');
    assert.equal(after.events[0].delivery.attempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
