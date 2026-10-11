'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { markerFor } = require('../cli/lib/identity');
const { serializeResponse } = require('../enterprise/adapter');
const enterpriseMeta = require('../enterprise/meta');
const { lifecycleEventProofFromMetadata } = require('../enterprise/lifecycle-proof');
const { createLifecycleDelivery } = require('../enterprise/lifecycle-delivery');

const PLAN_ID = 'demo-plan';
const EVENT_ID = `${PLAN_ID}:phase-closed:r1`;
const PHASE_PATH = 'execution-plan/phase-1.md';
const PHASE_TEXT = '# Phase 1\n\nContains tasks: T1\n';
const SNAPSHOT_PATH = 'reviews/closeout-phase-1.md';
const SNAPSHOT_TEXT = '## Closeout\n\nPhase 1 closed with its evidence.\n';
const PROOF_REF = 'meta:phases.phase-1.stack.proof';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function phaseClosedEvent() {
  return {
    event_id: EVENT_ID,
    plan_id: PLAN_ID,
    type: 'phase-closed',
    revision: 1,
    occurred_at: '2026-09-19T12:00:00.000Z',
    artifact_refs: [
      { root: 'plan', kind: 'phase-evidence', path: PHASE_PATH, sha256: sha256(PHASE_TEXT), revision: 1 },
      { root: 'plan', kind: 'closeout-snapshot', path: SNAPSHOT_PATH, sha256: sha256(SNAPSHOT_TEXT), revision: 1 },
    ],
    payload_hash: sha256('phase-closed payload'),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 1 },
  };
}

// Same keys, same order, and same hashing as persistStackProof in phase-closed-handler.js.
// The expectation is written out here rather than imported, so the reader is checked against
// the stored shape and not against its own output.
function storedStackProof(event) {
  const record = {
    event_id: event.event_id,
    plan_id: event.plan_id,
    phase_key: 'phase-1',
    pr_number: 42,
    pr_url: 'https://github.com/pocketto-test/phase-closed/pull/42',
    head_sha: 'a'.repeat(40),
    base: 'main',
    marker: markerFor(1),
    fingerprints: [{ fingerprint: '0123456789abcdef', thread: 'PRRT_1' }],
    artifact_refs: event.artifact_refs.map((ref) => ({
      root: ref.root,
      kind: ref.kind,
      path: ref.path,
      sha256: ref.sha256,
      revision: ref.revision,
    })),
    proof_ref: PROOF_REF,
  };
  return { ...record, proof_hash: sha256(JSON.stringify(record)) };
}

// Round-trips through JSON so the metadata matches what meta.json would hold on disk.
function metadataWith(proof) {
  return JSON.parse(JSON.stringify({
    phases: {
      'phase-1': { stack: { fingerprints: proof.fingerprints, proof } },
    },
  }));
}

// RED cycle 1
// Test file: `test/enterprise-lifecycle-proof-phase-closed.test.js`
// Level: unit
// Test intent: Given metadata holding phases.phase-1.stack.proof exactly as persistStackProof writes it and a matching phase-closed event, When lifecycleEventProofFromMetadata(metadata, event), Then it returns { proof_ref: 'meta:phases.phase-1.stack.proof', proof_hash: <stored hash> }.
// Exercise through: lifecycleEventProofFromMetadata
// Test doubles: none
// Expected RED: returns null (no phase-closed branch)
// Exact command: `node --test --test-name-pattern="phase-closed proof accepted" test/enterprise-lifecycle-proof-phase-closed.test.js`

test('phase-closed proof accepted: T13 stack proof resolves to its proof_ref and stored hash', () => {
  const event = phaseClosedEvent();
  const stored = storedStackProof(event);
  const metadata = metadataWith(stored);

  assert.deepEqual(lifecycleEventProofFromMetadata(metadata, event), {
    proof_ref: PROOF_REF,
    proof_hash: stored.proof_hash,
  });
});

