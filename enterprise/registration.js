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
const SUPPORTED_RELEASE_MAJORS = new Set([3, 4]);
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

function majorFromVersion(version) {
  const match = typeof version === 'string' ? /^(\d+)\./.exec(version) : null;
  return match ? Number(match[1]) : null;
}

function defaultSurfaceInfo(manifestPath = path.resolve(__dirname, '..', 'surfaces.json')) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return {
      releaseMajor: manifest && manifest.release ? manifest.release.major : null,
      surfaceManifest: manifest && Number.isInteger(manifest.schema) ? manifest.schema : null,
    };
  } catch {
    return { releaseMajor: null, surfaceManifest: null };
  }
}

function coreSurfaceManifestPath() {
  return CORE_VERSION_PATH
    ? path.resolve(path.dirname(CORE_VERSION_PATH), '..', '..', 'surfaces.json')
    : path.resolve(__dirname, '..', 'surfaces.json');
}

function enterprisePackageMajor() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    return majorFromVersion(manifest.version);
  } catch {
    return null;
  }
}

function defaultCoreInfo() {
  if (!CORE_VERSION) {
    return { present: false, packageMajor: null, releaseMajor: null, contract: null, lifecycleSchema: null, adapterContract: null };
  }
  return {
    present: true,
    packageMajor: majorFromVersion(CORE_VERSION.CLI_VERSION),
    ...defaultSurfaceInfo(coreSurfaceManifestPath()),
    contract: CORE_VERSION.CONTRACT,
    pipeline: CORE_VERSION.PIPELINE,
    lifecycleSchema: CORE_VERSION.LIFECYCLE_SCHEMA,
    adapterContract: CORE_VERSION.ADAPTER_CONTRACT,
  };
}

function defaultEnterpriseInfo() {
  return {
    packageMajor: enterprisePackageMajor(),
    ...defaultSurfaceInfo(),
    adapterContract: ADAPTER_CONTRACT,
  };
}

function validateReleaseMajorMetadata(info, surface) {
  if (!info || !Number.isInteger(info.releaseMajor) || !Number.isInteger(info.packageMajor)) {
    return fail(
      'ENTERPRISE_MAJOR_UNVERIFIED',
      `${surface} package and release majors must both be verifiable integers. Repair the installation; Core remains usable and no GitHub calls were made.`,
    );
  }
  if (info.releaseMajor !== info.packageMajor) {
    return fail(
      'ENTERPRISE_MAJOR_METADATA_MISMATCH',
      `${surface} release major ${info.releaseMajor} disagrees with package major ${info.packageMajor}. Reinstall a matching release; Core remains usable and no GitHub calls were made.`,
    );
  }
  if (!SUPPORTED_RELEASE_MAJORS.has(info.releaseMajor)) {
    return fail(
      'ENTERPRISE_MAJOR_UNSUPPORTED',
      `${surface} major ${info.releaseMajor} is unsupported. Install a supported v3/v3 or v4/v4 release pair; Core remains usable and no GitHub calls were made.`,
    );
  }
  return { ok: true, major: info.releaseMajor };
}

