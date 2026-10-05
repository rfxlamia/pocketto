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

function installRegisteredEnterpriseReadFaultGate(fixture) {
  const hookPath = path.join(fixture.root, 'registered-enterprise-read-fault-gate.js');
  const hitPath = path.join(fixture.root, 'registered-enterprise-read-fault.hit');
  const dispatchPath = path.resolve(__dirname, '../../../enterprise/dispatch.js');
  writeFile(hookPath, `const fs = require('node:fs');
const path = require('node:path');
const originalReadFileSync = fs.readFileSync;
const expectedPath = fs.realpathSync(process.env.LIFECYCLE_ENTERPRISE_READ_FAILURE_PATH);
const expectedDispatch = path.resolve(process.env.LIFECYCLE_ENTERPRISE_DISPATCH_PATH);
let injected = false;
fs.readFileSync = function(target, ...args) {
  const fromRegisteredEnterprise = typeof process.argv[1] === 'string'
    && path.resolve(process.argv[1]) === expectedDispatch;
  if (!injected && fromRegisteredEnterprise && typeof target === 'string'
      && path.resolve(target) === expectedPath) {
    injected = true;
    fs.writeFileSync(process.env.LIFECYCLE_ENTERPRISE_READ_FAILURE_HIT_FILE, JSON.stringify({
      code: 'EIO', executable: path.resolve(process.argv[1]), target: path.resolve(target),
    }));
    const error = new Error('injected registered Enterprise read failure');
    error.code = 'EIO';
    throw error;
  }
  return originalReadFileSync.call(this, target, ...args);
};
`);
  return { hookPath, hitPath, dispatchPath };
}

function installRegisteredEnterprisePathFaultGate(fixture) {
  const hookPath = path.join(fixture.root, 'registered-enterprise-path-fault-gate.js');
  const hitPath = path.join(fixture.root, 'registered-enterprise-path-fault.hit');
  const dispatchPath = path.resolve(__dirname, '../../../enterprise/dispatch.js');
  writeFile(hookPath, `const fs = require('node:fs');
const path = require('node:path');
const originalRealpathSync = fs.realpathSync;
const originalStatSync = fs.statSync;
const originalWriteFileSync = fs.writeFileSync;
const expectedRoot = originalRealpathSync(path.resolve(process.env.LIFECYCLE_ENTERPRISE_PATH_FAILURE_ROOT));
const expectedMethod = process.env.LIFECYCLE_ENTERPRISE_PATH_FAILURE_METHOD;
const expectedDispatch = path.resolve(process.env.LIFECYCLE_ENTERPRISE_DISPATCH_PATH);
let injected = false;
function shouldInject(method, target) {
  const fromRegisteredEnterprise = typeof process.argv[1] === 'string'
    && path.resolve(process.argv[1]) === expectedDispatch;
  const stack = new Error().stack || '';
  return !injected && method === expectedMethod && fromRegisteredEnterprise
    && typeof target === 'string' && path.resolve(target) === expectedRoot
    && stack.includes('resolvePlanArtifactPath');
}
function inject(method, target) {
  injected = true;
  originalWriteFileSync.call(fs, process.env.LIFECYCLE_ENTERPRISE_PATH_FAILURE_HIT_FILE, JSON.stringify({
    code: 'EIO', executable: path.resolve(process.argv[1]), method, target: path.resolve(target),
  }));
  const error = new Error('injected registered Enterprise path-resolution failure');
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
`);
  return { hookPath, hitPath, dispatchPath };
}

function installLifecycleWatermarkWriteFaultGate(fixture) {
  const hookPath = path.join(fixture.root, 'lifecycle-watermark-write-fault-gate.js');
  const hitPath = path.join(fixture.root, 'lifecycle-watermark-write-fault.hit');
  writeFile(hookPath, `const fs = require('node:fs');
const path = require('node:path');
const originalWriteFileSync = fs.writeFileSync;
const expectedMetaPath = fs.realpathSync(process.env.LIFECYCLE_WATERMARK_FAULT_META_PATH);
const expectedRevision = Number(process.env.LIFECYCLE_WATERMARK_FAULT_REVISION);
const tempPrefix = '.' + path.basename(expectedMetaPath) + '.tmp-';
let injected = false;
fs.writeFileSync = function(target, data, ...args) {
  const targetPath = typeof target === 'string' ? path.resolve(target) : null;
  const isMetadataReplacement = targetPath === expectedMetaPath
    || (targetPath && path.dirname(targetPath) === path.dirname(expectedMetaPath)
      && path.basename(targetPath).startsWith(tempPrefix));
  if (!injected && isMetadataReplacement) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let replacement;
    try { replacement = JSON.parse(text); } catch { /* Not a metadata replacement. */ }
    if (replacement && replacement.lifecycle_delivery
        && replacement.lifecycle_delivery.last_applied_revision === expectedRevision) {
      injected = true;
      originalWriteFileSync.call(this, target, '', ...args);
      originalWriteFileSync.call(fs, process.env.LIFECYCLE_WATERMARK_FAULT_HIT_FILE, 'revision-' + expectedRevision);
      const error = new Error('injected lifecycle watermark write failure');
      error.code = 'EIO';
      throw error;
    }
  }
  return originalWriteFileSync.call(this, target, data, ...args);
};
`);
  return { hookPath, hitPath };
}

function installLifecycleHandlerCallTraceGate(fixture) {
  const hookPath = path.join(fixture.root, 'lifecycle-handler-call-trace-gate.js');
  const tracePath = path.join(fixture.root, 'lifecycle-handler-calls.jsonl');
  writeFile(hookPath, `const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== './phase-handler' || !parent
      || !parent.filename.endsWith(path.join('enterprise', 'dispatch.js'))
      || !loaded || typeof loaded.handlePhaseComplete !== 'function') return loaded;
  return {
    ...loaded,
    handlePhaseComplete(event, ...args) {
      fs.appendFileSync(process.env.LIFECYCLE_HANDLER_TRACE_FILE, JSON.stringify({
        event_id: event.event_id,
        revision: event.revision,
        status: event.delivery.status,
      }) + '\\n');
      return loaded.handlePhaseComplete(event, ...args);
    },
  };
};
`);
  return { hookPath, tracePath };
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

module.exports = {
  installLedgerFaultGate,
  installArtifactReadFaultGate,
  installRegisteredEnterpriseReadFaultGate,
  installRegisteredEnterprisePathFaultGate,
  installLifecycleWatermarkWriteFaultGate,
  installLifecycleHandlerCallTraceGate,
  installStaleCandidateGate,
};
