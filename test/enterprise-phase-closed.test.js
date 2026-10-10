'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const enterpriseMeta = require('../enterprise/meta');
const { handlePhaseComplete } = require('../enterprise/phase-handler');
const { createLifecycleDelivery } = require('../enterprise/lifecycle-delivery');
const { loadContext, phaseBranchFor } = require('../enterprise/phase-handler-context');
const { resolveRepository, resolvePhasePr } = require('../enterprise/phase-handler-targets');
const { createFixture } = require('../test-support/enterprise-phase/fixture');
const { fakeGh } = require('../test-support/enterprise-phase/remote');

const PLAN_ID = 'demo-plan';
const DEFERRED_PROOF_REF = 'deferred:phase-closed';
const STACKED_PHASES = {
  'phase-1': { branch: 'feature/demo-plan-phase-1', base_branch: 'main' },
  'phase-2': { branch: 'feature/demo-plan-phase-2', base_branch: 'feature/demo-plan-phase-1' },
};

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function handlerOptions(fixture) {
  return { projectRoot: fixture.root, ghRunner: fakeGh(fixture.remote) };
}

// Independent expectation for the deferred proof: literal key order, same hashing style.
function expectedDeferredHash(event) {
  return sha256(JSON.stringify({ event_id: event.event_id, plan_id: event.plan_id, deferred: 'phase-closed' }));
}

// Schema-2 stacked plan: phase 2 has REVIEW evidence and a pending phase-complete event.
// plan.branch is omitted unless the caller asks for it, so the stacked path must not need it.
function stackedFixture(t, { planBranch } = {}) {
  const fixture = createFixture(t);
  const phasePath = 'execution-plan/phase-2.md';
  const phaseText = '# Phase 2\n\nContains tasks: T2\n';
  fs.writeFileSync(path.join(fixture.planDir, phasePath), phaseText);
  fs.writeFileSync(path.join(fixture.planDir, 'log.json'), JSON.stringify({
    header: { plan_dir: fixture.planDir, status: 'IN_PROGRESS', phase_branches: { mode: 'stacked', root_base: 'main' } },
    phases: [{ file: phasePath, status: 'REVIEW', tasks: [{ id: 'T2', name: 'Second phase task', status: 'DONE' }] }],
  }, null, 2) + '\n');
  const event = {
    ...fixture.event,
    artifact_refs: [{
      root: 'plan',
      kind: 'phase-evidence',
      path: phasePath,
      sha256: sha256(phaseText),
      revision: 1,
    }],
  };
  const plan = {
    plan_id: PLAN_ID,
    spec_dir: fixture.specDir,
    plan_dir: fixture.planDir,
    phase_branches: { mode: 'stacked', root_base: 'main' },
    phases: STACKED_PHASES,
    state: { approval: 'APPROVED', phase_status: { 'phase-1': 'COMPLETE', 'phase-2': 'COMPLETE' }, status: 'IN_PROGRESS' },
    revision: 1,
  };
  if (planBranch !== undefined) plan.branch = planBranch;
  fs.writeFileSync(path.join(fixture.specDir, 'lifecycle.json'), JSON.stringify({
    schema: 2,
    plan,
    events: [event],
  }, null, 2) + '\n');
  return { ...fixture, event };
}

// RED cycle 1
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration (handler with fake gh runner and temp project)
// Test intent: Given a schema-2 stacked lifecycle doc and a pending phase-complete event for phase 2, When handlePhaseComplete runs, Then status succeeded, proof_ref deferred:phase-closed, and zero gh calls.
// Exercise through: handlePhaseComplete
// Test doubles: fake gh runner counting calls (fixture.remote.calls)
// Expected RED: schema 2 rejected (PHASE_PLAN_IDENTITY_MISMATCH)
// Exact command: `node --test --test-name-pattern="stacked phase-complete deferral" test/enterprise-phase-closed.test.js`

test('stacked phase-complete deferral: pending phase-2 event succeeds as deferred with zero gh calls', (t) => {
  const fixture = stackedFixture(t);
  const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const before = fs.readFileSync(metadataPath, 'utf8');

  const response = handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.equal(response.event_id, fixture.event.event_id);
  assert.equal(response.proof_ref, DEFERRED_PROOF_REF);
  assert.equal(response.proof_hash, expectedDeferredHash(fixture.event));
  assert.deepEqual(fixture.remote.calls, [], 'stacked deferral must make no GitHub call');
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), before, 'stacked deferral must not write metadata');
});

