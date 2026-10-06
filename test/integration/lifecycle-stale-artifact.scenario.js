'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLAN_ID, PHASE_PATH } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { runCore, assertCliOk } = require('./support/core-cli');
const { readRemote, readLifecycle } = require('./support/lifecycle-state');
const { sha256 } = require('./support/files');
const { isDeepStrictEqual } = require('node:util');

test('committed artifacts that are missing or changed become terminal without GitHub mutation', async (t) => {
  for (const artifactState of ['missing', 'changed']) {
    await t.test(`${artifactState} spec artifact`, (subtest) => assertArtifactStateIsTerminal(subtest, artifactState));
  }
});

// T12 stale-artifact intent, preserved verbatim and in order:
// Test file: test/integration/lifecycle-enterprise.test.js
// Level: integration
// Intent: “Given a committed artifact is missing or changed before delivery, When the event is drained, Then delivery becomes terminal `STALE_ARTIFACT` and no remote handler is invoked.”
// Exercise through: “end-to-end drain with mutable temporary artifacts.”
// Test doubles: “fake GitHub runner and clock; use real artifact validation.”
// Expected RED: “commit-time versus delivery-time artifact classification is not covered across units.”
// Exact command: `node --test test/integration/lifecycle-enterprise.test.js`.
test('plan-closed delivery rejects committed phase artifacts missing or changed after commit', async (t) => {
  for (const artifactState of ['missing', 'changed']) {
    await t.test(`${artifactState} committed plan-root phase artifact`, (subtest) =>
      assertClosureArtifactStateIsTerminal(subtest, artifactState));
  }
});

function assertClosureArtifactStateIsTerminal(t, artifactState) {
  const fixture = createFixture(t);
  const committedEvent = commitPlanClosedEvent(fixture);
  const artifactPath = path.join(fixture.planDir, PHASE_PATH);
  const closeoutPath = path.join(fixture.planDir, 'closeout.md');
  const committedRef = committedEvent.artifact_refs.find((ref) => ref.root === 'plan');
  assert.ok(committedRef, 'Core log close must commit the plan-root phase evidence ref');
  assert.equal(committedRef.path, PHASE_PATH);
  assert.equal(committedRef.sha256, sha256(fixture.phaseEvidence));

  const metadataBefore = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  const remoteBefore = readRemote(fixture);
  const closeoutExistedBefore = fs.existsSync(closeoutPath);
  assert.equal(metadataBefore.lifecycle_delivery.last_applied_revision, 2,
    'only the committed spec-approved and phase-complete proofs may advance the watermark before closure delivery');
  assert.equal(metadataBefore.github_issue.tasklist, undefined);
  assert.equal(closeoutExistedBefore, false, 'no closeout file exists before closure delivery');

  if (artifactState === 'missing') fs.unlinkSync(artifactPath);
  else fs.writeFileSync(artifactPath, `${fixture.phaseEvidence}Changed after closure commit.\n`);

  const drain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  const data = assertCliOk(drain, `public drain with ${artifactState} committed plan artifact`);
  const delivery = data.deliveries.find(({ event_id }) => event_id === committedEvent.event_id);
  const journal = readLifecycle(fixture);
  const deliveredEvent = journal.events.find(({ event_id }) => event_id === committedEvent.event_id);
  const metadataAfter = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  const remoteAfter = readRemote(fixture);

  assert.deepEqual({
    delivery: delivery && {
      event_id: delivery.event_id,
      revision: delivery.revision,
      status: delivery.status,
      code: delivery.error && delivery.error.code,
      retryable: delivery.error && delivery.error.retryable,
    },
    committedEventId: committedEvent.event_id,
    journalEventId: deliveredEvent && deliveredEvent.event_id,
    journalStatus: deliveredEvent && deliveredEvent.delivery.status,
    journalCode: deliveredEvent && deliveredEvent.delivery.error && deliveredEvent.delivery.error.code,
    journalRetryable: deliveredEvent && deliveredEvent.delivery.error && deliveredEvent.delivery.error.retryable,
    remoteCallsAdded: remoteAfter.calls.length - remoteBefore.calls.length,
    remoteEffectsAdded: remoteAfter.effects.length - remoteBefore.effects.length,
    metadataUnchanged: isDeepStrictEqual(metadataAfter, metadataBefore),
    watermarkBefore: metadataBefore.lifecycle_delivery.last_applied_revision,
    watermarkAfter: metadataAfter.lifecycle_delivery.last_applied_revision,
    closureProofWritten: metadataAfter.github_issue.tasklist !== undefined,
    closeoutExistedBefore,
    closeoutExistsAfter: fs.existsSync(closeoutPath),
  }, {
    delivery: {
      event_id: committedEvent.event_id,
      revision: committedEvent.revision,
      status: 'terminal',
      code: 'STALE_ARTIFACT',
      retryable: false,
    },
    committedEventId: committedEvent.event_id,
    journalEventId: committedEvent.event_id,
    journalStatus: 'terminal',
    journalCode: 'STALE_ARTIFACT',
    journalRetryable: false,
    remoteCallsAdded: 0,
    remoteEffectsAdded: 0,
    metadataUnchanged: true,
    watermarkBefore: 2,
    watermarkAfter: 2,
    closureProofWritten: false,
    closeoutExistedBefore: false,
    closeoutExistsAfter: false,
  }, `${artifactState} phase evidence must be rejected before remote, metadata, watermark, or closeout mutation`);
}

