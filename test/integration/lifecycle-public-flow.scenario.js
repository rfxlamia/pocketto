'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLAN_ID, PHASE_PATH, ISSUE_MARKER, PHASE_MARKER, ISSUE_URL, PR_URL, ISSUE_NUMBER, PR_NUMBER } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan } = require('./support/plan-commands');
const { runCore, assertCliOk } = require('./support/core-cli');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { sha256 } = require('./support/files');

test('public Core emitters deliver lifecycle events to exactly one canonical Enterprise proof', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  emitInitialEvents(fixture);
  deliverInitialEvents(fixture);
  emitClosureEvent(fixture);
  deliverClosureEvent(fixture);
  assertCanonicalProofs(fixture);
  assertRepeatedDrainIsNoop(fixture);
});

function emitInitialEvents(fixture) {
  const approved = runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    '--artifact', `spec:approved-spec:approved-spec.md:${sha256(fixture.approvedSpec)}`,
    '--json', '--contract', '3',
  ]);
  const approvedData = assertCliOk(approved, 'public spec-approved transition');
  assert.equal(approvedData.event_id, `${PLAN_ID}:spec-approved:r1`);
  assert.equal(approvedData.status, 'pending');
  assert.deepEqual(readRemote(fixture).calls, [], 'Core transition must remain locally successful without making remote calls');

  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'REVIEW', '--json', '--contract', '3',
  ]);
  const phaseData = assertCliOk(review, 'public log update REVIEW');
  assert.deepEqual(phaseData.event, {
    event_id: `${PLAN_ID}:phase-complete:r2`,
    plan_id: PLAN_ID,
    type: 'phase-complete',
    revision: 2,
    status: 'pending',
  });
  assert.deepEqual(readRemote(fixture).calls, [], 'log update must emit locally without invoking GitHub');
}

function deliverInitialEvents(fixture) {
  const drain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  const data = assertCliOk(drain, 'public first lifecycle drain');
  assert.deepEqual(data.deliveries.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
    { event_id: `${PLAN_ID}:spec-approved:r1`, revision: 1, status: 'succeeded' },
    { event_id: `${PLAN_ID}:phase-complete:r2`, revision: 2, status: 'succeeded' },
  ], 'Core must deliver the public-emitter events in revision order through the registered Enterprise executable');
}

function emitClosureEvent(fixture) {
  const phaseDone = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'DONE', '--json', '--contract', '3',
  ]);
  assertCliOk(phaseDone, 'public log update DONE');
  const closed = runCore(fixture, ['log', 'close', fixture.planDir, '--json', '--contract', '3']);
  const data = assertCliOk(closed, 'public log close');
  assert.equal(data.event.event_id, `${PLAN_ID}:plan-closed:r3`);
  assert.equal(data.event.status, 'pending');
  assert.deepEqual(readRemote(fixture).effects.map((effect) => effect.kind), [
    'issue-create', 'phase-summary-create',
  ], 'Core log emitters must have no remote side effects before drain');
}

function deliverClosureEvent(fixture) {
  const drain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  const data = assertCliOk(drain, 'public closure lifecycle drain');
  assert.deepEqual(data.deliveries.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
    { event_id: `${PLAN_ID}:plan-closed:r3`, revision: 3, status: 'succeeded' },
  ]);
}

function assertCanonicalProofs(fixture) {
  const lifecycle = readLifecycle(fixture);
  assert.deepEqual(lifecycle.events.map(({ event_id, revision, type, delivery }) => ({
    event_id, revision, type, status: delivery.status,
  })), [
    { event_id: `${PLAN_ID}:spec-approved:r1`, revision: 1, type: 'spec-approved', status: 'succeeded' },
    { event_id: `${PLAN_ID}:phase-complete:r2`, revision: 2, type: 'phase-complete', status: 'succeeded' },
    { event_id: `${PLAN_ID}:plan-closed:r3`, revision: 3, type: 'plan-closed', status: 'succeeded' },
  ]);
  assert.deepEqual(lifecycle.events.map((event) => event.delivery.proof_ref), [
    'meta:github_issue',
    'meta:phases.phase-1.github_pr+meta:phases.phase-1.review.fingerprints',
    'meta:github_issue|marker:issue-tasklist',
  ], 'Core must store only opaque canonical proof references');
  assert.ok(lifecycle.events.every((event) => /^[0-9a-f]{64}$/.test(event.delivery.proof_hash || '')));
  assert.ok(!JSON.stringify(lifecycle).includes(ISSUE_URL), 'Core lifecycle ledger must not contain remote issue URLs');
  assert.ok(!JSON.stringify(lifecycle).includes(PR_URL), 'Core lifecycle ledger must not contain remote PR URLs');
  assertHandlerMetadata(fixture);
  assertCanonicalRemoteEffects(fixture);
}

function assertHandlerMetadata(fixture) {
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadata.github_issue.ownership.event_id, `${PLAN_ID}:spec-approved:r1`);
  assert.equal(metadata.phases['phase-1'].review.proof.event_id, `${PLAN_ID}:phase-complete:r2`);
  assert.equal(metadata.phases['phase-1'].review.proof.marker, PHASE_MARKER);
  assert.equal(metadata.github_issue.tasklist.event_id, `${PLAN_ID}:plan-closed:r3`);
  assert.equal(metadata.github_issue.tasklist.marker, ISSUE_MARKER);
}

function assertCanonicalRemoteEffects(fixture) {
  const remote = readRemote(fixture);
  assert.deepEqual(remote.effects.map((effect) => effect.kind), [
    'issue-create', 'phase-summary-create', 'tasklist-create',
  ]);
  assert.equal(remote.issues.length, 1, 'spec-approved must create only one issue');
  assert.equal(remote.comments[String(PR_NUMBER)].filter((comment) => comment.body.startsWith(PHASE_MARKER)).length, 1,
    'phase-complete must leave exactly one canonical PR summary marker');
  assert.equal(remote.comments[String(ISSUE_NUMBER)].filter((comment) => comment.body.startsWith(ISSUE_MARKER)).length, 1,
    'plan-closed must leave exactly one canonical tasklist marker');
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true,
    'closure handler must write the local closeout artifact');
}

function assertRepeatedDrainIsNoop(fixture) {
  const before = readRemote(fixture);
  const replay = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  const data = assertCliOk(replay, 'public repeated lifecycle drain');
  assert.deepEqual(data.deliveries, [], 'succeeded events must not be invoked again');
  const after = readRemote(fixture);
  assert.equal(after.effects.length, before.effects.length, 'repeated drain must not create another remote effect');
  assert.equal(after.calls.length, before.calls.length, 'repeated drain must not call the remote transport');
}
