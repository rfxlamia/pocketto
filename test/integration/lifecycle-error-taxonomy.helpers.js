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

function preparePendingPhaseEvent(fixture) {
  initializePlan(fixture);
  const approved = transitionApprovedSpec(fixture);
  const accepted = assertCliOk(drain(fixture), 'registered spec-approved setup delivery');
  assert.deepEqual(accepted.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: approved.event_id, status: 'succeeded' },
  ]);
  assertWatermark(fixture, 1);
  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'REVIEW', '--json', '--contract', '3',
  ]);
  assert.equal(assertCliOk(review, 'public phase-complete emitter').event.event_id, `${PLAN_ID}:phase-complete:r2`);
  const event = readLifecycle(fixture).events.find(({ type }) => type === 'phase-complete');
  assert.equal(event.event_id, `${PLAN_ID}:phase-complete:r2`);
  return event;
}

function preparePendingClosureEvent(fixture) {
  const phaseEvent = preparePendingPhaseEvent(fixture);
  const phaseResult = assertCliOk(drain(fixture), 'registered phase-complete setup delivery');
  assert.deepEqual(phaseResult.deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: phaseEvent.event_id, status: 'succeeded' },
  ]);
  assertWatermark(fixture, 2);

  assertCliOk(runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'DONE', '--json', '--contract', '3',
  ]), 'public phase completion emitter');
  const close = runCore(fixture, ['log', 'close', fixture.planDir, '--json', '--contract', '3']);
  assert.equal(assertCliOk(close, 'public plan-closed emitter').event.event_id, `${PLAN_ID}:plan-closed:r3`);
  const event = readLifecycle(fixture).events.find(({ type }) => type === 'plan-closed');
  assert.equal(event.event_id, `${PLAN_ID}:plan-closed:r3`);
  return event;
}

