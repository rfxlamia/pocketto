'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const enterpriseAdapter = require('../../enterprise/adapter');
const enterpriseRegistration = require('../../enterprise/registration');
const {
  EVENT_ID,
  FIXED_TIME,
  enterpriseMeta,
  loadIssueHandler,
  makeProject,
  makeZeroMatchTransport,
  runHandler,
} = require('./fixtures');

// T8 Cycle 4: successful replay returns Core's persisted delivery proof without mutation.
test('CYCLE 4: succeeded adapter replay returns nested delivery proof without GitHub or metadata mutation', () => {
  const { fixture, handler, first, metadataPath } = createSucceededFixture();
  const succeededEvent = {
    ...fixture.event,
    delivery: {
      status: 'succeeded',
      attempts: 1,
      proof_ref: first.proof_ref,
      proof_hash: first.proof_hash,
    },
  };
  const before = fs.readFileSync(metadataPath, 'utf8');
  const replayCalls = [];
  const replay = dispatchReplay(handler, fixture, succeededEvent, replayCalls);

  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.event_id, EVENT_ID);
  assert.equal(replay.proof_ref, succeededEvent.delivery.proof_ref);
  assert.equal(replay.proof_hash, succeededEvent.delivery.proof_hash);
  assert.deepEqual(replayCalls, [], 'persisted delivery proof must be resolved before any GitHub transport call');
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), before,
    'replay must leave metadata bytes unchanged');
});

test('CYCLE 4: succeeded replay fails closed on missing or mismatched nested proof without fallback', async (t) => {
  for (const scenario of ['missing', 'mismatched']) {
    await t.test(`${scenario} delivery proof is terminal and read-only`, () => {
      const { fixture, handler, first, metadataPath } = createSucceededFixture();
      const delivery = { status: 'succeeded', attempts: 1 };
      if (scenario === 'mismatched') {
        delivery.proof_ref = first.proof_ref;
        delivery.proof_hash = '0'.repeat(64);
      }
      const succeededEvent = {
        ...fixture.event,
        proof_ref: first.proof_ref,
        proof_hash: first.proof_hash,
        delivery,
      };
      const before = fs.readFileSync(metadataPath, 'utf8');
      const replayCalls = [];
      const replay = dispatchReplay(handler, fixture, succeededEvent, replayCalls);

      assert.equal(replay.status, 'terminal', JSON.stringify(replay));
      assert.equal(replay.error.code, 'ISSUE_PROOF_MISMATCH');
      assert.deepEqual(replayCalls, [], 'bad succeeded proof must not fall through to GitHub reconciliation');
      assert.equal(fs.readFileSync(metadataPath, 'utf8'), before,
        'bad succeeded proof must leave metadata bytes unchanged');
    });
  }
});

test('CYCLE 4: claimed delivery enters normal issue reconciliation', (t) => {
  const fixture = makeProject();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  fixture.event.delivery = { status: 'claimed', attempts: 1 };
  const handler = loadIssueHandler();
  const transport = makeZeroMatchTransport();

  const result = runHandler(handler, fixture, transport);

  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.event_id, fixture.event.event_id);
  assert.equal(transport.createdBodies.length, 1, 'claimed attempt must create/reconcile exactly as the normal pending path');
  assert.ok(transport.calls.some((args) => args[0] === 'repo' && args[1] === 'view'));
  assert.ok(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'create'));
});

test('CYCLE 4: terminal and unknown delivery statuses remain ineligible', async (t) => {
  for (const status of ['terminal', 'unknown']) {
    await t.test(`${status} delivery is rejected before issue reconciliation`, (t) => {
      const fixture = makeProject();
      t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
      fixture.event.delivery = { status, attempts: 1 };
      const handler = loadIssueHandler();
      const transport = makeZeroMatchTransport();

      const result = runHandler(handler, fixture, transport);

      assert.equal(result.status, 'terminal', JSON.stringify(result));
      assert.equal(result.error.code, 'ISSUE_DELIVERY_INELIGIBLE');
      assert.deepEqual(transport.calls, []);
    });
  }
});

function createSucceededFixture() {
  const fixture = makeProject();
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'issue handler must be available');
  const first = runHandler(handler, fixture, makeZeroMatchTransport());
  assert.equal(first.status, 'succeeded');

  const registered = enterpriseRegistration.installRegistration(fixture.projectRoot, {
    argv: [process.execPath, 'unused-adapter.js'],
  });
  assert.equal(registered.ok, true, 'adapter dispatch fixture must be registered');
  return {
    fixture,
    handler,
    first,
    metadataPath: enterpriseMeta.resolveMetaPath(fixture.specDir),
  };
}

function dispatchReplay(handler, fixture, event, replayCalls) {
  return enterpriseAdapter.dispatchEvent(event, {
    projectRoot: fixture.projectRoot,
    coreContract: 3,
    handlers: { 'spec-approved': (candidate, context) => handler.handleSpecApproved(candidate, {
      ...context,
      clock: () => new Date(FIXED_TIME),
    }) },
    ghRunner: (args) => {
      replayCalls.push(args.slice());
      return { exit: 1, stdout: '', stderr: 'replay must use validated delivery proof' };
    },
  });
}
