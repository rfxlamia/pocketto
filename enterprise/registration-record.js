'use strict';

// Owns the neutral, filesystem-backed adapter registration record.
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomicSync } = require('../cli/lib/atomic-file');
const { EVENT_TYPES } = require('../cli/lib/lifecycle-contract');
const { MAX_ADAPTER_TIMEOUT_MS } = require('../cli/lib/lifecycle-adapter');

let CORE_VERSION = null;
let CORE_VERSION_PATH = null;
try {
  CORE_VERSION_PATH = require.resolve('../cli/lib/version');
  CORE_VERSION = require(CORE_VERSION_PATH);
} catch {
  CORE_VERSION = null;
  CORE_VERSION_PATH = null;
}

const REGISTRATION_SCHEMA = 1;
const ADAPTER_CONTRACT = 1;
const REGISTRATION_DIR = '.pocket';
const REGISTRATION_FILE = 'lifecycle-adapter.json';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = MAX_ADAPTER_TIMEOUT_MS;
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

function validateRegistrationShape(record) {
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
  return null;
}

function validateRegistrationSchema(record) {
  if (record.schema !== REGISTRATION_SCHEMA) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      `Adapter registration schema ${record.schema} is unsupported (expected ${REGISTRATION_SCHEMA}). Re-run enterprise install to repair it.`
    );
  }
  return null;
}

function validateAdapterContract(record) {
  const expectedContract = CORE_VERSION ? CORE_VERSION.ADAPTER_CONTRACT : ADAPTER_CONTRACT;
  if (record.adapter_contract !== expectedContract) {
    return fail(
      'ENTERPRISE_ADAPTER_CONTRACT_MISMATCH',
      `Adapter contract ${record.adapter_contract} is incompatible with Enterprise adapter contract ${expectedContract}. Upgrade Enterprise to a matching release; the event stays pending.`
    );
  }
  return null;
}

function validateRegistrationArgv(record) {
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
  return null;
}

function validateRegistrationEvents(record) {
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
  return null;
}

function validateRegistrationTimeout(record) {
  if (!Number.isInteger(record.timeout_ms) || record.timeout_ms <= 0 || record.timeout_ms > MAX_TIMEOUT_MS) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration timeout_ms must be a positive integer within the supported bound. Re-run enterprise install to repair it.'
    );
  }
  return null;
}

function validateRegistration(record) {
  const shapeFailure = validateRegistrationShape(record);
  if (shapeFailure) return shapeFailure;
  for (const validate of [
    validateRegistrationSchema,
    validateAdapterContract,
    validateRegistrationArgv,
    validateRegistrationEvents,
    validateRegistrationTimeout,
  ]) {
    const failure = validate(record);
    if (failure) return failure;
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
  } catch {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration is not valid JSON (partial installation?). Re-run enterprise install to repair it.'
    );
  }
  const checked = validateRegistration(parsed);
  if (!checked.ok) return checked;
  return { ok: true, code: null, message: null, record: parsed, path: target };
}

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

module.exports = {
  ADAPTER_CONTRACT,
  CORE_VERSION,
  CORE_VERSION_PATH,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  REGISTRATION_DIR,
  REGISTRATION_FIELDS,
  REGISTRATION_FILE,
  REGISTRATION_SCHEMA,
  buildRegistration,
  fail,
  installRegistration,
  isPlainObject,
  loadRegistration,
  registrationPathFor,
  validateRegistration,
};
