'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID, PR_NUMBER } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { installEnterpriseAdapter } = require('./support/enterprise');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');
const { sha256, writeFile } = require('./support/files');
const {
  installLifecycleWatermarkWriteFaultGate,
  installLifecycleHandlerCallTraceGate,
  installLifecycleIssueHandlerCallTraceGate,
  installRegisteredEnterpriseReadFaultGate,
} = require('./support/failure-gates');
const { validateEvent } = require('../../cli/lib/lifecycle-contract');
const { responseDeliveryPatch } = require('../../cli/lib/lifecycle-retry');
const scenarioHelpers = require('./lifecycle-gap.helpers');

test('the registered Enterprise adapter defers an out-of-order revision until its predecessor is applied', (t) => {
  const scenario = prepareGapScenario(createFixture(t));
  assertGapHasNoMutation(scenario);
  const failedAttempt = failWatermarkWriteAfterProof(scenario);
  const recovered = replayCanonicalProofBeforeMutation(scenario, failedAttempt);
  completeNextRevision(scenario, recovered);
});

test('proof-first recovery rejects a changed second artifact before advancing the watermark', (t) => {
  const scenario = prepareGapScenario(createFixture(t));
  assertGapHasNoMutation(scenario);
  const failedAttempt = failWatermarkWriteAfterProof(scenario);
  rejectChangedSecondArtifactDuringReplay(scenario, failedAttempt);
});

test('spec-approved proof-first recovery works before planning with two intact spec refs', (t) => {
  const scenario = preparePrePlanningSpecApprovedProofFirstScenario(t);
  const replay = scenarioHelpers.deliverRegisteredEvent(scenario.fixture, scenario.reconcilingEvent, {
    handlerTrace: scenario.handlerTrace,
  });

  scenarioHelpers.assertSuccessfulProof(replay, scenario.event);
  assert.equal(replay.event_id, scenario.event.event_id);
  assert.equal(replay.proof_ref, scenario.reconcilingEvent.delivery.proof_ref);
  assert.equal(replay.proof_hash, scenario.reconcilingEvent.delivery.proof_hash);
  const persisted = scenarioHelpers.persistRegisteredAdapterResponse(
    scenario.fixture, scenario.reconcilingEvent, replay,
  );
  assert.equal(persisted.ok, true, 'Core must persist the registered adapter replay result');
  assert.equal(persisted.event.delivery.status, 'succeeded');
  assert.deepEqual(scenarioHelpers.readWatermark(scenario.fixture), {
    schema: 1, plan_id: PLAN_ID, last_applied_revision: 1,
  }, 'intact pre-planning spec refs must allow proof-first watermark recovery');
  assert.deepEqual(scenarioHelpers.readMetadata(scenario.fixture).github_issue.ownership,
    scenario.proof, 'proof-first replay must leave the canonical issue proof unchanged');
  assert.deepEqual(readRemote(scenario.fixture), scenario.remoteAfterProof,
    'proof-first replay must make no additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(scenario.handlerTrace), [{
    event_id: scenario.event.event_id, revision: 1, status: 'claimed',
  }], 'proof-first replay must not rerun the real spec-approved handler');
});

