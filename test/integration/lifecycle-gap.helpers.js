'use strict';

const {
  equal: assertEqual,
  deepEqual: assertDeepEqual,
  match: assertMatch,
  fail: assertFail,
} = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID, PR_NUMBER, REPOSITORY_URL } = require('./support/constants');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { assertCliOk, runCore } = require('./support/core-cli');
const { runProcess } = require('./support/process');
const { sha256, writeFile } = require('./support/files');
const { commitTransition, updateEventDelivery } = require('../../cli/lib/lifecycle-store');
const { validateEvent } = require('../../cli/lib/lifecycle-contract');
const { responseDeliveryPatch } = require('../../cli/lib/lifecycle-retry');
const enterpriseMeta = require('../../enterprise/meta');

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

function appendPhaseEvent(fixture, phaseNumber, additionalArtifacts = []) {
  const artifactRefs = [
    { root: 'plan', path: `execution-plan/phase-${phaseNumber}.md` },
    ...additionalArtifacts,
  ];
  const artifacts = artifactRefs.map(({ root, path: artifactPath }) => {
    const artifactRoot = root === 'spec' ? fixture.specDir : fixture.planDir;
    return {
      root,
      kind: 'phase-evidence',
      path: artifactPath,
      sha256: sha256(fs.readFileSync(path.join(artifactRoot, artifactPath), 'utf8')),
      revision: 1,
    };
  });
  const result = commitTransition({
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: PLAN_ID,
    type: 'phase-complete',
    artifacts,
    branch: `feature/${PLAN_ID}`,
    deps: { now: () => new Date(Date.parse(FIXED_NOW) + phaseNumber * 1000).toISOString() },
  });
  assertTransitionCommitted(result, phaseNumber);
  return result.event;
}

function assertTransitionCommitted(result, phaseNumber) {
  assertEqual(result.ok, true, `Core must commit valid phase ${phaseNumber} event: ${JSON.stringify(result)}`);
}

function assertValidOrderedJournal(fixture) {
  const lifecycle = readLifecycle(fixture);
  assertEqual(lifecycle.plan.revision, 5);
  assertDeepEqual(lifecycle.events.map((event) => event.revision), [1, 2, 3, 4, 5],
    'Core’s authoritative journal must contain every revision in append order');
  assertDeepEqual(lifecycle.events.map((event) => event.delivery.status), [
    'succeeded', 'succeeded', 'succeeded', 'pending', 'pending',
  ]);
  for (const event of lifecycle.events) {
    assertEqual(validateEvent(event).ok, true, `${event.event_id} must satisfy the real Core lifecycle contract`);
  }
}

function deliverRegisteredEvent(fixture, event, {
  faultGate, failWatermarkRevision, handlerTrace, readFaultGate, readArtifactPath,
} = {}) {
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
  if (readFaultGate) {
    preloadHooks.push(readFaultGate.hookPath);
    env.LIFECYCLE_ENTERPRISE_READ_FAILURE_PATH = path.resolve(readArtifactPath);
    env.LIFECYCLE_ENTERPRISE_DISPATCH_PATH = readFaultGate.dispatchPath;
    env.LIFECYCLE_ENTERPRISE_READ_FAILURE_HIT_FILE = readFaultGate.hitPath;
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
  assertEqual(result.exit, 0,
    `registered Enterprise executable must return a bounded response: ${result.stdout}${result.stderr}`);
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    assertFail(`registered Enterprise executable returned invalid JSON: ${result.stdout}`);
  }
  assertEqual(response.event_id, event.event_id);
  return response;
}

function assertSuccessfulProof(response, event) {
  assertEqual(response.status, 'succeeded', `${event.event_id} must be applied successfully: ${JSON.stringify(response)}`);
  assertEqual(typeof response.proof_ref, 'string');
  assertMatch(response.proof_hash, /^[0-9a-f]{64}$/);
}

function assertCanonicalPersistedProof(fixture, event, response) {
  const proof = readMetadata(fixture).phases['phase-3'].review.proof;
  assertEqual(proof.event_id, event.event_id);
  assertEqual(proof.plan_id, PLAN_ID);
  assertEqual(proof.phase_key, 'phase-3');
  assertEqual(proof.phase_number, 3);
  assertDeepEqual(proof.artifact_refs, event.artifact_refs);
  assertEqual(proof.marker, '<!-- pocket-phase-3-summary -->');
  assertEqual(proof.proof_ref, response.proof_ref);
  assertEqual(proof.proof_hash, response.proof_hash);
  assertMatch(proof.proof_hash, /^[0-9a-f]{64}$/);
  const { proof_hash: storedHash, ...proofRecord } = proof;
  assertEqual(storedHash, sha256(JSON.stringify(proofRecord)),
    'the persisted event-bound proof hash must be canonical, not merely a metadata hash match');
}

