'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const enterpriseMeta = require('../../enterprise/meta');
const identity = require('../../cli/lib/identity');
const { summaryBody } = require('../../cli/lib/bodies');
const { PR_NUMBER, createFixture } = require('./fixture');
const { allComments, allThreads } = require('./remote');
const { loadPhaseHandler } = require('./test-utils');
const { handlerOptions, inlinePostCount, staleResolveCount } = require('./replay-utils');

const PROOF_REF = 'meta:phases.phase-1.github_pr+meta:phases.phase-1.review.fingerprints';

// RED cycle 5
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given a succeeded event with valid event-bound proof, When the handler replays it, Then it returns the persisted proof with no GitHub calls or local metadata writes.
// Exercise through: phase handler replay with persisted event proof and a recording fake transport.
// Test doubles: deterministic fake GitHub API; real metadata serialization and event validation.
// Expected RED: succeeded events currently reconcile the remote marker and mutate metadata.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 5: valid succeeded proof is returned without remote or local mutation', (t) => {
  const fixture = createFixture(t);
  const fingerprints = [
    { fingerprint: '0123456789abcdef', thread: 'PRRT_KEEP' },
    { fingerprint: 'fedcba9876543210', thread: 'PRRT_STALE' },
  ];
  const proof = seedPhaseProof(fixture, fingerprints);
  configureRemoteFixture(fixture, fingerprints[0].fingerprint, fingerprints[1].fingerprint);
  fixture.event.delivery = {
    status: 'succeeded',
    attempts: 1,
    proof_ref: proof.proof_ref,
    proof_hash: proof.proof_hash,
  };
  const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const before = fs.readFileSync(metadataPath, 'utf8');
  const handler = loadPhaseHandler();
  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.equal(response.proof_ref, proof.proof_ref);
  assert.equal(response.proof_hash, proof.proof_hash);
  assert.deepEqual(fixture.remote.calls, [], 'succeeded proof must return before repository, issue, PR, or thread lookups');
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), before,
    'succeeded proof replay must leave metadata bytes unchanged');
});

test('RED cycle 5: missing, mismatched, or differently-bound succeeded proof fails closed', async (t) => {
  for (const scenario of ['missing', 'mismatched', 'other-event']) {
    await t.test(`${scenario} proof does not enter reconciliation`, (t) => {
      const fixture = createFixture(t);
      const fingerprints = [{ fingerprint: '0123456789abcdef', thread: 'PRRT_KEEP' }];
      const proof = seedPhaseProof(fixture, fingerprints);
      configureRemoteFixture(fixture, fingerprints[0].fingerprint, 'fedcba9876543210');
      const delivery = { status: 'succeeded', attempts: 1 };
      const event = { ...fixture.event };
      if (scenario !== 'missing') {
        delivery.proof_ref = proof.proof_ref;
        delivery.proof_hash = scenario === 'mismatched' ? '0'.repeat(64) : proof.proof_hash;
      }
      if (scenario === 'other-event') {
        event.revision = 2;
        event.event_id = `${event.plan_id}:phase-complete:r2`;
      }
      event.proof_ref = proof.proof_ref;
      event.proof_hash = proof.proof_hash;
      event.delivery = delivery;
      const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
      const before = fs.readFileSync(metadataPath, 'utf8');
      const handler = loadPhaseHandler();
      const response = handler.handlePhaseComplete(event, handlerOptions(fixture));

      assert.equal(response.status, 'terminal', JSON.stringify(response));
      assert.equal(response.error.code, 'PHASE_PROOF_MISMATCH');
      assert.deepEqual(fixture.remote.calls, [], 'invalid succeeded proof must fail before repository, issue, PR, or thread lookups');
      assert.equal(fs.readFileSync(metadataPath, 'utf8'), before,
        'invalid succeeded proof must leave metadata bytes unchanged');
    });
  }
});