// RED cycle 2 (GUARD)
// Test file: `test/enterprise-lifecycle-proof-phase-closed.test.js`
// Level: unit
// Test intent: Given the accepted fixture, When event_id, plan_id, phase_key, artifact_refs, proof_ref, an extra key, or proof_hash is altered, or the proof is absent, Then the reader returns null for each.
// Exercise through: lifecycleEventProofFromMetadata
// Test doubles: none
// Expected: GUARD. Green once cycle 1 checks every field. Identity and field tampers are re-hashed so only the field check can reject them.
// Exact command: `node --test --test-name-pattern="phase-closed proof rejected" test/enterprise-lifecycle-proof-phase-closed.test.js`

// Builds the stored record, applies one mutation, and optionally re-hashes it so that only the
// field check under test can make the reader reject it.
function tamperedCase(mutate, { rehash = true } = {}) {
  const event = phaseClosedEvent();
  const { proof_hash: storedHash, ...record } = storedStackProof(event);
  mutate(record);
  const proof = { ...record, proof_hash: rehash ? sha256(JSON.stringify(record)) : storedHash };
  return { event, metadata: metadataWith(proof) };
}

function rejectionCases() {
  return [
    { name: 'event_id altered', build: () => tamperedCase((r) => { r.event_id = `${PLAN_ID}:phase-closed:r2`; }) },
    { name: 'plan_id altered', build: () => tamperedCase((r) => { r.plan_id = 'other-plan'; }) },
    { name: 'phase_key altered', build: () => tamperedCase((r) => { r.phase_key = 'phase-2'; }) },
    { name: 'artifact_refs altered', build: () => tamperedCase((r) => { r.artifact_refs[1].sha256 = '0'.repeat(64); }) },
    { name: 'proof_ref altered', build: () => tamperedCase((r) => { r.proof_ref = 'meta:phases.phase-1.github_pr'; }) },
    { name: 'extra key present', build: () => tamperedCase((r) => { r.extra = 'unexpected'; }) },
    { name: 'pr_url missing', build: () => tamperedCase((r) => { delete r.pr_url; }) },
    { name: 'marker from another phase', build: () => tamperedCase((r) => { r.marker = markerFor(2); }) },
    { name: 'proof_hash altered without re-hash', build: () => tamperedCase((r) => { r.pr_number = 43; }, { rehash: false }) },
    {
      name: 'proof_hash altered (one character)',
      build: () => {
        const event = phaseClosedEvent();
        const stored = storedStackProof(event);
        const last = stored.proof_hash.slice(-1);
        const flipped = stored.proof_hash.slice(0, -1) + (last === '0' ? '1' : '0');
        return { event, metadata: metadataWith({ ...stored, proof_hash: flipped }) };
      },
    },
    {
      name: 'proof absent (fingerprints-only stack entry)',
      build: () => {
        const event = phaseClosedEvent();
        const stored = storedStackProof(event);
        return { event, metadata: { phases: { 'phase-1': { stack: { fingerprints: stored.fingerprints } } } } };
      },
    },
    {
      name: 'stack entry absent',
      build: () => ({ event: phaseClosedEvent(), metadata: { phases: {} } }),
    },
    {
      name: 'stack fingerprints differ from proof fingerprints',
      build: () => {
        const event = phaseClosedEvent();
        const stored = storedStackProof(event);
        const metadata = metadataWith(stored);
        metadata.phases['phase-1'].stack.fingerprints = [{ fingerprint: 'fedcba9876543210' }];
        return { event, metadata };
      },
    },
    {
      name: 'event phase-evidence points at a phase with no proof',
      build: () => {
        const stored = storedStackProof(phaseClosedEvent());
        const event = phaseClosedEvent();
        event.artifact_refs[0].path = 'execution-plan/phase-2.md';
        return { event, metadata: metadataWith(stored) };
      },
    },
  ];
}

test('phase-closed proof rejected: every tampered or absent field resolves to null', async (t) => {
  // Positive control: without it, a reader that always returns null would pass every case below.
  const control = tamperedCase(() => {});
  assert.notEqual(lifecycleEventProofFromMetadata(control.metadata, control.event), null,
    'the unmodified fixture must be accepted for the rejection cases to mean anything');

  for (const testCase of rejectionCases()) {
    await t.test(testCase.name, () => {
      const { event, metadata } = testCase.build();
      assert.equal(lifecycleEventProofFromMetadata(metadata, event), null, testCase.name);
    });
  }
});

