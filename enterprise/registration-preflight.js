'use strict';

// Coordinates compatibility gates before reading or dispatching a registered adapter.
const fs = require('node:fs');
const path = require('node:path');
const registration = require('./registration-record');
const versions = require('./registration-version');
const coreLifecycleAdapter = require('../cli/lib/lifecycle-adapter');
const { pocketArtifactProbePaths, ignoredArtifactWarning } = require('../cli/lib/artifact-ignore');

// Preflight has no plan in scope, so it probes every plan that has a spec directory
// under docs/pocket/spec/. Real artifact names keep force-tracked files out of the warning.
// Warnings are display-only: any failure here yields no warning and never blocks.
function ignoredArtifactWarnings(projectRoot) {
  try {
    const root = path.resolve(projectRoot);
    const specRoot = path.join(root, 'docs', 'pocket', 'spec');
    const planIds = fs.readdirSync(specRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const probes = planIds.flatMap((planId) => pocketArtifactProbePaths({
      planDir: path.join(root, 'docs', 'pocket', 'plans', planId),
      specDir: path.join(specRoot, planId),
    }));
    const warning = ignoredArtifactWarning(root, probes, { audience: 'enterprise' });
    return warning ? [warning] : [];
  } catch {
    return [];
  }
}

function readCoreInfo(getCoreInfo) {
  try {
    return { ok: true, value: getCoreInfo() };
  } catch (err) {
    return registration.fail(
      'ENTERPRISE_CORE_MISSING',
      `Core installation cannot be verified: ${err && err.message ? err.message : String(err)} Install a compatible Core first.`
    );
  }
}

function readEnterpriseInfo(getEnterpriseInfo) {
  try {
    return { ok: true, value: getEnterpriseInfo() };
  } catch (err) {
    return registration.fail(
      'ENTERPRISE_SURFACE_UNVERIFIED',
      `Enterprise release compatibility cannot be verified: ${err && err.message ? err.message : String(err)}. No GitHub calls were made.`
    );
  }
}

function isRuntimeArgv(record) {
  return record.argv[0] === '@pocketto-runtime-argv-v1';
}

function checkRegisteredExecutable(projectRoot, record, exists, resolveAdapterArgv) {
  const runtimeRegistration = isRuntimeArgv(record);
  if (runtimeRegistration && typeof resolveAdapterArgv !== 'function') {
    return registration.fail(
      'ADAPTER_REGISTRATION_REQUIRES_NEWER_CORE',
      'This runtime-token adapter registration requires a Core release with runtime argv resolution. Upgrade Core before running lifecycle drain; the event stays pending and no GitHub calls were made.'
    );
  }

  let argv;
  try {
    argv = typeof resolveAdapterArgv === 'function'
      ? resolveAdapterArgv(record.argv)
      : record.argv;
  } catch {
    argv = null;
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    return registration.fail(
      'ENTERPRISE_ADAPTER_UNAVAILABLE',
      'Registered adapter argv could not be resolved. Re-run enterprise install with a compatible Core; the event stays pending and no GitHub calls were made.'
    );
  }

  const executable = argv[0];
  const possibleEntrypoint = executable === process.execPath
    && typeof argv[1] === 'string'
    && !argv[1].startsWith('-')
    ? argv[1]
    : null;
  const pathsToCheck = [executable, possibleEntrypoint].filter((candidate) => (
    typeof candidate === 'string'
    && (path.isAbsolute(candidate) || candidate.includes('/') || candidate.includes(path.sep) || candidate.endsWith('.js'))
  ));
  for (const candidate of pathsToCheck) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
    let present = false;
    try {
      present = exists(resolved);
    } catch {
      present = false;
    }
    if (!present) {
      return registration.fail(
        'ENTERPRISE_ADAPTER_UNAVAILABLE',
        `Registered adapter executable or entrypoint is missing: ${candidate}. Re-run enterprise install; the event stays pending and no GitHub calls were made.`
      );
    }
  }
  return { ok: true };
}

function registrationWarnings(record) {
  if (isRuntimeArgv(record) || !record.argv.some((entry) => path.isAbsolute(entry))) return [];
  return [{
    code: 'ADAPTER_REGISTRATION_NOT_PORTABLE',
    message: 'Registered adapter argv contains absolute paths and may not work on another machine. Re-run enterprise install with the matching Core to write portable runtime tokens.',
  }];
}

function preflightResult(core, loaded, legacyV3Pair, warnings) {
  const result = {
    ok: true,
    code: null,
    message: null,
    record: loaded.record,
    path: loaded.path,
    core,
    warnings,
  };
  if (legacyV3Pair) result.warning = versions.legacyV3Warning();
  return result;
}

function preflight(projectRoot, deps = {}) {
  const getCoreInfo = deps.getCoreInfo || versions.defaultCoreInfo;
  const getEnterpriseInfo = deps.getEnterpriseInfo || versions.defaultEnterpriseInfo;
  const exists = deps.exists || fs.existsSync;
  const coreRead = readCoreInfo(getCoreInfo);
  if (!coreRead.ok) return coreRead;
  const core = coreRead.value;
  if (!core || core.present !== true) {
    return registration.fail(
      'ENTERPRISE_CORE_MISSING',
      'No compatible Core installation was found. Install Core v4 first, then re-run enterprise preflight. No GitHub calls were made.'
    );
  }
  const enterpriseRead = readEnterpriseInfo(getEnterpriseInfo);
  if (!enterpriseRead.ok) return enterpriseRead;
  const enterprise = enterpriseRead.value;
  const compatiblePair = versions.validateReleasePair(core, enterprise);
  if (!compatiblePair.ok) return compatiblePair;
  const protocol = versions.validateProtocolCompatibility(core, enterprise, compatiblePair.legacyV3Pair);
  if (!protocol.ok) return protocol;
  const loaded = registration.loadRegistration(projectRoot, deps);
  if (!loaded.ok) return loaded;
  const resolver = Object.prototype.hasOwnProperty.call(deps, 'resolveAdapterArgv')
    ? deps.resolveAdapterArgv
    : coreLifecycleAdapter.resolveAdapterArgv;
  const executable = checkRegisteredExecutable(projectRoot, loaded.record, exists, resolver);
  if (!executable.ok) return executable;
  const warnings = [
    ...ignoredArtifactWarnings(projectRoot),
    ...registrationWarnings(loaded.record),
  ];
  return preflightResult(core, loaded, compatiblePair.legacyV3Pair, warnings);
}

module.exports = { preflight };
