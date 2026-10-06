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

test('plan-closed accepts an in-root symlink to identical committed evidence', (t) => {
  const fixture = createFixture(t);
  const committedEvent = commitPlanClosedEvent(fixture);
  const committedRef = committedEvent.artifact_refs.find((ref) => ref.root === 'plan');
  const artifactPath = path.join(fixture.planDir, committedRef.path);
  const targetPath = path.join(path.dirname(artifactPath), 'phase-1-internal-target.md');
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);

  fs.renameSync(artifactPath, targetPath);
  fs.symlinkSync(path.basename(targetPath), artifactPath, 'file');
  assert.equal(path.dirname(fs.realpathSync(artifactPath)), fs.realpathSync(path.dirname(artifactPath)),
    'the symlink target must remain physically contained in the selected plan root');
  assert.equal(fs.statSync(artifactPath).isFile(), true);
  assert.equal(sha256(fs.readFileSync(artifactPath)), committedRef.sha256,
    'the resolved regular file must retain the committed bytes');

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'public drain of closure evidence through a safe in-root symlink');
  assert.deepEqual(deliverySummary(drain, committedEvent.event_id), {
    event_id: committedEvent.event_id,
    revision: 3,
    status: 'succeeded',
  });
  const metadata = readMetadata(fixture);
  const proof = metadata.github_issue.tasklist;
  assert.equal(proof.event_id, committedEvent.event_id);
  assert.equal(proof.plan_id, PLAN_ID);
  assert.equal(proof.revision, committedEvent.revision);
  assert.equal(proof.marker, '<!-- pocket-tasklist -->');
  assert.equal(proof.artifact_refs[0].path, committedRef.path,
    'canonical proof must bind the original committed ref, not the symlink target path');
  assert.equal(readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id)
    .delivery.proof_ref, 'meta:github_issue|marker:issue-tasklist');
  assert.equal(metadata.lifecycle_delivery.last_applied_revision, 3);
  assert.deepEqual(readRemote(fixture).effects.slice(remoteBefore.effects.length).map(({ kind }) => kind), ['tasklist-create']);
  assert.equal(readRemote(fixture).comments['73'].filter(({ body }) => body.startsWith('<!-- pocket-tasklist -->')).length, 1);
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true);
  assert.equal(metadataBefore.github_issue.tasklist, undefined);
});

test('plan-closed keeps escaping, dangling, and ELOOP artifact symlinks terminal', async (t) => {
  for (const targetKind of ['sibling', 'outside', 'dangling', 'eloop']) {
    await t.test(`${targetKind} target`, (subtest) => assertClosureSymlinkIsTerminal(subtest, targetKind));
  }
});

test('plan-closed retries EIO during committed artifact validation and recovers', (t) => {
  const fixture = createFixture(t);
  const committedEvent = commitPlanClosedEvent(fixture);
  const artifactPath = path.join(fixture.planDir, PHASE_PATH);
  const faultGate = installRegisteredEnterpriseReadFaultGate(fixture);
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);
  const failedAttempt = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    ...fixture.env,
    NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' '),
    LIFECYCLE_ENTERPRISE_READ_FAILURE_PATH: artifactPath,
    LIFECYCLE_ENTERPRISE_DISPATCH_PATH: faultGate.dispatchPath,
    LIFECYCLE_ENTERPRISE_READ_FAILURE_HIT_FILE: faultGate.hitPath,
  });
  const failure = assertCliOk(failedAttempt, 'public drain after registered closure artifact read EIO');
  assert.equal(fs.existsSync(faultGate.hitPath), true,
    `registered closure artifact read must inject EIO: ${failedAttempt.stdout}${failedAttempt.stderr}`);
  const injected = JSON.parse(fs.readFileSync(faultGate.hitPath, 'utf8'));
  assert.deepEqual(injected, {
    code: 'EIO',
    executable: path.resolve(__dirname, '../../enterprise/dispatch.js'),
    target: fs.realpathSync(artifactPath),
  });
  assert.deepEqual(failure.deliveries.map(({ event_id, status, error }) => ({
    event_id, status, code: error && error.code, retryable: error && error.retryable,
  })), [{
    event_id: committedEvent.event_id,
    status: 'retryable',
    code: 'CLOSEOUT_ARTIFACT_UNAVAILABLE',
    retryable: true,
  }]);
  const failedEvent = readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id);
  assert.equal(failedEvent.event_id, committedEvent.event_id);
  assert.equal(failedEvent.delivery.attempts, 1);
  assert.deepEqual(readRemote(fixture), remoteBefore,
    'artifact EIO must remain retryable before GitHub calls or effects');
  assert.deepEqual(readMetadata(fixture), metadataBefore,
    'artifact EIO must not write closure proof or advance the watermark');
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), false);

  const retry = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    ...fixture.env,
    POCKETTO_LIFECYCLE_NOW: new Date(Date.parse(FIXED_NOW) + 1001).toISOString(),
  }), 'public retry after closure artifact EIO recovery');
  assert.deepEqual(deliverySummary(retry, committedEvent.event_id), {
    event_id: committedEvent.event_id,
    revision: committedEvent.revision,
    status: 'succeeded',
  });
  const recovered = readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id);
  assert.equal(recovered.delivery.attempts, 2);
  assert.equal(readMetadata(fixture).github_issue.tasklist.event_id, committedEvent.event_id);
  assert.equal(readMetadata(fixture).lifecycle_delivery.last_applied_revision, 3);
  assert.deepEqual(readRemote(fixture).effects.slice(remoteBefore.effects.length).map(({ kind }) => kind), ['tasklist-create']);
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true);
});

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