test('spec-approved proof-first recovery retries ref EIO, then rejects stale ref 2', (t) => {
  const scenario = preparePrePlanningSpecApprovedProofFirstScenario(t);
  const secondRef = scenario.event.artifact_refs[1];
  const secondArtifactPath = path.join(scenario.fixture.specDir, secondRef.path);
  const committedBytes = fs.readFileSync(secondArtifactPath);
  fs.writeFileSync(secondArtifactPath, Buffer.concat([committedBytes, Buffer.from('changed after proof persistence\n')]));
  assert.notDeepEqual(fs.readFileSync(secondArtifactPath), committedBytes,
    'only the second committed spec ref must be stale before replay');

  const readFaultGate = installRegisteredEnterpriseReadFaultGate(scenario.fixture);
  const transient = scenarioHelpers.deliverRegisteredEvent(scenario.fixture, scenario.reconcilingEvent, {
    handlerTrace: scenario.handlerTrace,
    readFaultGate,
    readArtifactPath: secondArtifactPath,
  });
  assert.equal(transient.event_id, scenario.event.event_id);
  assert.equal(transient.status, 'retryable');
  assert.deepEqual(transient.error && { code: transient.error.code, retryable: transient.error.retryable }, {
    code: 'ARTIFACT_READ_FAILED', retryable: true,
  }, 'an injected EIO while reading ref 2 must remain retryable before its stale digest is known');
  assert.equal(fs.existsSync(readFaultGate.hitPath), true,
    'proof-first recovery must attempt to read ref 2 through the registered adapter');
  const injected = JSON.parse(fs.readFileSync(readFaultGate.hitPath, 'utf8'));
  assert.equal(injected.code, 'EIO');
  assert.equal(injected.target, fs.realpathSync(secondArtifactPath));
  assert.deepEqual(scenarioHelpers.readMetadataBytes(scenario.fixture), scenario.metadataAfterProofBytes,
    'a transient ref-read failure must not mutate the proof or watermark');
  assert.deepEqual(readRemote(scenario.fixture), scenario.remoteAfterProof,
    'a transient ref-read failure must make no additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(scenario.handlerTrace), [{
    event_id: scenario.event.event_id, revision: 1, status: 'claimed',
  }], 'a transient proof-first retry must not rerun the real spec-approved handler');

  const stale = scenarioHelpers.deliverRegisteredEvent(scenario.fixture, scenario.reconcilingEvent, {
    handlerTrace: scenario.handlerTrace,
  });
  assert.equal(stale.event_id, scenario.event.event_id);
  assert.equal(stale.status, 'terminal');
  assert.deepEqual(stale.error && { code: stale.error.code, retryable: stale.error.retryable }, {
    code: 'STALE_ARTIFACT', retryable: false,
  });
  const persisted = scenarioHelpers.persistRegisteredAdapterResponse(
    scenario.fixture, scenario.reconcilingEvent, stale,
  );
  assert.equal(persisted.ok, true, 'Core must persist the terminal stale replay result');
  assert.equal(persisted.event.event_id, scenario.event.event_id);
  assert.equal(persisted.event.delivery.status, 'terminal');
  assert.equal(persisted.event.delivery.error.code, 'STALE_ARTIFACT');
  assert.deepEqual(scenarioHelpers.readMetadataBytes(scenario.fixture), scenario.metadataAfterProofBytes,
    'stale ref 2 must leave the proof and watermark byte-identical');
  assert.equal(scenarioHelpers.readMetadata(scenario.fixture).lifecycle_delivery, undefined,
    'stale proof-first replay must not create or advance a lifecycle watermark');
  assert.deepEqual(scenarioHelpers.readMetadata(scenario.fixture).github_issue.ownership,
    scenario.proof, 'stale proof-first replay must not mutate canonical proof');
  assert.deepEqual(readRemote(scenario.fixture), scenario.remoteAfterProof,
    'stale proof-first replay must make no additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(scenario.handlerTrace), [{
    event_id: scenario.event.event_id, revision: 1, status: 'claimed',
  }], 'stale proof-first replay must not rerun the real spec-approved handler');
});