// Real files on disk: spec dir with lifecycle.json and metadata, plan dir with the committed artifacts.
function deliveryFixture(t, event) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-closed-drain-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const specDir = path.join(root, 'docs', 'pocket', 'spec', PLAN_ID);
  const planDir = path.join(root, 'docs', 'pocket', 'plans', PLAN_ID);
  fs.mkdirSync(path.join(planDir, 'execution-plan'), { recursive: true });
  fs.mkdirSync(path.join(planDir, 'reviews'), { recursive: true });
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, PHASE_PATH), PHASE_TEXT);
  fs.writeFileSync(path.join(planDir, SNAPSHOT_PATH), SNAPSHOT_TEXT);
  fs.writeFileSync(path.join(specDir, 'lifecycle.json'), JSON.stringify({
    schema: 2,
    plan: {
      plan_id: PLAN_ID,
      spec_dir: specDir,
      plan_dir: planDir,
      phase_branches: { mode: 'stacked', root_base: { branch: 'main', sha: 'b'.repeat(40) } },
      phases: { 'phase-1': { branch: `pocket/${PLAN_ID}/phase-1`, base_branch: 'main' } },
      state: { approval: 'APPROVED', phase_status: { 'phase-1': 'COMPLETE' }, status: 'IN_PROGRESS' },
      revision: 1,
    },
    events: [event],
  }, null, 2) + '\n');
  return { root, specDir, planDir };
}

// Test-side stand-in for the T13 writer: stores the full stack proof at meta.phases.phase-1.stack.
function storeStackProof(fixture, event) {
  const context = { projectRoot: fixture.root, specDir: fixture.specDir };
  const stored = storedStackProof(event);
  const meta = enterpriseMeta.readMetaFor(fixture.specDir, context);
  meta.phases = { 'phase-1': { stack: { fingerprints: stored.fingerprints, proof: stored } } };
  enterpriseMeta.writeMetaFor(fixture.specDir, meta, context);
  return stored;
}

// Mirrors the adapter's drain order: prepare, then handler (only when prepare gives no response), then complete.
function drain(delivery, event, handler) {
  const prepared = delivery.prepare(event);
  if (prepared.response) return { prepared, response: prepared.response };
  const produced = handler(prepared.event);
  const response = delivery.complete(prepared.event, serializeResponse(produced, event.event_id), prepared.state);
  return { prepared, response };
}

// RED cycle 3
// Test file: `test/enterprise-lifecycle-proof-phase-closed.test.js`
// Level: integration (delivery function with real files on disk)
// Test intent: Given a phase-closed event whose handler succeeded and stored its stack proof, When the lifecycle delivery path processes it and then processes it again, Then the first call reports succeeded with the proof_ref and hash, the replay reports succeeded without invoking the handler, and neither reports ADAPTER_PROOF_NOT_DURABLE or STALE_ARTIFACT.
// Exercise through: createLifecycleDelivery(projectRoot) returning { prepare, complete }
// Test doubles: a registered handler stub that stores the stack proof and returns its proof ref and hash
// Expected RED: ADAPTER_PROOF_NOT_DURABLE or STALE_ARTIFACT
// Exact command: `node --test --test-name-pattern="phase-closed delivery" test/enterprise-lifecycle-proof-phase-closed.test.js`

