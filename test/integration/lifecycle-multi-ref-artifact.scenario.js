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
const { sha256, writeFile } = require('./support/files');

const {
  commitPhaseComplete,
  artifactFlag,
  deliverySummary,
  assertTerminalStaleDelivery,
  assertRemoteUnchanged,
  readMetadata,
} = require('./lifecycle-stale-artifact-common.helpers.js');

test('spec-approved rejects a changed second committed spec ref before remote reconciliation', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const secondPath = 'supporting-spec.md';
  const secondContents = '# Supporting approved evidence\n';
  writeFile(path.join(fixture.specDir, secondPath), secondContents);
  const refs = [
    { root: 'spec', kind: 'approved-spec', path: 'approved-spec.md', sha256: sha256(fixture.approvedSpec), revision: 1 },
    { root: 'spec', kind: 'approved-spec', path: secondPath, sha256: sha256(secondContents), revision: 1 },
  ];
  const transition = runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    ...refs.flatMap((ref) => ['--artifact', artifactFlag(ref)]),
    '--json', '--contract', '3',
  ]);
  const committed = assertCliOk(transition, 'public multi-ref spec-approved transition');
  const committedEvent = readLifecycle(fixture).events.find(({ event_id }) => event_id === committed.event_id);
  assert.ok(committedEvent, 'the real Core store must commit the multi-ref event before mutation');
  assert.deepEqual(committedEvent.artifact_refs, refs);
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);

  writeFile(path.join(fixture.specDir, secondPath), `${secondContents}Changed after commit.\n`);
  assert.equal(sha256(fs.readFileSync(path.join(fixture.specDir, refs[0].path))), refs[0].sha256,
    'ref 1 must remain intact after commit');
  assert.notEqual(sha256(fs.readFileSync(path.join(fixture.specDir, refs[1].path))), refs[1].sha256,
    'only ref 2 must change after commit');

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'public drain of stale multi-ref spec-approved event');
  assertTerminalStaleDelivery(fixture, drain, committedEvent);

  const metadataAfter = readMetadata(fixture);
  assert.deepEqual(metadataAfter, metadataBefore,
    'stale second spec ref must not write issue/phase proof or advance the Enterprise watermark');
  assert.equal(metadataAfter.github_issue && metadataAfter.github_issue.ownership, undefined);
  assert.equal(metadataAfter.lifecycle_delivery, undefined);
  assertRemoteUnchanged(remoteBefore, fixture, 'stale second spec ref');
});

test('spec-approved still delivers when every committed spec ref remains intact', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const secondPath = 'supporting-spec.md';
  const secondContents = '# Supporting approved evidence\n';
  writeFile(path.join(fixture.specDir, secondPath), secondContents);
  const refs = [
    { root: 'spec', kind: 'approved-spec', path: 'approved-spec.md', sha256: sha256(fixture.approvedSpec), revision: 1 },
    { root: 'spec', kind: 'approved-spec', path: secondPath, sha256: sha256(secondContents), revision: 1 },
  ];
  const committed = assertCliOk(runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    ...refs.flatMap((ref) => ['--artifact', artifactFlag(ref)]),
    '--json', '--contract', '3',
  ]), 'public multi-ref spec-approved transition with intact artifacts');

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'public drain of intact multi-ref spec-approved event');
  assert.deepEqual(deliverySummary(drain, committed.event_id), {
    event_id: committed.event_id,
    revision: 1,
    status: 'succeeded',
  });
  assert.equal(readMetadata(fixture).github_issue.ownership.event_id, committed.event_id);
  assert.equal(readMetadata(fixture).lifecycle_delivery.last_applied_revision, 1);
});