function preparePrePlanningSpecApprovedProofFirstScenario(t) {
  const fixture = createFixture(t);
  installEnterpriseAdapter(fixture);
  const event = commitPrePlanningSpecApprovedWithTwoRefs(fixture);
  const lifecycle = readLifecycle(fixture);
  assert.equal(lifecycle.plan.plan_dir, null, 'spec-approved must use its normative pre-planning state');
  assert.equal(lifecycle.plan.branch, null, 'spec-approved must not require a captured branch');
  assert.equal(event.event_id, `${PLAN_ID}:spec-approved:r1`);
  assert.deepEqual(event.artifact_refs.map(({ root }) => root), ['spec', 'spec']);

  const handlerTrace = installLifecycleIssueHandlerCallTraceGate(fixture);
  const watermarkFault = installLifecycleWatermarkWriteFaultGate(fixture);
  const remoteBeforeProof = readRemote(fixture);
  const firstDrain = scenarioHelpers.runCoreDeliveryWithWatermarkFailure(
    fixture, event, watermarkFault, handlerTrace,
  );
  assert.deepEqual(firstDrain.deliveries.map(({ event_id, status, error }) => ({
    event_id, status, code: error && error.code, retryable: error && error.retryable,
  })), [{
    event_id: event.event_id,
    status: 'reconciling',
    code: 'LIFECYCLE_WATERMARK_WRITE_FAILED',
    retryable: true,
  }], 'the real Core drain must persist the failed watermark result as reconciling');
  assert.equal(fs.readFileSync(watermarkFault.hitPath, 'utf8'), 'revision-1');

  const reconcilingEvent = readLifecycle(fixture).events.find(({ event_id }) => event_id === event.event_id);
  assert.equal(reconcilingEvent.delivery.status, 'reconciling');
  assert.equal(reconcilingEvent.delivery.attempts, 1);
  assert.deepEqual(reconcilingEvent.artifact_refs, event.artifact_refs,
    'Core must preserve the original event ID and committed ref identity');
  assert.equal(reconcilingEvent.delivery.proof_ref, 'meta:github_issue');
  assert.match(reconcilingEvent.delivery.proof_hash, /^[0-9a-f]{64}$/);

  const metadataAfterProof = scenarioHelpers.readMetadata(fixture);
  const proof = metadataAfterProof.github_issue.ownership;
  assert.equal(proof.event_id, event.event_id);
  assert.equal(proof.plan_id, PLAN_ID);
  assert.equal(proof.proof_hash, reconcilingEvent.delivery.proof_hash);
  assert.equal(proof.spec_path, `docs/pocket/spec/${PLAN_ID}/approved-spec.md`);
  assert.equal(proof.proof_hash, sha256(JSON.stringify({
    event_id: event.event_id,
    plan_id: PLAN_ID,
    repository: proof.repository,
    issue_number: metadataAfterProof.github_issue.number,
    issue_url: metadataAfterProof.github_issue.url,
    spec_path: proof.spec_path,
    identity: proof.identity,
  })), 'the real issue handler must persist a canonical event-bound proof');
  assert.equal(metadataAfterProof.lifecycle_delivery, undefined,
    'the injected failure must leave the watermark absent before proof-first replay');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [{
    event_id: event.event_id, revision: 1, status: 'claimed',
  }], 'the first delivery must run the real spec-approved handler once');
  const remoteAfterProof = readRemote(fixture);
  assert.ok(remoteAfterProof.calls.length > remoteBeforeProof.calls.length,
    'the first delivery must reach the fake GitHub transport');
  assert.ok(remoteAfterProof.effects.length > remoteBeforeProof.effects.length,
    'the first delivery must persist a fake GitHub effect before watermark failure');

  return {
    fixture,
    event,
    handlerTrace,
    reconcilingEvent,
    proof,
    metadataAfterProofBytes: scenarioHelpers.readMetadataBytes(fixture),
    remoteAfterProof,
  };
}

function commitPrePlanningSpecApprovedWithTwoRefs(fixture) {
  const secondPath = 'supporting-spec.md';
  const secondContents = '# Supporting approved evidence\n';
  writeFile(path.join(fixture.specDir, secondPath), secondContents);
  const refs = [
    { root: 'spec', kind: 'approved-spec', path: 'approved-spec.md', sha256: sha256(fixture.approvedSpec), revision: 1 },
    { root: 'spec', kind: 'approved-spec', path: secondPath, sha256: sha256(secondContents), revision: 1 },
  ];
  const transition = runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    ...refs.flatMap((ref) => ['--artifact', `${ref.root}:${ref.kind}:${ref.path}:${ref.sha256}`]),
    '--json', '--contract', '3',
  ]);
  const committed = assertCliOk(transition, 'public pre-planning multi-ref spec-approved transition');
  const event = readLifecycle(fixture).events.find(({ event_id }) => event_id === committed.event_id);
  assert.ok(event, 'the real Core store must persist the spec-approved event before delivery');
  assert.deepEqual(event.artifact_refs, refs);
  return event;
}