test('phase-closed delivery: first drain succeeds with the stored proof and replay stays succeeded', (t) => {
  const event = phaseClosedEvent();
  const fixture = deliveryFixture(t, event);
  const delivery = createLifecycleDelivery(fixture.root);
  const expected = storedStackProof(event);
  const handlerCalls = [];
  const handler = (handlerEvent) => {
    handlerCalls.push(handlerEvent.event_id);
    const stored = storeStackProof(fixture, handlerEvent);
    return { event_id: handlerEvent.event_id, status: 'succeeded', proof_ref: stored.proof_ref, proof_hash: stored.proof_hash };
  };

  const first = drain(delivery, event, handler);

  assert.equal(first.response.status, 'succeeded', JSON.stringify(first.response));
  assert.equal(first.response.error, undefined, JSON.stringify(first.response));
  assert.equal(first.response.proof_ref, PROOF_REF);
  assert.equal(first.response.proof_hash, expected.proof_hash);
  assert.equal(enterpriseMeta.readLifecycleDelivery(fixture.specDir, PLAN_ID, { projectRoot: fixture.root, specDir: fixture.specDir })
    .last_applied_revision, 1, 'a succeeded drain must advance the watermark');

  const metaPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const metaBeforeReplay = fs.readFileSync(metaPath, 'utf8');
  const succeeded = {
    ...event,
    delivery: { status: 'succeeded', attempts: 1, proof_ref: PROOF_REF, proof_hash: expected.proof_hash },
  };
  const replay = delivery.prepare(succeeded);

  assert.equal(replay.response, undefined, `replay must not short-circuit with an error: ${JSON.stringify(replay.response)}`);
  assert.equal(replay.state.replay, true);
  assert.equal(replay.event.delivery.status, 'succeeded');
  assert.equal(replay.event.delivery.proof_ref, PROOF_REF);
  assert.equal(replay.event.delivery.proof_hash, expected.proof_hash);
  const replayResponse = serializeResponse({
    event_id: event.event_id, status: 'succeeded', proof_ref: PROOF_REF, proof_hash: expected.proof_hash,
  }, event.event_id);
  assert.deepEqual(delivery.complete(replay.event, replayResponse, replay.state), replayResponse);
  assert.equal(fs.readFileSync(metaPath, 'utf8'), metaBeforeReplay, 'replay must not rewrite metadata');
  assert.deepEqual(handlerCalls, [event.event_id], 'the handler stub ran only for the first drain');
});

// RED cycle 4
// Test file: `test/enterprise-lifecycle-proof-phase-closed.test.js`
// Level: integration
// Test intent: Given a phase-closed event whose closeout snapshot was edited after the event, When delivery runs, Then it answers terminal STALE_ARTIFACT before any handler call. Given unsafe enterprise metadata, Then the answer uses a phase-closed-specific metadata error code, not a generic one.
// Exercise through: the exported lifecycle delivery entry createLifecycleDelivery(projectRoot) (prepare, then complete only if a handler ran)
// Test doubles: a handler stub that fails the test if it is called
// Expected RED: the event is routed to the generic stale path or to the wrong code
// Exact command: `node --test --test-name-pattern="phase-closed stale artifact" test/enterprise-lifecycle-proof-phase-closed.test.js`

function handlerMustNotRun() {
  return () => assert.fail('the handler must not run for a stale or unsafe phase-closed event');
}

test('phase-closed stale artifact: an edited closeout snapshot is terminal STALE_ARTIFACT before any handler call', (t) => {
  const event = phaseClosedEvent();
  const fixture = deliveryFixture(t, event);
  fs.writeFileSync(path.join(fixture.planDir, SNAPSHOT_PATH), 'Closeout rewritten after the event.\n');
  const delivery = createLifecycleDelivery(fixture.root);

  const { response } = drain(delivery, event, handlerMustNotRun());

  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.code, 'STALE_ARTIFACT', JSON.stringify(response));
  assert.equal(response.error.retryable, false);
});

test('phase-closed stale artifact: an edited phase-evidence file is terminal STALE_ARTIFACT before any handler call', (t) => {
  const event = phaseClosedEvent();
  const fixture = deliveryFixture(t, event);
  fs.writeFileSync(path.join(fixture.planDir, PHASE_PATH), '# Phase 1\n\nEdited after the event.\n');
  const delivery = createLifecycleDelivery(fixture.root);

  const { response } = drain(delivery, event, handlerMustNotRun());

  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.code, 'STALE_ARTIFACT', JSON.stringify(response));
  assert.equal(response.error.retryable, false);
});

