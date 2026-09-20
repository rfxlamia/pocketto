'use strict';

// Enterprise-owned registered adapter installation record (T7, Cycle 1).
//
// Enterprise installs `<project-root>/.pocket/lifecycle-adapter.json`
// atomically via T2's file primitive. The record carries ONLY the neutral
// registration fields Core may see: schema version, adapter contract,
// executable argv, event allowlist, and timeout. Every GitHub ID,
// credential, `gh` invocation, remote ownership rule, and Enterprise policy
// lives in other Enterprise-only files — never here.
//
// Preflight is fail-closed: missing/incompatible Core, malformed or partial
// registration, or a missing executable all return an actionable
// upgrade/install error, write no partial Enterprise state, and make zero
// GitHub calls (the injected gh runner is never touched by preflight).

const fs = require('node:fs');
const path = require('node:path');

const { writeFileAtomicSync } = require('../cli/lib/atomic-file');
const { EVENT_TYPES } = require('../cli/lib/lifecycle-contract');

let CORE_VERSION = null;
try {
  CORE_VERSION = require('../cli/lib/version');
} catch (_) {
  CORE_VERSION = null;
}

const REGISTRATION_SCHEMA = 1;
const ADAPTER_CONTRACT = 1;
const REGISTRATION_DIR = '.pocket';
const REGISTRATION_FILE = 'lifecycle-adapter.json';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 600000;
const REGISTRATION_FIELDS = ['schema', 'adapter_contract', 'argv', 'events', 'timeout_ms'];

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function registrationPathFor(projectRoot) {
  return path.join(projectRoot, REGISTRATION_DIR, REGISTRATION_FILE);
}

function buildRegistration({ argv, events = EVENT_TYPES.slice(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return {
    schema: REGISTRATION_SCHEMA,
    adapter_contract: ADAPTER_CONTRACT,
    argv: Array.isArray(argv) ? argv.slice() : argv,
    events: Array.isArray(events) ? events.slice() : events,
    timeout_ms: timeoutMs,
  };
}

// Real registration validator: allowlist-only, fail-closed.
function validateRegistration(record) {
  if (!isPlainObject(record)) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration must be an object. Re-run enterprise install to repair it.'
    );
  }
  for (const key of Object.keys(record)) {
    if (!REGISTRATION_FIELDS.includes(key)) {
      return fail(
        'ENTERPRISE_REGISTRATION_MALFORMED',
        `Adapter registration has unsupported field "${key}". Re-run enterprise install to repair it.`
      );
    }
  }
  for (const key of REGISTRATION_FIELDS) {
    if (!(key in record)) {
      return fail(
        'ENTERPRISE_REGISTRATION_MALFORMED',
        `Adapter registration is missing field "${key}". Re-run enterprise install to repair it.`
      );
    }
  }
  if (record.schema !== REGISTRATION_SCHEMA) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      `Adapter registration schema ${record.schema} is unsupported (expected ${REGISTRATION_SCHEMA}). Re-run enterprise install to repair it.`
    );
  }
  const expectedContract = CORE_VERSION ? CORE_VERSION.ADAPTER_CONTRACT : ADAPTER_CONTRACT;
  if (record.adapter_contract !== expectedContract) {
    return fail(
      'ENTERPRISE_ADAPTER_CONTRACT_MISMATCH',
      `Adapter contract ${record.adapter_contract} is incompatible with Enterprise adapter contract ${expectedContract}. Upgrade Enterprise to a matching release; the event stays pending.`
    );
  }
  if (!Array.isArray(record.argv) || record.argv.length === 0) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration argv must be a non-empty executable argv. Re-run enterprise install to repair it.'
    );
  }
  for (const entry of record.argv) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return fail(
        'ENTERPRISE_REGISTRATION_MALFORMED',
        'Adapter registration argv entries must be non-empty strings. Re-run enterprise install to repair it.'
      );
    }
  }
  if (!Array.isArray(record.events) || record.events.length === 0) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration events must be a non-empty allowlist. Re-run enterprise install to repair it.'
    );
  }
  for (const type of record.events) {
    if (!EVENT_TYPES.includes(type)) {
      return fail(
        'ENTERPRISE_REGISTRATION_MALFORMED',
        `Adapter registration lists unsupported event "${type}". Re-run enterprise install to repair it.`
      );
    }
  }
  if (!Number.isInteger(record.timeout_ms) || record.timeout_ms <= 0 || record.timeout_ms > MAX_TIMEOUT_MS) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration timeout_ms must be a positive integer within the supported bound. Re-run enterprise install to repair it.'
    );
  }
  return { ok: true, code: null, message: null };
}

function loadRegistration(projectRoot, deps = {}) {
  const readFile = deps.readFile || fs.readFileSync;
  const target = registrationPathFor(projectRoot);
  let raw;
  try {
    raw = readFile(target, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return fail(
        'ENTERPRISE_NOT_INSTALLED',
        'Enterprise adapter is not installed for this project. Run enterprise install to register it; Core execution is unaffected.'
      );
    }
    return fail(
      'ENTERPRISE_REGISTRATION_UNREADABLE',
      `Adapter registration cannot be read: ${err && err.message ? err.message : String(err)}`
    );
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration is empty or truncated. Re-run enterprise install to repair it.'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration is not valid JSON (partial installation?). Re-run enterprise install to repair it.'
    );
  }
  const checked = validateRegistration(parsed);
  if (!checked.ok) return checked;
  return { ok: true, code: null, message: null, record: parsed, path: target };
}

