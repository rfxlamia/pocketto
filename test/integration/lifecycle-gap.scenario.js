'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID, PHASE_PATH, PR_NUMBER, REPOSITORY_URL } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');
const { runProcess } = require('./support/process');
const { sha256, writeFile } = require('./support/files');
const { commitTransition } = require('../../cli/lib/lifecycle-store');
const { validateEvent } = require('../../cli/lib/lifecycle-contract');
const {
  installLifecycleWatermarkWriteFaultGate,
  installLifecycleHandlerCallTraceGate,
} = require('./support/failure-gates');
const enterpriseMeta = require('../../enterprise/meta');
const { responseDeliveryPatch } = require('../../cli/lib/lifecycle-retry');

test('the registered Enterprise adapter defers an out-of-order revision until its predecessor is applied', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  preparePhaseFixtures(fixture);
  seedPhasePullRequests(fixture);

  const approval = transitionApprovedSpec(fixture);
  assert.equal(approval.event_id, `${PLAN_ID}:spec-approved:r1`);
  assert.equal(appendPhaseEvent(fixture, 1).event_id, `${PLAN_ID}:phase-complete:r2`);
  assert.equal(appendPhaseEvent(fixture, 2).event_id, `${PLAN_ID}:phase-complete:r3`);

  const initialDrain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  assert.deepEqual(assertCliOk(initialDrain, 'registered Enterprise delivery through Core drain').deliveries.map(({ revision, status }) => ({ revision, status })), [
    { revision: 1, status: 'succeeded' },
    { revision: 2, status: 'succeeded' },
    { revision: 3, status: 'succeeded' },
  ]);
  assert.deepEqual(readWatermark(fixture), {
    schema: 1,
    plan_id: PLAN_ID,
    last_applied_revision: 3,
  }, 'the real registered adapter must persist the contiguous watermark after r1-r3 proofs');

  assert.equal(appendPhaseEvent(fixture, 3).event_id, `${PLAN_ID}:phase-complete:r4`);
  assert.equal(appendPhaseEvent(fixture, 4).event_id, `${PLAN_ID}:phase-complete:r5`);
  const lifecyclePath = path.join(fixture.specDir, 'lifecycle.json');
  const journalBeforeDelivery = fs.readFileSync(lifecyclePath);
  assertValidOrderedJournal(fixture);

  const event4 = readLifecycle(fixture).events.find((event) => event.revision === 4);
  const event5 = readLifecycle(fixture).events.find((event) => event.revision === 5);
  assert.equal(event4.event_id, `${PLAN_ID}:phase-complete:r4`);
  assert.equal(event5.event_id, `${PLAN_ID}:phase-complete:r5`);
  assert.match(event4.payload_hash, /^[0-9a-f]{64}$/);
  assert.match(event5.payload_hash, /^[0-9a-f]{64}$/);
  const handlerTrace = installLifecycleHandlerCallTraceGate(fixture);
  const metadataBeforeGap = readMetadataBytes(fixture);
  const remoteBeforeGap = readRemote(fixture);

  const blocked = deliverRegisteredEvent(fixture, event5, { handlerTrace });
  assert.equal(blocked.event_id, event5.event_id);
  assert.equal(blocked.status, 'retryable');
  assert.deepEqual(blocked.error && {
    code: blocked.error.code,
    retryable: blocked.error.retryable,
  }, { code: 'REVISION_GAP', retryable: true });
  assert.match(blocked.error.message, new RegExp(PLAN_ID));
  assert.match(blocked.error.message, /revision\s+5/i, 'diagnostic must identify blocked revision 5');
  assert.match(blocked.error.message, /(?:predecessor|revision)\s+4/i, 'diagnostic must identify missing predecessor 4');
  assert.deepEqual(Object.keys(blocked).sort(), ['error', 'event_id', 'status'],
    'the gap response must stay within the existing adapter response contract');
  assert.deepEqual(readWatermark(fixture), {
    schema: 1,
    plan_id: PLAN_ID,
    last_applied_revision: 3,
  }, 'a gap must leave the Enterprise watermark at revision 3');
  assert.deepEqual(readMetadataBytes(fixture), metadataBeforeGap,
    'a gap must invoke no handler and must not write proof or metadata');
  assert.deepEqual(readRemote(fixture), remoteBeforeGap,
    'a gap must perform zero fake GitHub operations or mutations');
  assert.deepEqual(readHandlerCalls(handlerTrace), [], 'a gap must invoke no Enterprise phase handler');
  assert.deepEqual(fs.readFileSync(lifecyclePath), journalBeforeDelivery,
    'reordered adapter delivery must not mutate Core’s authoritative append-ordered journal');

  const watermarkFault = installLifecycleWatermarkWriteFaultGate(fixture);
  const claimedEvent4 = {
    ...event4,
    delivery: { ...event4.delivery, status: 'claimed', attempts: event4.delivery.attempts + 1 },
  };
  const reconciling4 = deliverRegisteredEvent(fixture, claimedEvent4, {
    faultGate: watermarkFault,
    failWatermarkRevision: 4,
    handlerTrace,
  });
  assert.equal(reconciling4.status, 'reconciling');
  assert.deepEqual(reconciling4.error && {
    code: reconciling4.error.code,
    retryable: reconciling4.error.retryable,
  }, { code: 'LIFECYCLE_WATERMARK_WRITE_FAILED', retryable: true });
  assert.equal(fs.readFileSync(watermarkFault.hitPath, 'utf8'), 'revision-4');
  let metadataAfterWatermarkFailure;
  try {
    metadataAfterWatermarkFailure = readMetadata(fixture);
  } catch (error) {
    assert.fail(`a failed watermark write must preserve parseable metadata and the existing proof: ${error.message}`);
  }
  assert.deepEqual(metadataAfterWatermarkFailure.lifecycle_delivery, {
    schema: 1,
    plan_id: PLAN_ID,
    last_applied_revision: 3,
  }, 'a failed watermark write must preserve the previous contiguous revision');
  assertCanonicalPersistedProof(fixture, event4, reconciling4);
  assert.deepEqual(readWatermark(fixture), {
    schema: 1,
    plan_id: PLAN_ID,
    last_applied_revision: 3,
  }, 'the contiguous watermark must stay at 3 after proof persistence but before recovery');
  assert.deepEqual(readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id,
    revision: 4,
    status: 'claimed',
  }], 'the initial r4 attempt must invoke its handler exactly once');
  const metadataAfterProof = readMetadata(fixture);
  const remoteAfterProof = readRemote(fixture);
  assert.deepEqual(remoteAfterProof.effects.slice(remoteBeforeGap.effects.length), [{
    kind: 'phase-summary-create',
    number: PR_NUMBER + 2,
    marker: '<!-- pocket-phase-3-summary -->',
  }], 'the event proof and remote effect must be durable before the injected watermark write failure');

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

  const applied4 = deliverRegisteredEvent(fixture, reconcilingEvent4, { handlerTrace });
  assertSuccessfulProof(applied4, event4);
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
  assert.deepEqual(readHandlerCalls(handlerTrace), [{
    event_id: event4.event_id,
    revision: 4,
    status: 'claimed',
  }], 'proof-first replay must not invoke the phase handler a second time');
  assert.deepEqual(withoutLifecycleWatermark(readMetadata(fixture)), withoutLifecycleWatermark(metadataAfterProof),
    'proof-first recovery may only mutate the watermark, not handler-owned proof metadata');
  assert.deepEqual(readWatermark(fixture), {
    schema: 1,
    plan_id: PLAN_ID,
    last_applied_revision: 4,
  }, 'replaying the missing predecessor must repair and advance the watermark exactly once');

  const applied5 = deliverRegisteredEvent(fixture, event5, { handlerTrace });
  assertSuccessfulProof(applied5, event5);
  assert.deepEqual(readHandlerCalls(handlerTrace).map(({ event_id, revision }) => ({ event_id, revision })), [
    { event_id: event4.event_id, revision: 4 },
    { event_id: event5.event_id, revision: 5 },
  ], 'r5 must invoke its handler once after proof-first recovery applies r4');
  assert.deepEqual(readWatermark(fixture), {
    schema: 1,
    plan_id: PLAN_ID,
    last_applied_revision: 5,
  }, 'retrying revision 5 after revision 4 must advance the contiguous watermark');
  assert.ok(readRemote(fixture).calls.length > remoteAfterReplay.calls.length,
    'applying r5 must invoke its remote reconciliation path after the no-call proof-first replay');
  assertCanonicalPhaseProof(fixture, 3, event4, applied4);
  assertCanonicalPhaseProof(fixture, 4, event5, applied5);
  assertOrderedRemoteEffects(fixture, remoteBeforeGap, [3, 4]);
  assert.deepEqual(fs.readFileSync(lifecyclePath), journalBeforeDelivery,
    'direct adapter delivery must leave Core’s authoritative journal byte-identical');
});

