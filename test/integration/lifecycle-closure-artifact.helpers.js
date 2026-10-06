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

const { readMetadata, deliverySummary } = require('./lifecycle-stale-artifact-common.helpers');

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
  prepareClosureReadyPlan(fixture);
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

function prepareClosureReadyPlan(fixture) {
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
}

function commitPlanClosedEventWithNoncanonicalPlanDirectory(fixture) {
  prepareClosureReadyPlan(fixture);
  const noncanonicalPlanDir = path.join(fixture.root, 'noncanonical-plans', PLAN_ID);
  fs.mkdirSync(path.dirname(noncanonicalPlanDir), { recursive: true });
  fs.renameSync(fixture.planDir, noncanonicalPlanDir);
  fixture.planDir = noncanonicalPlanDir;

  const lifecycle = readLifecycle(fixture);
  lifecycle.plan.plan_dir = path.relative(fixture.root, fixture.planDir);
  writeFile(path.join(fixture.specDir, 'lifecycle.json'), `${JSON.stringify(lifecycle, null, 2)}\n`);

  const logPath = path.join(fixture.planDir, 'log.json');
  const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  log.header.status = 'DONE';
  log.header.date_completed = FIXED_NOW.slice(0, 10);
  writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  const refs = [
    { root: 'plan', kind: 'phase-evidence', path: PHASE_PATH, sha256: sha256(fixture.phaseEvidence), revision: 1 },
    { root: 'spec', kind: 'approved-spec', path: 'approved-spec.md', sha256: sha256(fixture.approvedSpec), revision: 1 },
  ];
  const result = commitTransition({
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: PLAN_ID,
    type: 'plan-closed',
    artifacts: refs,
    deps: { now: () => FIXED_NOW },
  });
  assert.equal(result.ok, true,
    `the real Core commitTransition/store must accept closure refs for the selected roots: ${JSON.stringify(result)}`);
  const event = readLifecycle(fixture).events.find(({ event_id }) => event_id === result.event.event_id);
  assert.deepEqual(event, result.event, 'the real lifecycle store must persist the multi-root closure event');
  assert.equal(event.event_id, `${PLAN_ID}:plan-closed:r3`);
  assert.deepEqual(event.artifact_refs, refs);
  return event;
}

function commitPlanClosedEventWithBothRoots(fixture) {
  prepareClosureReadyPlan(fixture);
  const logPath = path.join(fixture.planDir, 'log.json');
  const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  log.header.status = 'DONE';
  log.header.date_completed = FIXED_NOW.slice(0, 10);
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);

  const refs = [
    { root: 'plan', kind: 'phase-evidence', path: PHASE_PATH, sha256: sha256(fixture.phaseEvidence), revision: 1 },
    { root: 'spec', kind: 'approved-spec', path: 'approved-spec.md', sha256: sha256(fixture.approvedSpec), revision: 1 },
  ];
  const result = commitTransition({
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: PLAN_ID,
    type: 'plan-closed',
    artifacts: refs,
    deps: { now: () => FIXED_NOW },
  });
  assert.equal(result.ok, true,
    `the real Core commitTransition/store must accept valid plan- and spec-root closure refs: ${JSON.stringify(result)}`);
  const event = readLifecycle(fixture).events.find(({ event_id }) => event_id === result.event.event_id);
  assert.deepEqual(event, result.event, 'the real lifecycle store must persist the multi-root closure event');
  assert.equal(event.event_id, `${PLAN_ID}:plan-closed:r3`);
  assert.deepEqual(event.artifact_refs, refs);
  return event;
}

function assertClosureSymlinkIsTerminal(t, targetKind) {
  const fixture = createFixture(t);
  const committedEvent = commitPlanClosedEvent(fixture);
  const committedRef = committedEvent.artifact_refs.find((ref) => ref.root === 'plan');
  const artifactPath = path.join(fixture.planDir, committedRef.path);
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);
  const closeoutPath = path.join(fixture.planDir, 'closeout.md');

  fs.unlinkSync(artifactPath);
  if (targetKind === 'sibling') {
    const siblingTarget = path.join(fixture.root, 'docs', 'pocket', 'plans', 'sibling-plan', 'phase-1.md');
    writeFile(siblingTarget, fixture.phaseEvidence);
    fs.symlinkSync(siblingTarget, artifactPath, 'file');
  } else if (targetKind === 'outside') {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-outside-artifact-'));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const outsideTarget = path.join(outsideRoot, 'phase-1.md');
    fs.writeFileSync(outsideTarget, fixture.phaseEvidence);
    fs.symlinkSync(outsideTarget, artifactPath, 'file');
  } else if (targetKind === 'dangling') {
    fs.symlinkSync('missing-phase-target.md', artifactPath, 'file');
  } else {
    assert.equal(targetKind, 'eloop');
    fs.symlinkSync(path.basename(artifactPath), artifactPath, 'file');
  }

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), `public drain of plan-closed with ${targetKind} artifact symlink`);
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
    journalStatus: journalEvent && journalEvent.delivery.status,
    journalCode: journalEvent && journalEvent.delivery.error && journalEvent.delivery.error.code,
    journalRetryable: journalEvent && journalEvent.delivery.error && journalEvent.delivery.error.retryable,
    remoteUnchanged: isDeepStrictEqual(readRemote(fixture), remoteBefore),
    metadataUnchanged: isDeepStrictEqual(metadataAfter, metadataBefore),
    watermark: metadataAfter.lifecycle_delivery.last_applied_revision,
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
    journalStatus: 'terminal',
    journalCode: 'STALE_ARTIFACT',
    journalRetryable: false,
    remoteUnchanged: true,
    metadataUnchanged: true,
    watermark: 2,
    closureProofWritten: false,
    closeoutExists: false,
  }, `${targetKind} closure symlink must be rejected before remote or local closure effects`);
}


module.exports = {
  assertClosureArtifactStateIsTerminal,
  commitPlanClosedEvent,
  prepareClosureReadyPlan,
  commitPlanClosedEventWithNoncanonicalPlanDirectory,
  commitPlanClosedEventWithBothRoots,
  assertClosureSymlinkIsTerminal,
  deliverySummary,
  readMetadata,
};
