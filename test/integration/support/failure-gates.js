'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeFile } = require('./files');

function installLedgerFaultGate(fixture) {
  const hookPath = path.join(fixture.root, 'ledger-fault-gate.js');
  const hitPath = path.join(fixture.root, 'ledger-fault.hit');
  writeFile(hookPath, `const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
let injected = false;
Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== './lifecycle-store' || !parent || !parent.filename.endsWith('/cli/lib/lifecycle-drain.js')) return loaded;
  return {
    ...loaded,
    updateEventDelivery(specDir, eventId, patch) {
      if (!injected && eventId === process.env.LIFECYCLE_LEDGER_FAULT_EVENT_ID && patch.status === 'succeeded') {
        injected = true;
        fs.writeFileSync(process.env.LIFECYCLE_LEDGER_FAULT_HIT_FILE, process.env.LIFECYCLE_LEDGER_FAULT_MODE);
        if (process.env.LIFECYCLE_LEDGER_FAULT_MODE === 'crash-before-success-write') process.kill(process.pid, 'SIGKILL');
        if (process.env.LIFECYCLE_LEDGER_FAULT_MODE === 'timeout-before-success-write') {
          return { ok: false, code: 'TEST_LEDGER_TIMEOUT', message: 'injected lifecycle ledger timeout' };
        }
      }
      return loaded.updateEventDelivery(specDir, eventId, patch);
    },
  };
};
`);
  return { hookPath, hitPath };
}

function installArtifactReadFaultGate(fixture) {
  const hookPath = path.join(fixture.root, 'artifact-read-fault-gate.js');
  const hitPath = path.join(fixture.root, 'artifact-read-fault.hit');
  writeFile(hookPath, `const fs = require('node:fs');
const path = require('node:path');
const originalReadFileSync = fs.readFileSync;
const expectedPath = path.resolve(process.env.LIFECYCLE_ARTIFACT_READ_FAILURE_PATH);
const realExpectedPath = fs.realpathSync(expectedPath);
let injected = false;
fs.readFileSync = function(target, ...args) {
  if (!injected && typeof target === 'string'
      && (path.resolve(target) === expectedPath || fs.realpathSync(target) === realExpectedPath)) {
    injected = true;
    fs.writeFileSync(process.env.LIFECYCLE_ARTIFACT_READ_FAILURE_HIT_FILE, 'EIO');
    const error = new Error('injected temporary artifact read failure');
    error.code = 'EIO';
    throw error;
  }
  return originalReadFileSync.call(this, target, ...args);
};
`);
  return { hookPath, hitPath };
}

function installStaleCandidateGate(fixture, workerId = 'stale-candidate') {
  const hookPath = path.join(fixture.root, 'stale-candidate-gate.js');
  const readyPath = path.join(fixture.root, `${workerId}.ready`);
  const releasePath = path.join(fixture.root, `${workerId}.release`);
  writeFile(hookPath, `const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
let paused = false;
Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== './lifecycle-claims' || !parent || !parent.filename.endsWith('/cli/lib/lifecycle-drain.js')) return loaded;
  return {
    ...loaded,
    acquireEventClaim(specDir, planId, eventId) {
      if (!paused && eventId === process.env.STALE_QUEUE_EVENT_ID) {
        paused = true;
        fs.writeFileSync(process.env.STALE_QUEUE_READY_FILE, eventId);
        const signal = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(process.env.STALE_QUEUE_RELEASE_FILE)) Atomics.wait(signal, 0, 0, 10);
      }
      return loaded.acquireEventClaim(specDir, planId, eventId);
    },
  };
};
`);
  return { hookPath, readyPath, releasePath };
}

module.exports = { installLedgerFaultGate, installArtifactReadFaultGate, installStaleCandidateGate };