// Guard (regression): non-stacked plans keep the existing reconciliation path.
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given a schema-1 non-stacked lifecycle doc, When handlePhaseComplete runs, Then its first gh call is `repo view` exactly as before.
// Exercise through: handlePhaseComplete
// Test doubles: fake gh runner recording argv (fixture.remote.calls)
// Expected RED: none (regression guard, green on unchanged code)
// Exact command: `node --test --test-name-pattern="non-stacked unchanged" test/enterprise-phase-closed.test.js`

test('non-stacked unchanged: schema-1 phase-complete still reconciles starting with repo view', (t) => {
  const fixture = createFixture(t);

  const response = handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.deepEqual(fixture.remote.calls[0], ['repo', 'view', '--json', 'owner,name,url'],
    'first gh call for a non-stacked plan must be repo view');
  assert.notEqual(response.proof_ref, DEFERRED_PROOF_REF, JSON.stringify(response));
});

// RED cycle 2
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given the same event marked succeeded with the deferred proof, When handlePhaseComplete replays it, Then the same response and zero gh calls. Given a tampered proof hash, Then terminal PHASE_PROOF_MISMATCH.
// Exercise through: handlePhaseComplete
// Test doubles: fake gh runner counting calls (fixture.remote.calls)
// Expected RED: replay looks for a metadata PR proof that a deferred event never wrote
// Exact command: `node --test --test-name-pattern="deferred replay" test/enterprise-phase-closed.test.js`

test('deferred replay: succeeded deferred event replays identically with zero gh calls', (t) => {
  const fixture = stackedFixture(t);
  const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const first = handlePhaseComplete(fixture.event, handlerOptions(fixture));
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  const before = fs.readFileSync(metadataPath, 'utf8');
  const succeeded = {
    ...fixture.event,
    delivery: { status: 'succeeded', attempts: 1, proof_ref: first.proof_ref, proof_hash: first.proof_hash },
  };

  const replay = handlePhaseComplete(succeeded, handlerOptions(fixture));

  assert.deepEqual(replay, first);
  assert.deepEqual(fixture.remote.calls, [], 'deferred replay must verify only the hash and make no GitHub call');
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), before, 'deferred replay must not write metadata');
});

test('deferred replay: tampered deferred proof hash is a terminal PHASE_PROOF_MISMATCH', (t) => {
  const fixture = stackedFixture(t);
  const tampered = {
    ...fixture.event,
    delivery: { status: 'succeeded', attempts: 1, proof_ref: DEFERRED_PROOF_REF, proof_hash: '0'.repeat(64) },
  };

  const response = handlePhaseComplete(tampered, handlerOptions(fixture));

  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.code, 'PHASE_PROOF_MISMATCH');
  assert.match(response.error.message, /deferred proof/, 'must fail on the deferred proof check, not the metadata proof check');
  assert.deepEqual(fixture.remote.calls, [], 'tampered deferred proof must fail before any GitHub call');
});

// RED cycle 5
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration (drain completion path: createLifecycleDelivery prepare + handler + complete)
// Test intent: Given a stacked phase-2 pending event, When the handler returns the deferred success and the drain completion path runs, Then delivery completes as succeeded with no error, the watermark advances, and zero gh calls run across both steps.
// Exercise through: createLifecycleDelivery(...).prepare / handlePhaseComplete / .complete
// Test doubles: fake gh runner counting calls (fixture.remote.calls)
// Expected RED: reconciling / ADAPTER_PROOF_NOT_DURABLE (lookup reads only metadata review.proof)
// Exact command: `node --test --test-name-pattern="stacked deferred completes durably" test/enterprise-phase-closed.test.js`

test('stacked deferred completes durably: deferred success completes delivery with zero gh calls', (t) => {
  const fixture = stackedFixture(t);
  const delivery = createLifecycleDelivery(fixture.root);
  const prepared = delivery.prepare(fixture.event);
  assert.ok(prepared.state, JSON.stringify(prepared.response));

  const response = handlePhaseComplete(prepared.event, handlerOptions(fixture));
  assert.equal(response.proof_ref, DEFERRED_PROOF_REF, JSON.stringify(response));
  const completed = delivery.complete(prepared.event, response, prepared.state);

  assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
  assert.equal(completed.error, undefined, JSON.stringify(completed));
  assert.equal(completed.proof_ref, DEFERRED_PROOF_REF);
  assert.equal(completed.proof_hash, expectedDeferredHash(fixture.event));
  assert.equal(enterpriseMeta.readLifecycleDelivery(prepared.state.context.specDir, PLAN_ID, prepared.state.context).last_applied_revision, 1,
    'completed deferred delivery must advance the watermark');
  assert.deepEqual(fixture.remote.calls, [], 'deferred drain completion must make no GitHub call');
});

