'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CORE_CLI, PLAN_ID, ISSUE_NUMBER } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { installFakeAdapter } = require('./support/enterprise');
const { appendOrderedPendingRevisions, readLifecycle, readRemote } = require('./support/lifecycle-state');
const { installStaleCandidateGate } = require('./support/failure-gates');
const { runCore, runCoreAsync, assertCliOk } = require('./support/core-cli');
const { startProcess, waitForFile } = require('./support/process');

test('a stale lower revision is a no-op after a later revision has succeeded', async (t) => {
  const scenario = prepareStaleRevisionRace(t);
  try {
    await waitForFile(scenario.gate.readyPath, scenario.worker.child);
    assert.equal(fs.readFileSync(scenario.gate.readyPath, 'utf8'), scenario.staleEventId,
      'the delayed worker must have queued revision 3 before attempting its real claim');
    assert.equal(fs.existsSync(path.join(scenario.fixture.specDir, '.lifecycle.lock')), false,
      'the delayed worker must not hold revision 3 while another worker advances the ledger');
    const snapshot = await drainOrderedRevisions(scenario.fixture, scenario.env);
    releaseStaleWorker(scenario.gate);
    await assertQueuedCandidateIsNoop(scenario, snapshot);
  } finally {
    releaseStaleWorker(scenario.gate);
    await scenario.worker.done.catch(() => {});
  }
});

function prepareStaleRevisionRace(t) {
  const fixture = createFixture(t);
  initializePlan(fixture);
  assert.equal(transitionApprovedSpec(fixture).event_id, `${PLAN_ID}:spec-approved:r1`);
  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, 'execution-plan/phase-1.md', 'REVIEW', '--json', '--contract', '3',
  ]);
  assert.equal(assertCliOk(review, 'public log update REVIEW').event.event_id, `${PLAN_ID}:phase-complete:r2`);
  const adapterTrace = path.join(fixture.root, 'fake-adapter.jsonl');
  fs.writeFileSync(adapterTrace, '');
  const env = installFakeAdapter(fixture, adapterTrace, { recordRemoteEffects: true });
  assertInitialRevisionsDelivered(fixture, env);
  assertOrderedJournal(appendOrderedPendingRevisions(fixture));
  const gate = installStaleCandidateGate(fixture);
  const staleEventId = `${PLAN_ID}:phase-complete:r3`;
  const worker = startStaleWorker(fixture, env, gate, staleEventId);
  return { fixture, env, gate, worker, staleEventId, adapterTrace };
}

function assertInitialRevisionsDelivered(fixture, env) {
  const initialDrain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'], env);
  assert.deepEqual(assertCliOk(initialDrain, 'public initial lifecycle drain').deliveries.map(({ revision, status }) => ({ revision, status })), [
    { revision: 1, status: 'succeeded' }, { revision: 2, status: 'succeeded' },
  ]);
}

function assertOrderedJournal(lifecycle) {
  assert.deepEqual(lifecycle.events.map((event) => event.revision), [1, 2, 3, 4, 5],
    'the append-only journal must retain monotonically increasing revision order');
  assert.deepEqual(lifecycle.events.map((event) => event.delivery.status), [
    'succeeded', 'succeeded', 'pending', 'pending', 'pending',
  ]);
}

function startStaleWorker(fixture, env, gate, staleEventId) {
  const gatedEnv = {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, `--require=${gate.hookPath}`].filter(Boolean).join(' '),
    STALE_QUEUE_EVENT_ID: staleEventId,
    STALE_QUEUE_READY_FILE: gate.readyPath,
    STALE_QUEUE_RELEASE_FILE: gate.releasePath,
  };
  return startProcess(process.execPath, [
    CORE_CLI, 'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], { cwd: fixture.root, env: gatedEnv });
}

async function drainOrderedRevisions(fixture, env) {
  const result = await runCoreAsync(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'], env);
  assert.deepEqual(assertCliOk(result, 'public ordered lifecycle drain').deliveries.map(({ revision, status }) => ({ revision, status })), [
    { revision: 3, status: 'succeeded' }, { revision: 4, status: 'succeeded' }, { revision: 5, status: 'succeeded' },
  ]);
  const lifecycle = readLifecycle(fixture);
  assert.equal(lifecycle.events.find((event) => event.revision === 5).delivery.status, 'succeeded');
  assert.ok(lifecycle.events.slice(2).every((event) => event.delivery.status === 'succeeded'));
  assertMonotonicRemoteState(fixture);
  assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false,
    'the advancing worker must release its real claim before the delayed worker resumes');
  return {
    ledger: fs.readFileSync(path.join(fixture.specDir, 'lifecycle.json')),
    remote: readRemote(fixture),
    trace: fs.readFileSync(path.join(fixture.root, 'fake-adapter.jsonl'), 'utf8'),
  };
}

function assertMonotonicRemoteState(fixture) {
  const remote = readRemote(fixture);
  const appliedRevisions = (remote.comments[String(ISSUE_NUMBER)] || [])
    .map(({ body }) => Number(body.match(/revision=(\d+)/)?.[1]));
  assert.deepEqual(appliedRevisions, [1, 2, 3, 4, 5], 'the fake GitHub state must advance monotonically through revision 5');
}

function releaseStaleWorker(gate) {
  fs.mkdirSync(path.dirname(gate.releasePath), { recursive: true });
  fs.writeFileSync(gate.releasePath, 'resume');
}

async function assertQueuedCandidateIsNoop(scenario, snapshot) {
  const afterRevisionFive = readLifecycle(scenario.fixture);
  assert.equal(afterRevisionFive.events.find((event) => event.revision === 3).delivery.status, 'succeeded',
    'revision 3 must already be complete when its queued candidate is resumed');
  const staleOutput = await scenario.worker.done;
  const staleJson = parseJson(staleOutput.stdout);
  const data = assertCliOk({ ...staleOutput, json: staleJson }, 'delayed public drain with a stale revision-3 candidate');
  assert.equal(data.plan_id, PLAN_ID);
  assert.deepEqual(data.deliveries, [], 'the stale queued candidate must be a no-op after revision 5 succeeds');
  assert.deepEqual(data.gaps, []);
  assert.equal(fs.readFileSync(path.join(scenario.fixture.specDir, 'lifecycle.json')).toString(), snapshot.ledger.toString(),
    'the delayed stale candidate must not mutate the authoritative lifecycle ledger');
  assert.equal(fs.readFileSync(scenario.adapterTrace, 'utf8'), snapshot.trace,
    'the delayed stale candidate must not invoke the registered adapter');
  assert.deepEqual(readRemote(scenario.fixture), snapshot.remote,
    'the delayed stale candidate must not regress remote state or create another effect');
  assert.equal(fs.existsSync(path.join(scenario.fixture.specDir, '.lifecycle.lock')), false,
    'the delayed worker must release its real claim after rechecking the ledger');
}

function parseJson(output) {
  try { return JSON.parse(output); } catch { /* Preserve raw output for the assertion. */ return null; }
}