function commitPhaseComplete(fixture, refs) {
  const result = commitTransition({
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: PLAN_ID,
    type: 'phase-complete',
    artifacts: refs,
    branch: `feature/${PLAN_ID}`,
    deps: { now: () => FIXED_NOW },
  });
  assert.equal(result.ok, true, `real Core commitTransition must accept valid multi-ref phase evidence: ${JSON.stringify(result)}`);
  const committed = readLifecycle(fixture).events.find(({ event_id }) => event_id === result.event.event_id);
  assert.deepEqual(committed, result.event, 'the real lifecycle store must persist the committed event');
  return committed;
}

function artifactFlag(ref) {
  return `${ref.root}:${ref.kind}:${ref.path}:${ref.sha256}`;
}

function deliverySummary(result, eventId) {
  const delivery = result.deliveries.find(({ event_id }) => event_id === eventId);
  return delivery && { event_id: delivery.event_id, revision: delivery.revision, status: delivery.status };
}

function assertTerminalStaleDelivery(fixture, result, committedEvent) {
  const delivery = result.deliveries.find(({ event_id }) => event_id === committedEvent.event_id);
  assert.ok(delivery, `public drain must preserve event ID ${committedEvent.event_id}`);
  assert.deepEqual({
    event_id: delivery.event_id,
    revision: delivery.revision,
    status: delivery.status,
    code: delivery.error && delivery.error.code,
    retryable: delivery.error && delivery.error.retryable,
  }, {
    event_id: committedEvent.event_id,
    revision: committedEvent.revision,
    status: 'terminal',
    code: 'STALE_ARTIFACT',
    retryable: false,
  }, 'a changed second ref must produce terminal STALE_ARTIFACT at registered Enterprise delivery');
  const persistedEvent = readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id);
  assert.ok(persistedEvent, `Core journal must retain event ID ${committedEvent.event_id}`);
  assert.equal(persistedEvent.event_id, committedEvent.event_id);
  assert.deepEqual(persistedEvent.artifact_refs, committedEvent.artifact_refs,
    'delivery must not replace or reorder committed refs');
  assert.equal(persistedEvent.delivery.status, 'terminal');
  assert.equal(persistedEvent.delivery.error.code, 'STALE_ARTIFACT');
  assert.equal(persistedEvent.delivery.error.retryable, false);
}

function assertRemoteUnchanged(remoteBefore, fixture, label) {
  const remoteAfter = readRemote(fixture);
  assert.equal(remoteAfter.calls.length - remoteBefore.calls.length, 0, `${label} must make zero fake GitHub calls`);
  assert.equal(remoteAfter.effects.length - remoteBefore.effects.length, 0, `${label} must create zero fake GitHub effects`);
  assert.deepEqual(remoteAfter, remoteBefore, `${label} must leave the fake GitHub state unchanged`);
}

function readMetadata(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
}

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