function prepareGapScenario(fixture) {
  initializePlan(fixture);
  scenarioHelpers.preparePhaseFixtures(fixture);
  scenarioHelpers.seedPhasePullRequests(fixture);

  const approval = transitionApprovedSpec(fixture);
  assert.equal(approval.event_id, `${PLAN_ID}:spec-approved:r1`);
  assert.equal(scenarioHelpers.appendPhaseEvent(fixture, 1).event_id, `${PLAN_ID}:phase-complete:r2`);
  assert.equal(scenarioHelpers.appendPhaseEvent(fixture, 2).event_id, `${PLAN_ID}:phase-complete:r3`);
  const initialDrain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  assert.deepEqual(assertCliOk(initialDrain, 'registered Enterprise delivery through Core drain').deliveries.map(({ revision, status }) => ({ revision, status })), [
    { revision: 1, status: 'succeeded' },
    { revision: 2, status: 'succeeded' },
    { revision: 3, status: 'succeeded' },
  ]);
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'the real registered adapter must persist the contiguous watermark after r1-r3 proofs');

  assert.equal(scenarioHelpers.appendPhaseEvent(fixture, 3, [{ root: 'spec', path: 'approved-spec.md' }]).event_id,
    `${PLAN_ID}:phase-complete:r4`);
  assert.equal(scenarioHelpers.appendPhaseEvent(fixture, 4).event_id, `${PLAN_ID}:phase-complete:r5`);
  const lifecyclePath = path.join(fixture.specDir, 'lifecycle.json');
  const journalBeforeDelivery = fs.readFileSync(lifecyclePath);
  scenarioHelpers.assertValidOrderedJournal(fixture);
  const lifecycle = readLifecycle(fixture);
  const event4 = lifecycle.events.find((event) => event.revision === 4);
  const event5 = lifecycle.events.find((event) => event.revision === 5);
  assert.equal(event4.event_id, `${PLAN_ID}:phase-complete:r4`);
  assert.equal(event5.event_id, `${PLAN_ID}:phase-complete:r5`);
  assert.match(event4.payload_hash, /^[0-9a-f]{64}$/);
  assert.match(event5.payload_hash, /^[0-9a-f]{64}$/);
  return {
    fixture,
    event4,
    event5,
    lifecyclePath,
    journalBeforeDelivery,
    handlerTrace: installLifecycleHandlerCallTraceGate(fixture),
    metadataBeforeGap: scenarioHelpers.readMetadataBytes(fixture),
    remoteBeforeGap: readRemote(fixture),
  };
}

function assertGapHasNoMutation(scenario) {
  const { fixture, event5, handlerTrace, lifecyclePath, journalBeforeDelivery, metadataBeforeGap, remoteBeforeGap } = scenario;
  const blocked = scenarioHelpers.deliverRegisteredEvent(fixture, event5, { handlerTrace });
  assert.equal(blocked.event_id, event5.event_id);
  assert.equal(blocked.status, 'retryable');
  assert.deepEqual(blocked.error && { code: blocked.error.code, retryable: blocked.error.retryable },
    { code: 'REVISION_GAP', retryable: true });
  assert.match(blocked.error.message, new RegExp(PLAN_ID));
  assert.match(blocked.error.message, /revision\s+5/i, 'diagnostic must identify blocked revision 5');
  assert.match(blocked.error.message, /(?:predecessor|revision)\s+4/i, 'diagnostic must identify missing predecessor 4');
  assert.deepEqual(Object.keys(blocked).sort(), ['error', 'event_id', 'status'],
    'the gap response must stay within the existing adapter response contract');
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'a gap must leave the Enterprise watermark at revision 3');
  assert.deepEqual(scenarioHelpers.readMetadataBytes(fixture), metadataBeforeGap,
    'a gap must invoke no handler and must not write proof or metadata');
  assert.deepEqual(readRemote(fixture), remoteBeforeGap,
    'a gap must perform zero fake GitHub operations or mutations');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [], 'a gap must invoke no Enterprise phase handler');
  assert.deepEqual(fs.readFileSync(lifecyclePath), journalBeforeDelivery,
    'reordered adapter delivery must not mutate Core’s authoritative append-ordered journal');
}