test('RED cycle 5: claimed delivery is ineligible for phase reconciliation', (t) => {
  const fixture = createFixture(t);
  fixture.event.delivery.status = 'claimed';
  const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const before = fs.readFileSync(metadataPath, 'utf8');
  const handler = loadPhaseHandler();
  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.code, 'PHASE_DELIVERY_INELIGIBLE');
  assert.deepEqual(fixture.remote.calls, [], 'claimed delivery must not enter the remote-write path');
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), before);
});

test('RED cycle 5: reconciling replay repairs markers and finding threads', (t) => {
  const fixture = createFixture(t);
  const currentFingerprint = identity.fingerprint({
    file: 'src/worker.js',
    ruleId: 'stage-1:spec-compliance',
    message: 'Missing error handling for invalid input',
    occurrence: 0,
  });
  const staleFingerprint = '3333333333333333';
  configureRemoteFixture(fixture, currentFingerprint, staleFingerprint);
  fixture.event.delivery = { status: 'reconciling', attempts: 2 };
  const handler = loadPhaseHandler();
  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  const marker = identity.markerFor('1');
  const remainingMarkers = allComments(fixture.remote, PR_NUMBER).filter((comment) => comment.body.startsWith(marker));
  assert.equal(remainingMarkers.length, 1, 'duplicate markers must collapse to one');
  assert.equal(remainingMarkers[0].id, 3, 'the earliest marker must be retained');
  assert.equal(remainingMarkers[0].body, summaryBody({ phase: 1, verdicts: [{ task: 'T1', verdict: 'FAIL' }], prLinked: true }));
  assert.equal(allThreads(fixture.remote)[0].isResolved, false, 'the current finding thread must be kept');
  assert.equal(allThreads(fixture.remote)[1].isResolved, true, 'the removed finding thread must be resolved');
  assert.equal(inlinePostCount(fixture.remote), 0, 'reconciling replay must not post a duplicate inline finding');
  assert.equal(staleResolveCount(fixture.remote), 1, 'stale thread resolution must occur exactly once');
  const persisted = enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'].review;
  assert.deepEqual(persisted.fingerprints, [{ fingerprint: currentFingerprint, thread: 'PRRT_KEEP' }]);
  assert.equal(persisted.proof.event_id, fixture.event.event_id,
    'reconciliation must persist a canonical event-bound proof');
});

function seedPhaseProof(fixture, fingerprints) {
  const marker = identity.markerFor('1');
  const pr = fixture.remote.prs[0];
  const record = {
    event_id: fixture.event.event_id,
    plan_id: fixture.event.plan_id,
    phase_key: 'phase-1',
    phase_number: 1,
    artifact_refs: fixture.event.artifact_refs.map((ref) => ({ ...ref })),
    pr_number: PR_NUMBER,
    pr_url: pr.url,
    marker,
    fingerprints: fingerprints.map((record) => ({ ...record })),
    proof_ref: PROOF_REF,
  };
  const proofHash = crypto.createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
  const proof = { ...record, proof_hash: proofHash };
  const metadata = enterpriseMeta.readMetaFor(fixture.specDir);
  metadata.phases['phase-1'].review = {
    fingerprints: fingerprints.map((record) => ({ ...record })),
    proof,
  };
  enterpriseMeta.writeMetaFor(fixture.specDir, metadata);
  return proof;
}

function configureRemoteFixture(fixture, currentFingerprint, staleFingerprint) {
  const pr = fixture.remote.prs[0];
  const marker = identity.markerFor('1');
  pr.commentPages = [
    [{ id: 3, body: `${marker}\n\nOld summary` }],
    [{ id: 8, body: `${marker}\n\nDuplicate summary` }],
  ];
  pr.threadPages = [[{
    id: 'PRRT_KEEP',
    isResolved: false,
    comments: { nodes: [{ body: `Existing finding\n\n<!-- pocket-fp:${currentFingerprint} -->`, path: 'src/worker.js', line: 18 }] },
  }], [{
    id: 'PRRT_STALE',
    isResolved: false,
    comments: { nodes: [{ body: `Removed finding\n\n<!-- pocket-fp:${staleFingerprint} -->`, path: 'src/old.js', line: 4 }] },
  }]];
}
