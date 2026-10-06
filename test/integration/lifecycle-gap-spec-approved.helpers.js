'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLAN_ID } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { installEnterpriseAdapter } = require('./support/enterprise');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');
const { sha256, writeFile } = require('./support/files');
const {
  installLifecycleWatermarkWriteFaultGate,
  installLifecycleIssueHandlerCallTraceGate,
} = require('./support/failure-gates');
const scenarioHelpers = require('./lifecycle-gap.helpers');

function preparePrePlanningSpecApprovedProofFirstScenario(t) {
  const fixture = createFixture(t);
  installEnterpriseAdapter(fixture);
  const event = commitPrePlanningSpecApprovedWithTwoRefs(fixture);
  assertPrePlanningSpecApprovedEvent(fixture, event);

  const initialDelivery = deliverSpecApprovedWithWatermarkFailure(fixture, event);
  const proofState = assertCanonicalIssueProof(fixture, event, initialDelivery);
  return {
    fixture,
    event,
    handlerTrace: initialDelivery.handlerTrace,
    reconcilingEvent: initialDelivery.reconcilingEvent,
    proof: proofState.proof,
    metadataAfterProofBytes: scenarioHelpers.readMetadataBytes(fixture),
    remoteAfterProof: proofState.remoteAfterProof,
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

function assertPrePlanningSpecApprovedEvent(fixture, event) {
  const lifecycle = readLifecycle(fixture);
  assert.equal(lifecycle.plan.plan_dir, null, 'spec-approved must use its normative pre-planning state');
  assert.equal(lifecycle.plan.branch, null, 'spec-approved must not require a captured branch');
  assert.equal(event.event_id, `${PLAN_ID}:spec-approved:r1`);
  assert.deepEqual(event.artifact_refs.map(({ root }) => root), ['spec', 'spec']);
}

function deliverSpecApprovedWithWatermarkFailure(fixture, event) {
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
  return { handlerTrace, reconcilingEvent, remoteBeforeProof };
}

function assertCanonicalIssueProof(fixture, event, initialDelivery) {
  const metadataAfterProof = scenarioHelpers.readMetadata(fixture);
  const proof = metadataAfterProof.github_issue.ownership;
  const { handlerTrace, reconcilingEvent, remoteBeforeProof } = initialDelivery;
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
  return { proof, remoteAfterProof };
}

module.exports = { preparePrePlanningSpecApprovedProofFirstScenario };