function defaultCoreInfo() {
  if (!CORE_VERSION) {
    return { present: false, contract: null, lifecycleSchema: null, adapterContract: null };
  }
  return {
    present: true,
    contract: CORE_VERSION.CONTRACT,
    lifecycleSchema: CORE_VERSION.LIFECYCLE_SCHEMA,
    adapterContract: CORE_VERSION.ADAPTER_CONTRACT,
  };
}

// Atomically installs the registration record using T2's file primitive.
// Never invokes GitHub. On filesystem failure reports without leaving a
// partial registration file or temp orphan (T2 primitive cleans up).
function installRegistration(projectRoot, opts = {}) {
  const writeAtomic = opts.writeAtomic || ((target, content) => writeFileAtomicSync(target, content));
  const mkdir = opts.mkdir || fs.mkdirSync;
  const record = buildRegistration({ argv: opts.argv, events: opts.events, timeoutMs: opts.timeoutMs });
  const checked = validateRegistration(record);
  if (!checked.ok) {
    return fail(
      'ENTERPRISE_INSTALL_FAILED',
      `Refusing to install an invalid adapter registration: ${checked.message}`
    );
  }
  const dir = path.join(projectRoot, REGISTRATION_DIR);
  const target = path.join(dir, REGISTRATION_FILE);
  const content = JSON.stringify(record, null, 2) + '\n';
  try {
    mkdir(dir, { recursive: true });
    writeAtomic(target, content);
  } catch (err) {
    return fail(
      'ENTERPRISE_INSTALL_FAILED',
      `Enterprise adapter install failed with no partial state written: ${err && err.message ? err.message : String(err)}`
    );
  }
  return { ok: true, code: null, message: null, path: target, record };
}

// Fail-closed preflight. Read-only: writes no Enterprise state and never
// calls the injected gh runner on any path (success or failure). Callers
// may pass a recording gh runner to prove zero remote calls.
function preflight(projectRoot, deps = {}) {
  const getCoreInfo = deps.getCoreInfo || defaultCoreInfo;
  const exists = deps.exists || fs.existsSync;

  let core;
  try {
    core = getCoreInfo();
  } catch (err) {
    return fail(
      'ENTERPRISE_CORE_MISSING',
      `Core installation cannot be verified: ${err && err.message ? err.message : String(err)} Install a compatible Core first.`
    );
  }
  if (!core || core.present !== true) {
    return fail(
      'ENTERPRISE_CORE_MISSING',
      'No compatible Core installation was found. Install Core v4 first, then re-run enterprise preflight. No GitHub calls were made.'
    );
  }
  const expectedContract = CORE_VERSION ? CORE_VERSION.CONTRACT : 3;
  const expectedSchema = CORE_VERSION ? CORE_VERSION.LIFECYCLE_SCHEMA : 1;
  if (core.contract !== expectedContract || (core.lifecycleSchema != null && core.lifecycleSchema !== expectedSchema)) {
    return fail(
      'ENTERPRISE_CORE_INCOMPATIBLE',
      `Core contract ${core.contract}/schema ${core.lifecycleSchema} is incompatible with Enterprise (expected contract ${expectedContract}/schema ${expectedSchema}). Upgrade Core to v4; Core remains usable and no GitHub calls were made.`
    );
  }

  const loaded = loadRegistration(projectRoot, deps);
  if (!loaded.ok) return loaded;

  // The executable check is local-filesystem only — never a remote call.
  // Bare command names resolve via PATH at dispatch; only explicit file
  // paths are existence-checked here.
  const argv0 = loaded.record.argv[0];
  if (argv0.includes('/') || argv0.includes(path.sep) || argv0.endsWith('.js')) {
    let resolved = argv0;
    if (!path.isAbsolute(resolved)) {
      resolved = path.resolve(projectRoot, resolved);
    }
    let present = false;
    try {
      present = exists(resolved);
    } catch (_) {
      present = false;
    }
    if (!present) {
      return fail(
        'ENTERPRISE_ADAPTER_UNAVAILABLE',
        `Registered adapter executable is missing: ${argv0}. Re-run enterprise install; the event stays pending and no GitHub calls were made.`
      );
    }
  }

  return {
    ok: true,
    code: null,
    message: null,
    record: loaded.record,
    path: loaded.path,
    core,
  };
}

module.exports = {
  REGISTRATION_SCHEMA,
  ADAPTER_CONTRACT,
  REGISTRATION_DIR,
  REGISTRATION_FILE,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  REGISTRATION_FIELDS,
  registrationPathFor,
  buildRegistration,
  validateRegistration,
  loadRegistration,
  installRegistration,
  preflight,
};
