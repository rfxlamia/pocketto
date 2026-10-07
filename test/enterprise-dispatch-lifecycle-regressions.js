'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const enterpriseMeta = require('../enterprise/meta');
const { createLifecycleDelivery } = require('../enterprise/lifecycle-delivery');
const { dispatchEvent } = require('../enterprise/adapter');
const { handlers: registeredHandlers } = require('../enterprise/dispatch');

function assertLifecycleDeliveryPreflightFailure(t, createFixture, planId) {
  const fixture = createFixture(t);
  const physicalRoot = fs.realpathSync(fixture.root);
  const physicalSpecDir = fs.realpathSync(fixture.specDir);
  const metadataPath = path.join(physicalSpecDir, '.pocket-meta.json');
  const originalLstatSync = fs.lstatSync;
  fs.lstatSync = function failMetadataPreflightWithEio(target, ...args) {
    if (typeof target === 'string' && path.resolve(target) === path.resolve(metadataPath)) {
      const error = new Error('injected transient metadata I/O failure');
      error.code = 'EIO';
      throw error;
    }
    return originalLstatSync.call(this, target, ...args);
  };
  let prepared;
  try {
    prepared = createLifecycleDelivery(fixture.root).prepare({
      ...fixture.specEvent,
      delivery: { ...fixture.specEvent.delivery, status: 'succeeded' },
    });
    assert.throws(() => enterpriseMeta.preflightMetaFor(physicalSpecDir, {
      projectRoot: physicalRoot,
      specDir: physicalSpecDir,
    }), { code: 'EIO' });
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(prepared.response.status, 'retryable');
  assert.equal(prepared.response.error.code, 'ADAPTER_LIFECYCLE_DELIVERY_INVALID');
  assert.equal(prepared.response.error.retryable, true);

  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.lifecycle_delivery = { schema: 1, plan_id: planId, last_applied_revision: -1 };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const invalidWatermark = createLifecycleDelivery(fixture.root).prepare(fixture.specEvent);
  assert.equal(invalidWatermark.response.status, 'terminal');
  assert.equal(invalidWatermark.response.error.code, 'ADAPTER_LIFECYCLE_DELIVERY_INVALID');
  assert.equal(invalidWatermark.response.error.retryable, false);
}

function rejectPhasePlanDirectorySymlink(t, helpers) {
  const { createFixture, setLifecycleWatermark, prepareRegisteredRunner, invokeAdapter,
    readCalls, assertBoundedFailure, snapshotTree, PLAN_ID } = helpers;
  const fixture = createFixture(t);
  setLifecycleWatermark(fixture, fixture.phaseEvent.revision - 1);
  const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-dispatch-external-phase-plan-'));
  t.after(() => fs.rmSync(externalParent, { recursive: true, force: true }));
  const externalPlanDir = path.join(externalParent, PLAN_ID);
  fs.cpSync(fixture.planDir, externalPlanDir, { recursive: true });
  const sentinel = 'external phase plan must remain byte-for-byte unchanged\n';
  fs.writeFileSync(path.join(externalPlanDir, 'external-sentinel.txt'), sentinel);
  const externalBefore = snapshotTree(externalPlanDir);
  fs.rmSync(fixture.planDir, { recursive: true, force: true });
  fs.symlinkSync(externalPlanDir, fixture.planDir, 'dir');

  const { tracePath, record } = prepareRegisteredRunner(t, fixture);
  const response = invokeAdapter(fixture.phaseEvent, record);

  assert.equal(readCalls(tracePath).length, 0,
    'an escaping plan_dir must be rejected before the phase handler reaches fake GitHub');
  assertBoundedFailure(response, fixture.phaseEvent);
  assert.equal(response.status, 'terminal');
  assert.equal(response.error.retryable, false);
  assert.equal(response.error.code, 'PHASE_LIFECYCLE_PATH_INVALID');
  assert.equal(fs.readFileSync(path.join(externalPlanDir, 'external-sentinel.txt'), 'utf8'), sentinel);
  assert.deepEqual(snapshotTree(externalPlanDir), externalBefore, 'the external phase plan tree must not be written');
}

function preserveLifecycleContextRetryability(t, helpers) {
  const { createFixture, prepareRegisteredRunner, readCalls } = helpers;
  const fixture = createFixture(t);
  const { tracePath } = prepareRegisteredRunner(t, fixture);
  const lifecyclePath = path.join(fs.realpathSync(fixture.specDir), 'lifecycle.json');
  let lifecycleReadAttempted = false;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function failLifecycleReadWithEio(target, ...args) {
    if (typeof target === 'string' && path.resolve(target) === path.resolve(lifecyclePath)) {
      lifecycleReadAttempted = true;
      const error = new Error('injected transient lifecycle I/O failure');
      error.code = 'EIO';
      throw error;
    }
    return originalReadFileSync.call(this, target, ...args);
  };

  let response;
  try {
    response = dispatchEvent(fixture.phaseEvent, {
      projectRoot: fixture.root,
      coreContract: 3,
      handlers: registeredHandlers,
    });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(lifecycleReadAttempted, true, `expected lifecycle read at ${lifecyclePath}`);
  assert.equal(response.status, 'retryable');
  assert.equal(response.error.retryable, true);
  assert.equal(response.error.code, 'PHASE_LIFECYCLE_UNAVAILABLE');
  assert.equal(readCalls(tracePath).length, 0, 'transient context I/O failure must happen before GitHub calls');
}

module.exports = {
  assertLifecycleDeliveryPreflightFailure,
  preserveLifecycleContextRetryability,
  rejectPhasePlanDirectorySymlink,
};