function legacyV3Warning() {
  return {
    code: 'LEGACY_V3_PAIR',
    message: 'Core v3 and Enterprise v3 remain usable on the legacy workflow. Upgrade both surfaces to v4 when ready; finish active v3 plans with the v3 CLI.',
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
  const getEnterpriseInfo = deps.getEnterpriseInfo || defaultEnterpriseInfo;
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
  let enterprise;
  try {
    enterprise = getEnterpriseInfo();
  } catch (err) {
    return fail(
      'ENTERPRISE_SURFACE_UNVERIFIED',
      `Enterprise release compatibility cannot be verified: ${err && err.message ? err.message : String(err)}. No GitHub calls were made.`
    );
  }
  const verifiedCore = validateReleaseMajorMetadata(core, 'Core');
  if (!verifiedCore.ok) return verifiedCore;
  const verifiedEnterprise = validateReleaseMajorMetadata(enterprise, 'Enterprise');
  if (!verifiedEnterprise.ok) return verifiedEnterprise;
  const coreMajor = verifiedCore.major;
  const enterpriseMajor = verifiedEnterprise.major;
  if (coreMajor !== enterpriseMajor) {
    let guidance = 'Install matching Core and Enterprise v4 releases';
    if (coreMajor === 3) guidance = 'Upgrade Core to v4';
    else if (enterpriseMajor === 3) guidance = 'Upgrade Enterprise to v4';
    return fail(
      'ENTERPRISE_MAJOR_MISMATCH',
      `Core v${coreMajor} and Enterprise v${enterpriseMajor} are incompatible. ${guidance}; Enterprise remains disabled, Core local work remains usable, and no GitHub calls were made.`,
    );
  }
  const legacyV3Pair = coreMajor === 3 && enterpriseMajor === 3;
  const supportedV4Pair = coreMajor === 4 && enterpriseMajor === 4;
  if (!legacyV3Pair && !supportedV4Pair) {
    return fail(
      'ENTERPRISE_MAJOR_UNSUPPORTED',
      `Core v${coreMajor} and Enterprise v${enterpriseMajor} are not a supported release pair. Install matching v4 releases; Core local work remains usable and no GitHub calls were made.`,
    );
  }
  const expectedContract = CORE_VERSION ? CORE_VERSION.CONTRACT : 3;
  const expectedPipeline = CORE_VERSION ? CORE_VERSION.PIPELINE : 5;
  const expectedSchema = CORE_VERSION ? CORE_VERSION.LIFECYCLE_SCHEMA : 1;
  const expectedAdapterContract = CORE_VERSION ? CORE_VERSION.ADAPTER_CONTRACT : ADAPTER_CONTRACT;
  const expectedSurfaceManifest = CORE_VERSION ? CORE_VERSION.SURFACE_MANIFEST : 1;

  // A v3/v3 pair intentionally stays on its legacy protocol. Every v4
  // protocol is checked independently and is required to be present.
  if (!legacyV3Pair && (core.contract !== expectedContract || core.lifecycleSchema !== expectedSchema)) {
    return fail(
      'ENTERPRISE_CORE_INCOMPATIBLE',
      `Core contract ${core.contract}/schema ${core.lifecycleSchema} is incompatible with Enterprise (expected contract ${expectedContract}/schema ${expectedSchema}). Upgrade Core to v4; Core remains usable and no GitHub calls were made.`
    );
  }

  if (!legacyV3Pair && core.pipeline !== expectedPipeline) {
    return fail(
      'ENTERPRISE_CORE_INCOMPATIBLE',
      `Core pipeline ${core.pipeline} is incompatible with Enterprise (expected pipeline ${expectedPipeline}). Upgrade Core to v4; Core remains usable and no GitHub calls were made.`
    );
  }

  if (!legacyV3Pair && core.surfaceManifest !== expectedSurfaceManifest) {
    return fail(
      'ENTERPRISE_CORE_INCOMPATIBLE',
      `Core surface manifest schema ${core.surfaceManifest} is incompatible with Enterprise (expected ${expectedSurfaceManifest}). Upgrade Core to v4; Core remains usable and no GitHub calls were made.`
    );
  }

  if (!legacyV3Pair && (!enterprise || enterprise.adapterContract !== expectedAdapterContract)) {
    return fail(
      'ENTERPRISE_ADAPTER_CONTRACT_MISMATCH',
      `Enterprise adapter contract ${enterprise && enterprise.adapterContract} is incompatible with Core adapter contract ${expectedAdapterContract}. Upgrade Enterprise to a matching v4 release; Core remains usable and no GitHub calls were made.`,
    );
  }

  if (!legacyV3Pair && (!enterprise || enterprise.surfaceManifest !== expectedSurfaceManifest)) {
    return fail(
      'ENTERPRISE_SURFACE_MANIFEST_MISMATCH',
      `Enterprise surface manifest schema ${enterprise && enterprise.surfaceManifest} is incompatible with Core (expected ${expectedSurfaceManifest}). Upgrade Enterprise to a matching v4 release; Core remains usable and no GitHub calls were made.`,
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
    } catch {
      present = false;
    }
    if (!present) {
      return fail(
        'ENTERPRISE_ADAPTER_UNAVAILABLE',
        `Registered adapter executable is missing: ${argv0}. Re-run enterprise install; the event stays pending and no GitHub calls were made.`
      );
    }
  }

  const result = {
    ok: true,
    code: null,
    message: null,
    record: loaded.record,
    path: loaded.path,
    core,
  };
  if (legacyV3Pair) result.warning = legacyV3Warning();
  return result;
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
