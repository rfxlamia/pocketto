'use strict';

// Owns the neutral, filesystem-backed adapter registration record.
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomicSync } = require('../cli/lib/atomic-file');
const { EVENT_TYPES } = require('../cli/lib/lifecycle-contract');
const { MAX_ADAPTER_TIMEOUT_MS } = require('../cli/lib/lifecycle-adapter');
const { detectMode } = require('../cli/lib/mode');

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
const ADAPTER_CONTRACT = 2;
const REGISTRATION_DIR = '.pocket';
const REGISTRATION_FILE = 'lifecycle-adapter.json';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = MAX_ADAPTER_TIMEOUT_MS;
const REGISTRATION_FIELDS = ['schema', 'adapter_contract', 'argv', 'events', 'timeout_ms'];
// Optional neutral fields. Validation stays closed: any other key is rejected.
const OPTIONAL_REGISTRATION_FIELDS = ['phase_branches', 'push_consent'];
const PHASE_BRANCHES_MODES = ['stacked', 'none'];
// The only push consent a registration may carry. Consent never permits force.
const PUSH_CONSENT_PHASE_BRANCHES = Object.freeze({ scope: 'pocket-phase-branches', force: false });

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function registrationPathFor(projectRoot) {
  return path.join(projectRoot, REGISTRATION_DIR, REGISTRATION_FILE);
}

function buildRegistration({
  argv,
  events = EVENT_TYPES.slice(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  phaseBranches,
  pushConsent,
} = {}) {
  const record = {
    schema: REGISTRATION_SCHEMA,
    adapter_contract: ADAPTER_CONTRACT,
    argv: Array.isArray(argv) ? argv.slice() : argv,
    events: Array.isArray(events) ? events.slice() : events,
    timeout_ms: timeoutMs,
  };
  if (phaseBranches !== undefined) record.phase_branches = phaseBranches;
  if (pushConsent !== undefined) record.push_consent = isPlainObject(pushConsent) ? { ...pushConsent } : pushConsent;
  return record;
}

function validateRegistrationShape(record) {
  if (!isPlainObject(record)) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration must be an object. Re-run enterprise install to repair it.'
    );
  }
  const allowedFields = [...REGISTRATION_FIELDS, ...OPTIONAL_REGISTRATION_FIELDS];
  for (const key of Object.keys(record)) {
    if (!allowedFields.includes(key)) {
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

function isFixedPushConsent(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  return keys === 'force,scope'
    && value.scope === PUSH_CONSENT_PHASE_BRANCHES.scope
    && value.force === PUSH_CONSENT_PHASE_BRANCHES.force;
}

function validateOptionalFields(record) {
  if ('phase_branches' in record && !PHASE_BRANCHES_MODES.includes(record.phase_branches)) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration phase_branches must be "stacked" or "none". Re-run enterprise install to repair it.'
    );
  }
  if ('push_consent' in record && !isFixedPushConsent(record.push_consent)) {
    return fail(
      'ENTERPRISE_REGISTRATION_MALFORMED',
      'Adapter registration push_consent must be the fixed phase-branches consent without force. Re-run enterprise install to repair it.'
    );
  }
  return null;
}

function validateRegistration(record) {
  const shapeFailure = validateRegistrationShape(record);
  if (shapeFailure) return shapeFailure;
  const optionalFailure = validateOptionalFields(record);
  if (optionalFailure) return optionalFailure;
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

// main-local publishes to the base branch without phase branches, so it always
// wins over a requested stacked strategy, and the override is reported.
function resolvePhaseBranches(projectRoot, requested) {
  let mode;
  try {
    mode = detectMode(projectRoot);
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
  if (mode.branch_strategy === 'main-local') {
    const warning = requested === 'stacked'
      ? {
        code: 'PHASE_BRANCHES_MAIN_LOCAL',
        message: 'phase_branches stacked was overridden to none because Pocket Enterprise branch_strategy is main-local.',
      }
      : undefined;
    return { value: 'none', warning };
  }
  return { value: requested === undefined ? 'stacked' : requested, warning: undefined };
}

function installRegistration(projectRoot, opts = {}) {
  const writeAtomic = opts.writeAtomic || ((target, content) => writeFileAtomicSync(target, content));
  const mkdir = opts.mkdir || fs.mkdirSync;
  // Input is checked before the main-local override so an invalid value is never masked.
  if (opts.phaseBranches !== undefined && !PHASE_BRANCHES_MODES.includes(opts.phaseBranches)) {
    return fail('ENTERPRISE_INSTALL_FAILED', `--phase-branches must be one of: ${PHASE_BRANCHES_MODES.join(', ')}.`);
  }
  if (opts.pushConsent !== undefined && opts.pushConsent !== 'phase-branches') {
    return fail('ENTERPRISE_INSTALL_FAILED', '--push-consent must be one of: phase-branches.');
  }
  const resolved = resolvePhaseBranches(projectRoot, opts.phaseBranches);
  if (resolved.error) {
    return fail('ENTERPRISE_INSTALL_FAILED', `Enterprise adapter install failed: ${resolved.error}`);
  }
  // The CLI token `phase-branches` maps to the fixed consent object; nothing else is accepted.
  const pushConsent = opts.pushConsent === 'phase-branches' ? PUSH_CONSENT_PHASE_BRANCHES : undefined;
  const phaseBranches = resolved.value;
  const record = buildRegistration({
    argv: opts.argv,
    events: opts.events,
    timeoutMs: opts.timeoutMs,
    phaseBranches,
    pushConsent,
  });
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
  const result = { ok: true, code: null, message: null, path: target, record };
  if (resolved.warning) result.warning = resolved.warning;
  return result;
}

module.exports = {
  ADAPTER_CONTRACT,
  CORE_VERSION,
  CORE_VERSION_PATH,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  OPTIONAL_REGISTRATION_FIELDS,
  PHASE_BRANCHES_MODES,
  PUSH_CONSENT_PHASE_BRANCHES,
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
