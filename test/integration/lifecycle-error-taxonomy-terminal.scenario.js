'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { invokeAdapter, readAdapterRegistration } = require('../../cli/lib/lifecycle-adapter');
const { FIXED_NOW, PHASE_PATH, PLAN_ID } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');

const ENTERPRISE_DISPATCH = path.resolve(__dirname, '../../enterprise/dispatch.js');
const METADATA_PATH = '.pocket-meta.json';
const PHASE_PROOF_PATH = ['phases', 'phase-1', 'review', 'proof'];
const CLOSURE_PROOF_PATH = ['github_issue', 'tasklist'];

const {
  preparePendingPhaseEvent,
  preparePendingClosureEvent,
  installRegisteredPathFaultGate,
  assertRegisteredFault,
  invokeRegistered,
  withEnvironment,
  drain,
  assertEventAttempt,
  assertWatermark,
  assertPhaseProofAndSingleRemoteEffect,
  readMetadata,
  readMetadataBytes,
  nestedValue,
} = require('./lifecycle-error-taxonomy.helpers.js');

test('registered spec-approved classifies a cyclic artifact symlink as terminal ELOOP', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  transitionApprovedSpec(fixture);
  const event = readLifecycle(fixture).events.find(({ type }) => type === 'spec-approved');
  const artifactPath = path.join(fixture.specDir, 'approved-spec.md');
  const originalMetadata = readMetadataBytes(fixture);
  const remoteBefore = readRemote(fixture);
  fs.rmSync(artifactPath);
  fs.symlinkSync('approved-spec.md', artifactPath, 'file');

  const response = invokeRegistered(fixture, event, fixture.env);

  assert.equal(response.event_id, event.event_id, 'adapter must preserve the original event ID');
  assert.equal(response.status, 'terminal');
  assert.equal(response.error.retryable, false);
  assert.equal(response.error.code, 'STALE_ARTIFACT');
  assert.deepEqual(readRemote(fixture), remoteBefore, 'a cyclic artifact path must not invoke GitHub');
  assert.deepEqual(readMetadataBytes(fixture), originalMetadata, 'a cyclic artifact path must not write proof or watermark');
  assertEventAttempt(fixture, event.event_id, 'pending', 0);
  assert.equal(readMetadata(fixture).lifecycle_delivery, undefined);
  assert.equal(readMetadata(fixture).github_issue.ownership, undefined);
});

test('plan-closed keeps missing and malformed final plan logs terminal and read-only', async (t) => {
  const cases = [
    {
      name: 'missing final plan log',
      alter(planDir) { fs.rmSync(path.join(planDir, 'log.json')); },
    },
    {
      name: 'malformed final plan log',
      alter(planDir) { fs.writeFileSync(path.join(planDir, 'log.json'), '{'); },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, (t) => {
      const fixture = createFixture(t);
      const event = preparePendingClosureEvent(fixture);
      const remoteBefore = readRemote(fixture);
      const metadataBefore = readMetadataBytes(fixture);
      scenario.alter(fixture.planDir);

      const result = assertCliOk(drain(fixture), `plan-closed with ${scenario.name}`);
      const failure = result.deliveries.find(({ event_id }) => event_id === event.event_id);
      assert.ok(failure, `Core must retain and report ${event.event_id}`);
      assert.equal(failure.status, 'terminal');
      assert.equal(failure.error.retryable, false);
      assert.equal(failure.error.code, 'PLAN_STATE_UNAVAILABLE');
      assertEventAttempt(fixture, event.event_id, 'terminal', 1);
      assert.deepEqual(readRemote(fixture), remoteBefore, 'invalid final plan evidence must not reach GitHub');
      assert.deepEqual(readMetadataBytes(fixture), metadataBefore, 'invalid final plan evidence must not write proof or watermark');
      assert.equal(nestedValue(readMetadata(fixture), CLOSURE_PROOF_PATH), undefined);
      assertWatermark(fixture, 2);
    });
  }
});