function preparePhaseFixtures(fixture) {
  const logPath = path.join(fixture.planDir, 'log.json');
  const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const firstPhase = log.phases[0];
  for (const phaseNumber of [2, 3, 4]) {
    const artifactPath = `execution-plan/phase-${phaseNumber}.md`;
    writeFile(path.join(fixture.planDir, artifactPath), `# Phase ${phaseNumber}\n\nLifecycle evidence for phase ${phaseNumber}.\n`);
    log.phases.push({ ...firstPhase, file: artifactPath, tasks: [] });
  }
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
}

function seedPhasePullRequests(fixture) {
  const remote = readRemote(fixture);
  for (const phaseNumber of [2, 3, 4]) {
    const number = PR_NUMBER + phaseNumber - 1;
    const url = `${REPOSITORY_URL}/pull/${number}`;
    remote.pullRequests.push({
      number,
      url,
      state: 'OPEN',
      headRefName: `feature/${PLAN_ID}`,
      baseRefName: 'main',
      headRefOid: `abc123def${String(number).padStart(3, '0')}`,
      title: `Phase ${phaseNumber}: ${PLAN_ID}`,
      body: `Implements ${PLAN_ID}`,
    });
    enterpriseMeta.setPrIdentity(fixture.specDir, `phase-${phaseNumber}`, { number, url });
  }
  fs.writeFileSync(fixture.remotePath, `${JSON.stringify(remote, null, 2)}\n`);
}