// Reconciling recovery: the handler already stored its proof, but the watermark write did not land.
// recoverReconcilingEvent must validate the committed artifacts through loadContext before it recovers.
// Test file: `test/enterprise-lifecycle-proof-phase-closed.test.js`
// Level: integration (delivery function with real files on disk)
// Test intent: Given a reconciling phase-closed event whose stack proof is stored and whose artifacts are valid, When prepare runs, Then it recovers succeeded with the stored proof_ref and hash and advances the watermark without calling a handler. Given the same state with a tampered closeout snapshot, Then terminal STALE_ARTIFACT and no watermark advance.
// Exercise through: createLifecycleDelivery(projectRoot).prepare
// Test doubles: none beyond the stored proof written to meta on disk
// Exact command: `node --test --test-name-pattern="phase-closed reconciling" test/enterprise-lifecycle-proof-phase-closed.test.js`

function reconcilingEvent(event, expected) {
  return {
    ...event,
    delivery: { status: 'reconciling', attempts: 1, proof_ref: PROOF_REF, proof_hash: expected.proof_hash },
  };
}

function watermarkOf(fixture) {
  return enterpriseMeta.readLifecycleDelivery(fixture.specDir, PLAN_ID, { projectRoot: fixture.root, specDir: fixture.specDir })
    .last_applied_revision;
}

test('phase-closed reconciling: valid artifacts recover the stored proof and advance the watermark', (t) => {
  const event = phaseClosedEvent();
  const fixture = deliveryFixture(t, event);
  const expected = storedStackProof(event);
  storeStackProof(fixture, event);
  const delivery = createLifecycleDelivery(fixture.root);

  const prepared = delivery.prepare(reconcilingEvent(event, expected));

  assert.equal(prepared.response && prepared.response.status, 'succeeded', JSON.stringify(prepared.response));
  assert.equal(prepared.response.error, undefined, JSON.stringify(prepared.response));
  assert.equal(prepared.response.proof_ref, PROOF_REF);
  assert.equal(prepared.response.proof_hash, expected.proof_hash);
  assert.equal(watermarkOf(fixture), 1, 'recovery must advance the watermark to the reconciled revision');
});

test('phase-closed reconciling: a tampered closeout snapshot is terminal STALE_ARTIFACT and does not advance the watermark', (t) => {
  const event = phaseClosedEvent();
  const fixture = deliveryFixture(t, event);
  const expected = storedStackProof(event);
  storeStackProof(fixture, event);
  fs.writeFileSync(path.join(fixture.planDir, SNAPSHOT_PATH), 'Closeout rewritten before recovery.\n');
  const delivery = createLifecycleDelivery(fixture.root);

  const prepared = delivery.prepare(reconcilingEvent(event, expected));

  assert.equal(prepared.response && prepared.response.status, 'terminal', JSON.stringify(prepared.response));
  assert.equal(prepared.response.error.code, 'STALE_ARTIFACT', JSON.stringify(prepared.response));
  assert.equal(prepared.response.error.retryable, false);
  assert.equal(watermarkOf(fixture), 0, 'a stale reconciling event must not advance the watermark');
});

// Unsafe metadata is the reachable metadata failure. A missing .pocket-meta.json is read as empty
// metadata on the delivery path, so it never reaches the metadata error mapping.
test('phase-closed stale artifact: unsafe enterprise metadata answers PHASE_CLOSED_METADATA_PATH_INVALID before any handler call', (t) => {
  const event = phaseClosedEvent();
  const fixture = deliveryFixture(t, event);
  fs.symlinkSync(path.join(fixture.specDir, 'no-such-metadata.json'), enterpriseMeta.resolveMetaPath(fixture.specDir));
  const delivery = createLifecycleDelivery(fixture.root);

  const { response } = drain(delivery, event, handlerMustNotRun());

  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.code, 'PHASE_CLOSED_METADATA_PATH_INVALID', JSON.stringify(response));
  assert.equal(response.error.retryable, false);
});