function installRegisteredPathFaultGate(fixture, { method, targetPath, readWatchPath = '' }) {
  const hookPath = path.join(fixture.root, 'registered-enterprise-context-fault.js');
  const hitPath = path.join(fixture.root, 'registered-enterprise-context-fault.json');
  const readTracePath = path.join(fixture.root, 'registered-enterprise-context-reads.jsonl');
  fs.writeFileSync(hookPath, `const fs = require('node:fs');
const path = require('node:path');
const originalRealpathSync = fs.realpathSync;
const originalStatSync = fs.statSync;
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const expectedTarget = path.resolve(process.env.LIFECYCLE_CONTEXT_FAULT_TARGET);
const expectedMethod = process.env.LIFECYCLE_CONTEXT_FAULT_METHOD;
const expectedDispatch = path.resolve(process.env.LIFECYCLE_CONTEXT_FAULT_DISPATCH);
const watchedPath = process.env.LIFECYCLE_CONTEXT_READ_WATCH
  ? path.resolve(process.env.LIFECYCLE_CONTEXT_READ_WATCH) : null;
let injected = false;
function fromRegisteredEnterprise() {
  return typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === expectedDispatch;
}
function shouldInject(method, target) {
  return !injected && fromRegisteredEnterprise() && method === expectedMethod
    && typeof target === 'string' && path.resolve(target) === expectedTarget;
}
function inject(method, target) {
  injected = true;
  originalWriteFileSync.call(fs, process.env.LIFECYCLE_CONTEXT_FAULT_HIT, JSON.stringify({
    code: 'EIO', executable: path.resolve(process.argv[1]), method, target: path.resolve(target),
  }));
  const error = new Error('injected registered Enterprise filesystem EIO');
  error.code = 'EIO';
  throw error;
}
fs.realpathSync = function(target, ...args) {
  if (shouldInject('realpathSync', target)) return inject('realpathSync', target);
  return originalRealpathSync.call(this, target, ...args);
};
fs.statSync = function(target, ...args) {
  if (shouldInject('statSync', target)) return inject('statSync', target);
  return originalStatSync.call(this, target, ...args);
};
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function(target, ...args) {
  if (fromRegisteredEnterprise() && watchedPath && typeof target === 'string'
      && path.resolve(target) === watchedPath) {
    originalAppendFileSync.call(fs, process.env.LIFECYCLE_CONTEXT_READ_TRACE,
      JSON.stringify({ method: 'readFileSync', target: path.resolve(target) }) + '\\n');
  }
  return originalReadFileSync.call(this, target, ...args);
};
`);
  fs.rmSync(hitPath, { force: true });
  fs.writeFileSync(readTracePath, '');
  return {
    method,
    targetPath,
    hookPath,
    hitPath,
    readTracePath,
    environment: {
      ...fixture.env,
      NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${hookPath}`].filter(Boolean).join(' '),
      LIFECYCLE_CONTEXT_FAULT_TARGET: targetPath,
      LIFECYCLE_CONTEXT_FAULT_METHOD: method,
      LIFECYCLE_CONTEXT_FAULT_DISPATCH: ENTERPRISE_DISPATCH,
      LIFECYCLE_CONTEXT_FAULT_HIT: hitPath,
      LIFECYCLE_CONTEXT_READ_WATCH: readWatchPath,
      LIFECYCLE_CONTEXT_READ_TRACE: readTracePath,
    },
  };
}

function assertRegisteredFault(gate, commandResult) {
  assert.equal(fs.existsSync(gate.hitPath), true,
    `registered Enterprise ${gate.method} EIO must be injected: ${commandResult.stdout || JSON.stringify(commandResult)}`);
  const injection = JSON.parse(fs.readFileSync(gate.hitPath, 'utf8'));
  assert.equal(injection.code, 'EIO');
  assert.equal(injection.executable, ENTERPRISE_DISPATCH);
  assert.equal(injection.method, gate.method);
  assert.equal(injection.target, path.resolve(gate.targetPath));
}

function invokeRegistered(fixture, event, environment) {
  const loaded = readAdapterRegistration(fixture.root);
  assert.equal(loaded.error, null, loaded.error && loaded.error.message);
  assert.ok(loaded.registration, 'test requires the real installed Enterprise registration');
  return withEnvironment(environment, () => invokeAdapter(event, loaded.registration));
}

function withEnvironment(environment, callback) {
  const previous = new Map(Object.keys(process.env).map((key) => [key, process.env[key]]));
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(environment, key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(environment)) process.env[key] = String(value);
  try {
    return callback();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of previous) process.env[key] = value;
  }
}

function drain(fixture, environment = fixture.env) {
  return runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'], environment);
}

function assertEventAttempt(fixture, eventId, status, attempts) {
  const event = readLifecycle(fixture).events.find((entry) => entry.event_id === eventId);
  assert.ok(event, `Core journal must retain ${eventId}`);
  assert.equal(event.event_id, eventId);
  assert.equal(event.delivery.status, status);
  assert.equal(event.delivery.attempts, attempts);
}

function assertWatermark(fixture, revision) {
  assert.equal(readMetadata(fixture).lifecycle_delivery.last_applied_revision, revision);
}

function assertPhaseProofAndSingleRemoteEffect(fixture, eventId, remoteBefore) {
  const proof = nestedValue(readMetadata(fixture), PHASE_PROOF_PATH);
  assert.equal(proof.event_id, eventId);
  assert.equal(proof.plan_id, PLAN_ID);
  assert.equal(proof.phase_key, 'phase-1');
  assert.match(proof.proof_hash, /^[0-9a-f]{64}$/);
  const event = readLifecycle(fixture).events.find((entry) => entry.event_id === eventId);
  assert.equal(event.delivery.proof_ref, proof.proof_ref);
  assert.equal(event.delivery.proof_hash, proof.proof_hash);
  const remote = readRemote(fixture);
  assert.deepEqual(remote.effects.slice(remoteBefore.effects.length).map(({ kind }) => kind), ['phase-summary-create']);
  assert.equal(remote.comments['84'].filter(({ body }) => body.startsWith('<!-- pocket-phase-1-summary -->')).length, 1);
}

function readMetadata(fixture) {
  return JSON.parse(readMetadataBytes(fixture).toString('utf8'));
}

function readMetadataBytes(fixture) {
  return fs.readFileSync(path.join(fixture.specDir, METADATA_PATH));
}

function nestedValue(value, keys) {
  return keys.reduce((current, key) => current && current[key], value);
}

module.exports = {
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
};