// RED cycle 6
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration (drain completion path)
// Test intent: Given a stacked phase-2 deferred success whose proof_hash is altered by one character, When the completion path runs, Then terminal PHASE_PROOF_MISMATCH with the deferred-proof message, no watermark advance, and zero gh calls.
// Exercise through: createLifecycleDelivery(...).prepare / handlePhaseComplete / .complete
// Test doubles: fake gh runner counting calls (fixture.remote.calls)
// Expected RED: reconciling / ADAPTER_PROOF_NOT_DURABLE (tampered hash is not compared against the deferred derivation)
// Exact command: `node --test --test-name-pattern="deferred proof tampered rejected" test/enterprise-phase-closed.test.js`

test('deferred proof tampered rejected: altered deferred proof hash is terminal PHASE_PROOF_MISMATCH', (t) => {
  const fixture = stackedFixture(t);
  const delivery = createLifecycleDelivery(fixture.root);
  const prepared = delivery.prepare(fixture.event);
  const response = handlePhaseComplete(prepared.event, handlerOptions(fixture));
  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  const last = response.proof_hash.slice(-1);
  const tamperedHash = response.proof_hash.slice(0, -1) + (last === '0' ? '1' : '0');
  assert.notEqual(tamperedHash, response.proof_hash);

  const completed = delivery.complete(prepared.event, { ...response, proof_hash: tamperedHash }, prepared.state);

  assert.equal(completed.status, 'terminal', JSON.stringify(completed));
  assert.equal(completed.error.code, 'PHASE_PROOF_MISMATCH', JSON.stringify(completed));
  assert.match(completed.error.message, /deferred proof/, 'must fail on the deferred proof derivation, not a generic durability check');
  assert.equal(enterpriseMeta.readLifecycleDelivery(prepared.state.context.specDir, PLAN_ID, prepared.state.context).last_applied_revision, 0,
    'tampered deferred proof must not advance the watermark');
  assert.deepEqual(fixture.remote.calls, [], 'tampered deferred proof must make no GitHub call');
});

// RED cycle 4
// Test file: `test/enterprise-phase-closed.test.js`
// Level: unit (phaseBranchFor export) plus targets check through resolvePhasePr
// Test intent: Given plan.phases with phase-1 and phase-2 branches and plan.branch equal to phase-2's, When phaseBranchFor(context, 'phase-1'), Then phase-1's branch. Given a missing key, Then PHASE_BRANCH_REQUIRED.
// Exercise through: phaseBranchFor export; resolvePhasePr for the stacked PR lookup
// Test doubles: none for the helper; fake gh runner counting calls for the targets check
// Expected RED: helper missing
// Exact command: `node --test --test-name-pattern="phaseBranchFor" test/enterprise-phase-closed.test.js`

test('phaseBranchFor returns the exact per-phase branch and rejects a missing key', (t) => {
  const fixture = stackedFixture(t, { planBranch: STACKED_PHASES['phase-2'].branch });
  const context = loadContext(fixture.event, { projectRoot: fixture.root });

  assert.equal(phaseBranchFor(context, 'phase-1'), 'feature/demo-plan-phase-1');
  assert.equal(phaseBranchFor(context, 'phase-2'), 'feature/demo-plan-phase-2');
  assert.throws(() => phaseBranchFor(context, 'phase-3'), { code: 'PHASE_BRANCH_REQUIRED' });
});

test('phaseBranchFor drives the stacked PR lookup in resolvePhasePr', (t) => {
  const fixture = stackedFixture(t, { planBranch: STACKED_PHASES['phase-2'].branch });
  const options = handlerOptions(fixture);
  const context = loadContext(fixture.event, { projectRoot: fixture.root });
  const repo = resolveRepository(options);

  // The seeded PR lives on the plan branch, so it must be rejected and the lookup must use phase-1's branch.
  assert.throws(() => resolvePhasePr(context, { key: 'phase-1', number: 1 }, repo, options), { code: 'PR_MANUAL_RESOLUTION' });
  const search = fixture.remote.calls.find((args) => args[0] === 'pr' && args[1] === 'list');
  assert.equal(search[search.indexOf('--head') + 1], 'feature/demo-plan-phase-1');
});