function failWatermarkWriteAfterProof(scenario) {
  const { fixture, event4, handlerTrace, remoteBeforeGap } = scenario;
  const watermarkFault = installLifecycleWatermarkWriteFaultGate(fixture);
  const claimedEvent4 = {
    ...event4,
    delivery: { ...event4.delivery, status: 'claimed', attempts: event4.delivery.attempts + 1 },
  };
  const reconciling4 = scenarioHelpers.deliverRegisteredEvent(fixture, claimedEvent4, {
    faultGate: watermarkFault,
    failWatermarkRevision: 4,
    handlerTrace,
  });
  assert.equal(reconciling4.status, 'reconciling');
  assert.deepEqual(reconciling4.error && { code: reconciling4.error.code, retryable: reconciling4.error.retryable },
    { code: 'LIFECYCLE_WATERMARK_WRITE_FAILED', retryable: true });
  assert.equal(fs.readFileSync(watermarkFault.hitPath, 'utf8'), 'revision-4');
  let metadataAfterWatermarkFailure;
  try {
    metadataAfterWatermarkFailure = scenarioHelpers.readMetadata(fixture);
  } catch (error) {
    assert.fail(`a failed watermark write must preserve parseable metadata and the existing proof: ${error.message}`);
  }
  assert.deepEqual(metadataAfterWatermarkFailure.lifecycle_delivery,
    { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'a failed watermark write must preserve the previous contiguous revision');
  scenarioHelpers.assertCanonicalPersistedProof(fixture, event4, reconciling4);
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'the contiguous watermark must stay at 3 after proof persistence but before recovery');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id,
    revision: 4,
    status: 'claimed',
  }], 'the initial r4 attempt must invoke its handler exactly once');
  const metadataAfterProof = scenarioHelpers.readMetadata(fixture);
  const metadataAfterProofBytes = scenarioHelpers.readMetadataBytes(fixture);
  const remoteAfterProof = readRemote(fixture);
  assert.deepEqual(remoteAfterProof.effects.slice(remoteBeforeGap.effects.length), [{
    kind: 'phase-summary-create', number: PR_NUMBER + 2, marker: '<!-- pocket-phase-3-summary -->',
  }], 'the event proof and remote effect must be durable before the injected watermark write failure');
  return { claimedEvent4, reconciling4, metadataAfterProof, metadataAfterProofBytes, remoteAfterProof };
}

function rejectChangedSecondArtifactDuringReplay(scenario, failedAttempt) {
  const { fixture, event4, handlerTrace } = scenario;
  const { claimedEvent4, reconciling4, metadataAfterProof, metadataAfterProofBytes, remoteAfterProof } = failedAttempt;
  const reconcilingEvent4 = buildReconcilingReplayEvent(event4, claimedEvent4, reconciling4);
  assert.equal(reconcilingEvent4.artifact_refs.length, 2,
    'the proof-first regression must exercise a second committed artifact ref');
  const secondRef = reconcilingEvent4.artifact_refs[1];
  assert.equal(secondRef.root, 'spec', 'the recovery regression must cover the selected spec-root artifact');
  const secondArtifactPath = path.join(fixture.specDir, secondRef.path);
  const secondArtifactBytes = fs.readFileSync(secondArtifactPath);
  fs.writeFileSync(secondArtifactPath, Buffer.concat([secondArtifactBytes, Buffer.from('\nchanged after proof persistence\n')]));
  assert.notDeepEqual(fs.readFileSync(secondArtifactPath), secondArtifactBytes,
    'the second committed artifact must be changed after canonical proof persistence');

  const stale = scenarioHelpers.deliverRegisteredEvent(fixture, reconcilingEvent4, { handlerTrace });
  assert.equal(stale.event_id, event4.event_id, 'recovery must preserve the original event identity');
  assert.equal(stale.status, 'terminal');
  assert.deepEqual(stale.error && { code: stale.error.code, retryable: stale.error.retryable },
    { code: 'STALE_ARTIFACT', retryable: false });
  assert.deepEqual(scenarioHelpers.readWatermark(fixture),
    { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'a stale second ref must not advance the contiguous watermark');
  assert.deepEqual(scenarioHelpers.readMetadataBytes(fixture), metadataAfterProofBytes,
    'stale replay must leave proof and watermark metadata byte-identical');
  assert.deepEqual(scenarioHelpers.readMetadata(fixture).phases['phase-3'].review.proof,
    metadataAfterProof.phases['phase-3'].review.proof,
    'stale replay must not mutate the canonical proof contents');
  assert.deepEqual(readRemote(fixture), remoteAfterProof,
    'stale proof-first recovery must perform zero additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id, revision: 4, status: 'claimed',
  }], 'stale proof-first recovery must not rerun the phase handler');
}