test('phase-complete rejects a changed second committed phase-evidence ref before remote reconciliation', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const approved = transitionApprovedSpec(fixture);
  const initialDrain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'registered Enterprise spec-approved delivery before phase event');
  assert.deepEqual(deliverySummary(initialDrain, approved.event_id), {
    event_id: approved.event_id,
    revision: 1,
    status: 'succeeded',
  });

  const secondPath = 'execution-plan/phase-evidence-support.md';
  const secondContents = '# Phase 1 supporting evidence\n';
  writeFile(path.join(fixture.planDir, secondPath), secondContents);
  const refs = [
    { root: 'plan', kind: 'phase-evidence', path: PHASE_PATH, sha256: sha256(fs.readFileSync(path.join(fixture.planDir, PHASE_PATH))), revision: 1 },
    { root: 'plan', kind: 'phase-evidence', path: secondPath, sha256: sha256(secondContents), revision: 1 },
  ];
  const committedEvent = commitPhaseComplete(fixture, refs);
  assert.equal(committedEvent.event_id, `${PLAN_ID}:phase-complete:r2`);
  assert.deepEqual(committedEvent.artifact_refs, refs,
    'the real Core contract/store must accept and commit both phase-evidence refs');
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);
  assert.equal(metadataBefore.lifecycle_delivery.last_applied_revision, 1);

  writeFile(path.join(fixture.planDir, secondPath), `${secondContents}Changed after commit.\n`);
  assert.equal(sha256(fs.readFileSync(path.join(fixture.planDir, refs[0].path))), refs[0].sha256,
    'ref 1 must remain intact after commit');
  assert.notEqual(sha256(fs.readFileSync(path.join(fixture.planDir, refs[1].path))), refs[1].sha256,
    'only ref 2 must change after commit');

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'public drain of stale multi-ref phase-complete event');
  assertTerminalStaleDelivery(fixture, drain, committedEvent);

  const metadataAfter = readMetadata(fixture);
  assert.deepEqual(metadataAfter, metadataBefore,
    'stale second phase ref must not write issue/phase proof or advance the Enterprise watermark');
  assert.equal(metadataAfter.github_issue.ownership.event_id, approved.event_id,
    'existing issue proof must not be changed by the failed phase event');
  assert.equal(metadataAfter.phases['phase-1'].review && metadataAfter.phases['phase-1'].review.proof, undefined,
    'failed phase delivery must not persist a phase proof');
  assert.equal(metadataAfter.lifecycle_delivery.last_applied_revision, 1,
    'failed phase delivery must not advance its applied-revision watermark');
  assertRemoteUnchanged(remoteBefore, fixture, 'stale second phase ref');
});

test('phase-complete still delivers when every committed phase-evidence ref remains intact', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const approved = transitionApprovedSpec(fixture);
  const initialDrain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'registered Enterprise spec-approved delivery before intact multi-ref phase event');
  assert.deepEqual(deliverySummary(initialDrain, approved.event_id), {
    event_id: approved.event_id,
    revision: 1,
    status: 'succeeded',
  });

  const secondPath = 'execution-plan/phase-evidence-support.md';
  const secondContents = '# Phase 1 supporting evidence\n';
  writeFile(path.join(fixture.planDir, secondPath), secondContents);
  const refs = [
    { root: 'plan', kind: 'phase-evidence', path: PHASE_PATH, sha256: sha256(fs.readFileSync(path.join(fixture.planDir, PHASE_PATH))), revision: 1 },
    { root: 'plan', kind: 'phase-evidence', path: secondPath, sha256: sha256(secondContents), revision: 1 },
  ];
  const committedEvent = commitPhaseComplete(fixture, refs);
  const remoteBefore = readRemote(fixture);

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'public drain of intact multi-ref phase-complete event');
  assert.deepEqual(deliverySummary(drain, committedEvent.event_id), {
    event_id: committedEvent.event_id,
    revision: 2,
    status: 'succeeded',
  });
  const metadata = readMetadata(fixture);
  assert.equal(metadata.phases['phase-1'].review.proof.event_id, committedEvent.event_id);
  assert.equal(metadata.lifecycle_delivery.last_applied_revision, 2);
  const remoteAfter = readRemote(fixture);
  assert.deepEqual(remoteAfter.effects.slice(remoteBefore.effects.length).map(({ kind }) => kind), ['phase-summary-create']);
});
