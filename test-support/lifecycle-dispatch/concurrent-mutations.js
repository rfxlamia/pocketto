'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, mkdirSync, mkdtempSync, parseJson, path, readFileSync,
  rmSync, seedLifecycleEvent, sha256Hex, spawn, tmpdir, waitForFile, writeFileSync,
} = require('./common');

function mutationWorkerScript() {
  return `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const options = JSON.parse(process.env.LIFECYCLE_MUTATION_OPTIONS);
const originalReadFileSync = fs.readFileSync;
let paused = false;
fs.readFileSync = function(file, ...args) {
  const content = originalReadFileSync.call(this, file, ...args);
  if (path.resolve(String(file)) === options.lifecyclePath) {
    if (options.readMarker) fs.writeFileSync(options.readMarker, 'read');
    if (options.pauseAfterRead && !paused) {
      paused = true;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(options.releasePath)) Atomics.wait(wait, 0, 0, 10);
    }
  }
  return content;
};
const { commitTransition, updateEventDelivery } = require('./cli/lib/lifecycle-store');
let result;
if (options.operation === 'delivery') {
  result = updateEventDelivery(options.specDir, options.eventId, { status: 'succeeded', attempts: 1 });
} else {
  fs.writeFileSync(options.startedPath, 'started');
  result = commitTransition({
    specDir: options.specDir,
    planDir: options.planDir,
    planId: 'demo-plan',
    type: 'phase-complete',
    artifacts: [{
      root: 'plan',
      kind: 'phase-evidence',
      path: 'phase.md',
      sha256: options.phaseSha,
      revision: 1,
    }],
    deps: { now: () => options.clock },
  });
}
if (!result || !result.ok) throw new Error('lifecycle mutation failed: ' + JSON.stringify(result));
`;
}

function startMutationWorker(script, options) {
  const child = spawn(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, LIFECYCLE_MUTATION_OPTIONS: JSON.stringify(options) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.once('error', (err) => resolve({ code: -1, signal: null, stdout, stderr: err.message }));
  });
  return { child, done };
}

function createMutationFixture(root) {
  const specDir = path.join(root, 'spec');
  const planDir = path.join(root, 'plan');
  const lifecyclePath = path.join(specDir, 'lifecycle.json');
  const releaseDeliveryPath = path.join(root, 'release-delivery');
  const deliveryReadPath = path.join(root, 'delivery-read');
  const transitionReadPath = path.join(root, 'transition-read');
  const transitionStartedPath = path.join(root, 'transition-started');
  mkdirSync(specDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const specContent = 'approved spec for mutation race\n';
  const phaseContent = 'phase evidence for mutation race\n';
  writeFileSync(path.join(specDir, 'spec.md'), specContent);
  writeFileSync(path.join(planDir, 'phase.md'), phaseContent);
  const seeded = seedLifecycleEvent({
    specDir,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: sha256Hex(specContent), revision: 1 }],
  });
  return {
    specDir,
    planDir,
    lifecyclePath,
    releaseDeliveryPath,
    deliveryReadPath,
    transitionReadPath,
    transitionStartedPath,
    eventId: seeded.event.event_id,
    phaseSha: sha256Hex(phaseContent),
  };
}

function mutationOptions(fixture) {
  const base = {
    specDir: fixture.specDir,
    lifecyclePath: fixture.lifecyclePath,
    releasePath: fixture.releaseDeliveryPath,
  };
  return {
    delivery: {
      ...base,
      operation: 'delivery',
      eventId: fixture.eventId,
      pauseAfterRead: true,
      readMarker: fixture.deliveryReadPath,
    },
    transition: {
      ...base,
      operation: 'transition',
      planDir: fixture.planDir,
      phaseSha: fixture.phaseSha,
      clock: FIXED_CLOCK,
      startedPath: fixture.transitionStartedPath,
      readMarker: fixture.transitionReadPath,
      pauseAfterRead: false,
    },
  };
}

function assertConcurrentMutations(after) {
  assert.equal(after.plan.revision, 2, 'the concurrent transition must persist its new revision');
  assert.deepEqual(after.events.map((event) => event.event_id), [
    'demo-plan:spec-approved:r1',
    'demo-plan:phase-complete:r2',
  ], 'the concurrent transition must preserve both journal events');
  assert.equal(after.events[0].delivery.status, 'succeeded', 'the delivery result must survive the transition write');
  assert.equal(after.events[0].delivery.attempts, 1);
  assert.equal(after.events[1].delivery.status, 'pending');
}

async function runMutationRace(fixture) {
  const options = mutationOptions(fixture);
  const script = mutationWorkerScript();
  const workers = [
    startMutationWorker(script, options.delivery),
  ];
  try {
    assert.equal(await waitForFile(fixture.deliveryReadPath, 5000), true, 'delivery worker must pause after reading lifecycle.json');
    workers.push(startMutationWorker(script, options.transition));
    assert.equal(await waitForFile(fixture.transitionStartedPath, 5000), true, 'transition worker must start');
    // Without shared serialization the transition reads old state and overwrites delivery;
    // with serialization it waits, so the read marker controls releasing the first mutation.
    if (await waitForFile(fixture.transitionReadPath, 1500)) {
      const transitionResult = await workers[1].done;
      assert.equal(transitionResult.code, 0, `transition worker should succeed: ${transitionResult.stderr}`);
    }
    writeFileSync(fixture.releaseDeliveryPath, 'release');
    const workerResults = await Promise.all(workers.map((worker) => worker.done));
    for (const result of workerResults) {
      assert.equal(result.code, 0, `lifecycle mutation worker should succeed: ${result.stderr}`);
    }
    assertConcurrentMutations(parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'lifecycle state after concurrent mutations'));
  } finally {
    try { writeFileSync(fixture.releaseDeliveryPath, 'release'); } catch {}
    await Promise.all(workers.map((worker) => worker.done));
  }
}

test('concurrent lifecycle transition and delivery mutations preserve both updates', async () => {
  // Given an existing event, When a delivery save pauses after reading while a
  // new transition overlaps, Then both the new revision and delivery result persist.
  // Child processes exercise the real store and atomic-file writer; file markers
  // make the read-modify-write overlap deterministic without replacing persistence.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-mutation-race-'));
  try {
    await runMutationRace(createMutationFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