function buildReconcilingReplayEvent(event4, claimedEvent4, reconciling4) {
  const reconcilingEvent4 = {
    ...claimedEvent4,
    delivery: {
      ...claimedEvent4.delivery,
      ...responseDeliveryPatch(reconciling4, claimedEvent4.delivery.attempts, Date.parse(FIXED_NOW)),
    },
  };
  assert.equal(reconcilingEvent4.delivery.status, 'reconciling',
    'replay must use the actual reconciling delivery state returned after the failed watermark write');
  assert.equal(reconcilingEvent4.event_id, event4.event_id);
  assert.equal(reconcilingEvent4.revision, event4.revision);
  assert.equal(reconcilingEvent4.payload_hash, event4.payload_hash,
    'reconciling delivery must retain the exact canonical payload hash');
  assert.equal(reconcilingEvent4.delivery.proof_ref, reconciling4.proof_ref,
    'the replay event must retain the proof reference returned by the failed attempt');
  assert.equal(reconcilingEvent4.delivery.proof_hash, reconciling4.proof_hash,
    'the replay event must retain the proof hash returned by the failed attempt');
  assert.deepEqual(reconcilingEvent4.artifact_refs, event4.artifact_refs);
  assert.deepEqual(validateEvent(reconcilingEvent4), { ok: true, code: null, message: null });
  return reconcilingEvent4;
}