function appendPhaseEvent(fixture, phaseNumber) {
  const artifactPath = `execution-plan/phase-${phaseNumber}.md`;
  const contents = fs.readFileSync(path.join(fixture.planDir, artifactPath), 'utf8');
  const result = commitTransition({
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: PLAN_ID,
    type: 'phase-complete',
    artifacts: [{
      root: 'plan',
      kind: 'phase-evidence',
      path: artifactPath,
      sha256: sha256(contents),
      revision: 1,
    }],
    branch: `feature/${PLAN_ID}`,
    deps: { now: () => new Date(Date.parse(FIXED_NOW) + phaseNumber * 1000).toISOString() },
  });
  assert.equal(result.ok, true, `Core must commit valid phase ${phaseNumber} event: ${JSON.stringify(result)}`);
  return result.event;
}

function assertValidOrderedJournal(fixture) {
  const lifecycle = readLifecycle(fixture);
  assert.equal(lifecycle.plan.revision, 5);
  assert.deepEqual(lifecycle.events.map((event) => event.revision), [1, 2, 3, 4, 5],
    'Core’s authoritative journal must contain every revision in append order');
  assert.deepEqual(lifecycle.events.map((event) => event.delivery.status), [
    'succeeded', 'succeeded', 'succeeded', 'pending', 'pending',
  ]);
  for (const event of lifecycle.events) {
    assert.equal(validateEvent(event).ok, true, `${event.event_id} must satisfy the real Core lifecycle contract`);
  }
}

function deliverRegisteredEvent(fixture, event, { faultGate, failWatermarkRevision, handlerTrace } = {}) {
  const registrationPath = path.join(fixture.root, '.pocket', 'lifecycle-adapter.json');
  const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  const eventDir = path.join(fixture.root, 'adapter-deliveries');
  fs.mkdirSync(eventDir, { recursive: true });
  const eventFile = path.join(eventDir, `revision-${event.revision}.json`);
  fs.writeFileSync(eventFile, `${JSON.stringify(event, null, 2)}\n`);
  const [executable, ...registeredArgs] = registration.argv;
  const env = { ...fixture.env };
  const preloadHooks = [];
  if (faultGate) {
    preloadHooks.push(faultGate.hookPath);
    env.LIFECYCLE_WATERMARK_FAULT_META_PATH = path.join(fixture.specDir, '.pocket-meta.json');
    env.LIFECYCLE_WATERMARK_FAULT_REVISION = String(failWatermarkRevision);
    env.LIFECYCLE_WATERMARK_FAULT_HIT_FILE = faultGate.hitPath;
  }
  if (handlerTrace) {
    preloadHooks.push(handlerTrace.hookPath);
    env.LIFECYCLE_HANDLER_TRACE_FILE = handlerTrace.tracePath;
  }
  if (preloadHooks.length > 0) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, ...preloadHooks.map((hookPath) => `--require=${hookPath}`)]
      .filter(Boolean).join(' ');
  }
  const result = runProcess(executable, [
    ...registeredArgs,
    eventFile,
    '--json',
    '--contract',
    '3',
  ], { cwd: fixture.root, env });
  assert.equal(result.exit, 0, `registered Enterprise executable must return a bounded response: ${result.stdout}${result.stderr}`);
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    assert.fail(`registered Enterprise executable returned invalid JSON: ${result.stdout}`);
  }
  assert.equal(response.event_id, event.event_id);
  return response;
}

