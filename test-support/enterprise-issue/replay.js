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

// T8 Cycle 4: successful replay returns persisted issue proof with no mutation.
test('CYCLE 4: succeeded adapter replay returns persisted proof without GitHub or metadata mutation', () => {
  const fixture = makeProject();
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'issue handler must be available');
  const first = runHandler(handler, fixture, makeZeroMatchTransport());
  assert.equal(first.status, 'succeeded');

  const registered = enterpriseRegistration.installRegistration(fixture.projectRoot, {
    argv: [process.execPath, 'unused-adapter.js'],
  });
  assert.equal(registered.ok, true, 'adapter dispatch fixture must be registered');
  const succeededEvent = {
    ...fixture.event,
    proof_ref: first.proof_ref,
    proof_hash: first.proof_hash,
    delivery: { status: 'succeeded', attempts: 1 },
  };
  const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const before = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const replayCalls = [];
  const replay = enterpriseAdapter.dispatchEvent(succeededEvent, {
    projectRoot: fixture.projectRoot,
    coreContract: 3,
    handlers: { 'spec-approved': (event, context) => handler.handleSpecApproved(event, {
      ...context,
      clock: () => new Date(FIXED_TIME),
    }) },
    ghRunner: (args) => {
      replayCalls.push(args.slice());
      return { exit: 1, stdout: '', stderr: 'replay must use persisted issue proof' };
    },
  });

  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.event_id, EVENT_ID);
  assert.equal(replay.proof_ref, first.proof_ref);
  assert.equal(replay.proof_hash, first.proof_hash);
  assert.deepEqual(replayCalls, [], 'persisted proof must be resolved before any GitHub transport call');
  assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, 'utf8')), before,
    'replay must leave real metadata semantically unchanged');
});