function replayCanonicalProofBeforeMutation(scenario, failedAttempt) {
  const { fixture, event4, event5, handlerTrace, lifecyclePath, journalBeforeDelivery } = scenario;
  const {
    claimedEvent4, reconciling4, metadataAfterProof, metadataAfterProofBytes, remoteAfterProof,
  } = failedAttempt;
  const reconcilingEvent4 = buildReconcilingReplayEvent(event4, claimedEvent4, reconciling4);
  const secondRef = event4.artifact_refs[1];
  const secondRoot = secondRef.root === 'spec' ? fixture.specDir : fixture.planDir;
  const secondArtifactPath = path.join(secondRoot, secondRef.path);
  const secondArtifactBytes = fs.readFileSync(secondArtifactPath);
  const safeTargetPath = `${secondArtifactPath}.matching-content`;
  fs.writeFileSync(safeTargetPath, secondArtifactBytes);
  fs.unlinkSync(secondArtifactPath);
  fs.symlinkSync(path.basename(safeTargetPath), secondArtifactPath);
  assert.equal(fs.lstatSync(secondArtifactPath).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(secondArtifactPath), secondArtifactBytes,
    'a safe in-root symlink must still resolve to the exact committed bytes');

  const readFaultGate = installRegisteredEnterpriseReadFaultGate(fixture);
  const transient = scenarioHelpers.deliverRegisteredEvent(fixture, reconcilingEvent4, {
    handlerTrace,
    readFaultGate,
    readArtifactPath: secondArtifactPath,
  });
  assert.equal(transient.event_id, event4.event_id);
  assert.equal(transient.status, 'retryable');
  assert.deepEqual(transient.error && { code: transient.error.code, retryable: transient.error.retryable },
    { code: 'ARTIFACT_READ_FAILED', retryable: true });
  assert.equal(fs.existsSync(readFaultGate.hitPath), true,
    'proof-first recovery must read the committed artifact through the registered Enterprise process');
  const injected = JSON.parse(fs.readFileSync(readFaultGate.hitPath, 'utf8'));
  assert.equal(injected.code, 'EIO');
  assert.equal(injected.target, fs.realpathSync(secondArtifactPath));
  assert.deepEqual(scenarioHelpers.readWatermark(fixture),
    { schema: 1, plan_id: PLAN_ID, last_applied_revision: 3 },
    'transient artifact I/O must not advance the watermark');
  assert.deepEqual(scenarioHelpers.readMetadataBytes(fixture), metadataAfterProofBytes,
    'transient artifact I/O must not mutate proof or metadata');
  assert.deepEqual(readRemote(fixture), remoteAfterProof,
    'transient artifact I/O must perform zero additional fake GitHub calls or effects');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id, revision: 4, status: 'claimed',
  }], 'transient proof-first recovery must not rerun the phase handler');

  const applied4 = scenarioHelpers.deliverRegisteredEvent(fixture, reconcilingEvent4, { handlerTrace });
  scenarioHelpers.assertSuccessfulProof(applied4, event4);
  assert.equal(applied4.event_id, reconciling4.event_id);
  assert.equal(applied4.proof_ref, reconciling4.proof_ref,
    'proof-first replay must return the exact persisted proof reference');
  assert.equal(applied4.proof_hash, reconciling4.proof_hash,
    'proof-first replay must return the exact persisted proof hash');
  const remoteAfterReplay = readRemote(fixture);
  assert.deepEqual(remoteAfterReplay.calls, remoteAfterProof.calls,
    'proof-first replay must not make another fake GitHub transport call');
  assert.deepEqual(remoteAfterReplay.effects, remoteAfterProof.effects,
    'proof-first replay must not repeat any remote effect');
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id, revision: 4, status: 'claimed',
  }], 'proof-first replay must not invoke the phase handler a second time');
  assert.deepEqual(scenarioHelpers.withoutLifecycleWatermark(scenarioHelpers.readMetadata(fixture)),
    scenarioHelpers.withoutLifecycleWatermark(metadataAfterProof),
    'proof-first recovery may only mutate the watermark, not handler-owned proof metadata');
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 4 },
    'replaying the missing predecessor must repair and advance the watermark exactly once');
  return {
    applied4,
    event4,
    event5,
    fixture,
    handlerTrace,
    lifecyclePath,
    journalBeforeDelivery,
    remoteAfterReplay,
  };
}

function completeNextRevision(scenario, recovered) {
  const { applied4, event4, event5, fixture, handlerTrace, lifecyclePath, journalBeforeDelivery, remoteAfterReplay } = recovered;
  const applied5 = scenarioHelpers.deliverRegisteredEvent(fixture, event5, { handlerTrace });
  scenarioHelpers.assertSuccessfulProof(applied5, event5);
  assert.deepEqual(scenarioHelpers.readHandlerCalls(handlerTrace).map(({ event_id, revision }) => ({ event_id, revision })), [
    { event_id: applied4.event_id, revision: 4 },
    { event_id: event5.event_id, revision: 5 },
  ], 'r5 must invoke its handler once after proof-first recovery applies r4');
  assert.deepEqual(scenarioHelpers.readWatermark(fixture), { schema: 1, plan_id: PLAN_ID, last_applied_revision: 5 },
    'retrying revision 5 after revision 4 must advance the contiguous watermark');
  const remoteAfterRevision5 = readRemote(fixture);
  assert.ok(remoteAfterRevision5.calls.length > remoteAfterReplay.calls.length,
    'applying r5 must invoke its remote reconciliation path after the no-call proof-first replay');
  scenarioHelpers.assertCanonicalPhaseProof(fixture, 3, event4, applied4);
  scenarioHelpers.assertCanonicalPhaseProof(fixture, 4, event5, applied5);
  scenarioHelpers.assertOrderedRemoteEffects(fixture, scenario.remoteBeforeGap, [3, 4]);
  assert.deepEqual(fs.readFileSync(lifecyclePath), journalBeforeDelivery,
    'direct adapter delivery must leave Core’s authoritative journal byte-identical');
}