function assertSuccessfulProof(response, event) {
  assert.equal(response.status, 'succeeded', `${event.event_id} must be applied successfully`);
  assert.equal(typeof response.proof_ref, 'string');
  assert.match(response.proof_hash, /^[0-9a-f]{64}$/);
}

function assertCanonicalPersistedProof(fixture, event, response) {
  const proof = readMetadata(fixture).phases['phase-3'].review.proof;
  assert.equal(proof.event_id, event.event_id);
  assert.equal(proof.plan_id, PLAN_ID);
  assert.equal(proof.phase_key, 'phase-3');
  assert.equal(proof.phase_number, 3);
  assert.deepEqual(proof.artifact_refs, event.artifact_refs);
  assert.equal(proof.marker, '<!-- pocket-phase-3-summary -->');
  assert.equal(proof.proof_ref, response.proof_ref);
  assert.equal(proof.proof_hash, response.proof_hash);
  assert.match(proof.proof_hash, /^[0-9a-f]{64}$/);
  const { proof_hash: storedHash, ...proofRecord } = proof;
  assert.equal(storedHash, sha256(JSON.stringify(proofRecord)),
    'the persisted event-bound proof hash must be canonical, not merely a metadata hash match');
}

function assertCanonicalPhaseProof(fixture, phaseNumber, event, response) {
  const metadata = readMetadata(fixture);
  const proof = metadata.phases[`phase-${phaseNumber}`].review.proof;
  assert.equal(proof.event_id, event.event_id);
  assert.equal(proof.plan_id, PLAN_ID);
  assert.equal(proof.phase_key, `phase-${phaseNumber}`);
  assert.equal(proof.phase_number, phaseNumber);
  assert.deepEqual(proof.artifact_refs, event.artifact_refs);
  assert.equal(proof.marker, `<!-- pocket-phase-${phaseNumber}-summary -->`);
  assert.equal(proof.proof_ref, response.proof_ref);
  assert.equal(proof.proof_hash, response.proof_hash);
  const { proof_hash: storedHash, ...proofRecord } = proof;
  assert.equal(storedHash, sha256(JSON.stringify(proofRecord)),
    `phase ${phaseNumber} proof hash must match its canonical record`);
}

function assertOrderedRemoteEffects(fixture, remoteBefore, phaseNumbers) {
  const after = readRemote(fixture);
  const expected = phaseNumbers.map((phaseNumber) => ({
    kind: 'phase-summary-create',
    number: PR_NUMBER + phaseNumber - 1,
    marker: `<!-- pocket-phase-${phaseNumber}-summary -->`,
  }));
  assert.deepEqual(after.effects.slice(remoteBefore.effects.length), expected,
    'after the blocked delivery, r4 then r5 must each create exactly one canonical remote proof in order');
  for (const phaseNumber of phaseNumbers) {
    const prNumber = PR_NUMBER + phaseNumber - 1;
    const comments = after.comments[String(prNumber)] || [];
    assert.equal(comments.filter((comment) => comment.body.startsWith(`<!-- pocket-phase-${phaseNumber}-summary -->`)).length, 1,
      `phase ${phaseNumber} must have exactly one canonical marker`);
  }
}

function readMetadata(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
}

function readMetadataBytes(fixture) {
  return fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'));
}

function readWatermark(fixture) {
  return readMetadata(fixture).lifecycle_delivery;
}

function readHandlerCalls(handlerTrace) {
  if (!fs.existsSync(handlerTrace.tracePath)) return [];
  return fs.readFileSync(handlerTrace.tracePath, 'utf8').trim().split(/\r?\n/)
    .filter(Boolean).map((line) => JSON.parse(line));
}

function withoutLifecycleWatermark(metadata) {
  const { lifecycle_delivery: _lifecycleDelivery, ...handlerMetadata } = metadata;
  return handlerMetadata;
}
