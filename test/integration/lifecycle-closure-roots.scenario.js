'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID, PHASE_PATH } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { runCore, assertCliOk } = require('./support/core-cli');
const { readRemote, readLifecycle } = require('./support/lifecycle-state');
const { installRegisteredEnterpriseReadFaultGate } = require('./support/failure-gates');
const { sha256, writeFile } = require('./support/files');
const { commitTransition } = require('../../cli/lib/lifecycle-store');
const { isDeepStrictEqual } = require('node:util');

const {
  assertClosureArtifactStateIsTerminal,
  commitPlanClosedEvent,
  commitPlanClosedEventWithNoncanonicalPlanDirectory,
  commitPlanClosedEventWithBothRoots,
  deliverySummary,
  readMetadata,
} = require('./lifecycle-closure-artifact.helpers.js');

test('plan-closed delivery rejects committed phase artifacts missing or changed after commit', async (t) => {
  for (const artifactState of ['missing', 'changed']) {
    await t.test(`${artifactState} committed plan-root phase artifact`, (subtest) =>
      assertClosureArtifactStateIsTerminal(subtest, artifactState));
  }
});

test('plan-closed validates a changed second spec-root ref before closure mutation', (t) => {
  const fixture = createFixture(t);
  const committedEvent = commitPlanClosedEventWithBothRoots(fixture);
  const [planRef, specRef] = committedEvent.artifact_refs;
  assert.equal(planRef.root, 'plan');
  assert.equal(specRef.root, 'spec');
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);
  const closeoutPath = path.join(fixture.planDir, 'closeout.md');
  assert.equal(metadataBefore.lifecycle_delivery.last_applied_revision, 2);
  assert.equal(metadataBefore.github_issue.tasklist, undefined);
  assert.equal(fs.existsSync(closeoutPath), false);

  writeFile(path.join(fixture.specDir, specRef.path), `${fixture.approvedSpec}Changed after closure commit.\n`);
  assert.equal(sha256(fs.readFileSync(path.join(fixture.planDir, planRef.path))), planRef.sha256,
    'only ref 2 may change after the store commits the closure event');
  assert.notEqual(sha256(fs.readFileSync(path.join(fixture.specDir, specRef.path))), specRef.sha256,
    'the spec-root ref 2 must be stale at delivery');

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'public drain of a plan-closed event with a stale spec-root ref');
  const delivery = drain.deliveries.find(({ event_id }) => event_id === committedEvent.event_id);
  const journalEvent = readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id);
  const metadataAfter = readMetadata(fixture);
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
    journalEventId: journalEvent && journalEvent.event_id,
    refsUnchanged: journalEvent && isDeepStrictEqual(journalEvent.artifact_refs, committedEvent.artifact_refs),
    journalStatus: journalEvent && journalEvent.delivery.status,
    journalCode: journalEvent && journalEvent.delivery.error && journalEvent.delivery.error.code,
    journalRetryable: journalEvent && journalEvent.delivery.error && journalEvent.delivery.error.retryable,
    remoteCallsAdded: remoteAfter.calls.length - remoteBefore.calls.length,
    remoteEffectsAdded: remoteAfter.effects.length - remoteBefore.effects.length,
    metadataUnchanged: isDeepStrictEqual(metadataAfter, metadataBefore),
    watermarkBefore: metadataBefore.lifecycle_delivery.last_applied_revision,
    watermarkAfter: metadataAfter.lifecycle_delivery.last_applied_revision,
    closureProofWritten: metadataAfter.github_issue.tasklist !== undefined,
    closeoutExists: fs.existsSync(closeoutPath),
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
    refsUnchanged: true,
    journalStatus: 'terminal',
    journalCode: 'STALE_ARTIFACT',
    journalRetryable: false,
    remoteCallsAdded: 0,
    remoteEffectsAdded: 0,
    metadataUnchanged: true,
    watermarkBefore: 2,
    watermarkAfter: 2,
    closureProofWritten: false,
    closeoutExists: false,
  }, 'every accepted plan-closed artifact ref must be validated before remote or local closure effects');
});