function assertCanonicalPhaseProof(fixture, phaseNumber, event, response) {
  const metadata = readMetadata(fixture);
  const proof = metadata.phases[`phase-${phaseNumber}`].review.proof;
  assertEqual(proof.event_id, event.event_id);
  assertEqual(proof.plan_id, PLAN_ID);
  assertEqual(proof.phase_key, `phase-${phaseNumber}`);
  assertEqual(proof.phase_number, phaseNumber);
  assertDeepEqual(proof.artifact_refs, event.artifact_refs);
  assertEqual(proof.marker, `<!-- pocket-phase-${phaseNumber}-summary -->`);
  assertEqual(proof.proof_ref, response.proof_ref);
  assertEqual(proof.proof_hash, response.proof_hash);
  const { proof_hash: storedHash, ...proofRecord } = proof;
  assertEqual(storedHash, sha256(JSON.stringify(proofRecord)),
    `phase ${phaseNumber} proof hash must match its canonical record`);
}

function assertOrderedRemoteEffects(fixture, remoteBefore, phaseNumbers) {
  const after = readRemote(fixture);
  const expected = phaseNumbers.map((phaseNumber) => ({
    kind: 'phase-summary-create',
    number: PR_NUMBER + phaseNumber - 1,
    marker: `<!-- pocket-phase-${phaseNumber}-summary -->`,
  }));
  assertDeepEqual(after.effects.slice(remoteBefore.effects.length), expected,
    'after the blocked delivery, r4 then r5 must each create exactly one canonical remote proof in order');
  for (const phaseNumber of phaseNumbers) {
    const prNumber = PR_NUMBER + phaseNumber - 1;
    const comments = after.comments[String(prNumber)] || [];
    assertEqual(comments.filter((comment) => comment.body.startsWith(`<!-- pocket-phase-${phaseNumber}-summary -->`)).length, 1,
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

function runCoreDeliveryWithWatermarkFailure(fixture, event, faultGate, handlerTrace) {
  const hooks = [faultGate, handlerTrace].filter(Boolean);
  const env = {
    ...fixture.env,
    NODE_OPTIONS: [fixture.env.NODE_OPTIONS, ...hooks.map(({ hookPath }) => `--require=${hookPath}`)]
      .filter(Boolean).join(' '),
    LIFECYCLE_WATERMARK_FAULT_META_PATH: path.join(fixture.specDir, '.pocket-meta.json'),
    LIFECYCLE_WATERMARK_FAULT_REVISION: String(event.revision),
    LIFECYCLE_WATERMARK_FAULT_HIT_FILE: faultGate.hitPath,
  };
  if (handlerTrace) env.LIFECYCLE_HANDLER_TRACE_FILE = handlerTrace.tracePath;
  return assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], env), 'Core lifecycle drain with an injected Enterprise watermark-write failure');
}

function persistRegisteredAdapterResponse(fixture, event, response) {
  const attempts = event.delivery.attempts + 1;
  const patch = responseDeliveryPatch(response, attempts, Date.parse(FIXED_NOW) + 1001);
  return updateEventDelivery(fixture.specDir, event.event_id, { ...patch, attempts });
}

function withoutLifecycleWatermark(metadata) {
  const { lifecycle_delivery: _lifecycleDelivery, ...handlerMetadata } = metadata;
  return handlerMetadata;
}

module.exports = {
  preparePhaseFixtures,
  seedPhasePullRequests,
  appendPhaseEvent,
  assertValidOrderedJournal,
  deliverRegisteredEvent,
  assertSuccessfulProof,
  assertCanonicalPersistedProof,
  assertCanonicalPhaseProof,
  assertOrderedRemoteEffects,
  readMetadata,
  readMetadataBytes,
  readWatermark,
  readHandlerCalls,
  runCoreDeliveryWithWatermarkFailure,
  persistRegisteredAdapterResponse,
  withoutLifecycleWatermark,
};