function commitPlanClosedEvent(fixture) {
  initializePlan(fixture);
  assert.equal(transitionApprovedSpec(fixture).event_id, `${PLAN_ID}:spec-approved:r1`);
  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'REVIEW', '--json', '--contract', '3',
  ]);
  assert.equal(assertCliOk(review, 'public log update REVIEW').event.event_id, `${PLAN_ID}:phase-complete:r2`);
  const initialDrain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  assert.deepEqual(assertCliOk(initialDrain, 'public pre-closure lifecycle drain').deliveries.map(({ status }) => status), [
    'succeeded', 'succeeded',
  ]);
  const done = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'DONE', '--json', '--contract', '3',
  ]);
  assertCliOk(done, 'public log update DONE');
  const closed = runCore(fixture, ['log', 'close', fixture.planDir, '--json', '--contract', '3']);
  const data = assertCliOk(closed, 'public log close');
  const event = readLifecycle(fixture).events.find(({ event_id }) => event_id === data.event.event_id);
  assert.equal(data.event.event_id, `${PLAN_ID}:plan-closed:r3`);
  assert.equal(data.event.status, 'pending');
  assert.ok(event, 'public log close must append the closure event to the Core journal before mutation');
  assert.equal(event.type, 'plan-closed');
  assert.equal(event.delivery.status, 'pending');
  return event;
}

function assertArtifactStateIsTerminal(t, artifactState) {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const eventId = transitionApprovedSpec(fixture).event_id;
  alterCommittedArtifact(fixture, artifactState);
  const drain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  const data = assertCliOk(drain, `public drain with ${artifactState} committed artifact`);
  assert.deepEqual(data.deliveries.map(({ event_id, revision, status, error }) => ({
    event_id, revision, status, code: error && error.code,
  })), [{ event_id: eventId, revision: 1, status: 'terminal', code: 'STALE_ARTIFACT' }]);
  assertStaleArtifactHasNoRemoteEffects(fixture);
}

function alterCommittedArtifact(fixture, artifactState) {
  const artifactPath = path.join(fixture.specDir, 'approved-spec.md');
  if (artifactState === 'missing') fs.unlinkSync(artifactPath);
  else fs.writeFileSync(artifactPath, `${fixture.approvedSpec}Changed after commit.\n`);
}

function assertStaleArtifactHasNoRemoteEffects(fixture) {
  const event = readLifecycle(fixture).events[0];
  assert.equal(event.delivery.status, 'terminal');
  assert.equal(event.delivery.error.code, 'STALE_ARTIFACT');
  const remote = readRemote(fixture);
  assert.deepEqual(remote.calls, [], 'artifact validation must stop before the fake GitHub transport');
  assert.deepEqual(remote.effects, []);
  assert.deepEqual(remote.issues, []);
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadata.github_issue.ownership, undefined, 'stale content must not write Enterprise issue ownership proof');
  assert.equal(metadata.github_issue.number, undefined);
  assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false);
}