test('plan-closed resolves intact spec refs against selected roots in noncanonical plan directories', (t) => {
  const fixture = createFixture(t);
  const committedEvent = commitPlanClosedEventWithNoncanonicalPlanDirectory(fixture);
  const specRef = committedEvent.artifact_refs.find((ref) => ref.root === 'spec');
  const inferredSpecDir = path.join(fixture.root, 'spec', PLAN_ID);

  assert.equal(path.basename(fixture.planDir), PLAN_ID,
    'the selected plan directory keeps the logical plan identity');
  assert.notEqual(path.resolve(inferredSpecDir), path.resolve(fixture.specDir),
    'the old sibling inference must not identify the selected spec root');
  assert.equal(sha256(fs.readFileSync(path.join(fixture.specDir, specRef.path))), specRef.sha256,
    'the selected spec-root artifact remains intact at delivery');

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'public drain with intact selected-root evidence and noncanonical plan directory');
  assert.deepEqual(deliverySummary(drain, committedEvent.event_id), {
    event_id: committedEvent.event_id,
    revision: 3,
    status: 'succeeded',
  });
  const metadata = readMetadata(fixture);
  assert.equal(metadata.github_issue.tasklist.event_id, committedEvent.event_id);
  assert.equal(metadata.lifecycle_delivery.last_applied_revision, 3);
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true);
});

test('plan-closed rejects stale selected spec refs despite a matching-hash inferred sibling decoy', (t) => {
  const fixture = createFixture(t);
  const committedEvent = commitPlanClosedEventWithNoncanonicalPlanDirectory(fixture);
  const specRef = committedEvent.artifact_refs.find((ref) => ref.root === 'spec');
  const decoyPath = path.join(fixture.root, 'spec', PLAN_ID, specRef.path);
  const selectedArtifactPath = path.join(fixture.specDir, specRef.path);
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);
  const closeoutPath = path.join(fixture.planDir, 'closeout.md');

  writeFile(decoyPath, fixture.approvedSpec);
  assert.equal(sha256(fs.readFileSync(decoyPath)), specRef.sha256,
    'the decoy at the old inferred sibling must match the committed digest');
  writeFile(selectedArtifactPath, `${fixture.approvedSpec}Changed after closure commit.\n`);
  assert.notEqual(sha256(fs.readFileSync(selectedArtifactPath)), specRef.sha256,
    'the selected spec-root ref must be stale at delivery');
  assert.equal(metadataBefore.lifecycle_delivery.last_applied_revision, 2);
  assert.equal(metadataBefore.github_issue.tasklist, undefined);
  assert.equal(fs.existsSync(closeoutPath), false);

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'public drain with a stale selected-root ref and matching-hash sibling decoy');
  const delivery = drain.deliveries.find(({ event_id }) => event_id === committedEvent.event_id);
  const journalEvent = readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id);
  const metadataAfter = readMetadata(fixture);

  assert.deepEqual({
    delivery: delivery && {
      event_id: delivery.event_id,
      revision: delivery.revision,
      status: delivery.status,
      code: delivery.error && delivery.error.code,
      retryable: delivery.error && delivery.error.retryable,
    },
    journalEventId: journalEvent && journalEvent.event_id,
    refsUnchanged: journalEvent && isDeepStrictEqual(journalEvent.artifact_refs, committedEvent.artifact_refs),
    journalStatus: journalEvent && journalEvent.delivery.status,
    journalCode: journalEvent && journalEvent.delivery.error && journalEvent.delivery.error.code,
    journalRetryable: journalEvent && journalEvent.delivery.error && journalEvent.delivery.error.retryable,
    metadataUnchanged: isDeepStrictEqual(metadataAfter, metadataBefore),
    remoteUnchanged: isDeepStrictEqual(readRemote(fixture), remoteBefore),
    watermarkBefore: metadataBefore.lifecycle_delivery.last_applied_revision,
    watermarkAfter: metadataAfter.lifecycle_delivery.last_applied_revision,
    closureProofWritten: metadataAfter.github_issue.tasklist !== undefined,
    closeoutExists: fs.existsSync(closeoutPath),
  }, {
    delivery: {
      event_id: committedEvent.event_id,
      revision: committedEvent.revision,
      status: 'terminal',
      code: 'STALE_ARTIFACT',
      retryable: false,
    },
    journalEventId: committedEvent.event_id,
    refsUnchanged: true,
    journalStatus: 'terminal',
    journalCode: 'STALE_ARTIFACT',
    journalRetryable: false,
    metadataUnchanged: true,
    remoteUnchanged: true,
    watermarkBefore: 2,
    watermarkAfter: 2,
    closureProofWritten: false,
    closeoutExists: false,
  }, 'the selected root, not a matching decoy, must validate every committed spec ref before effects');
});
