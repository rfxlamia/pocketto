'use strict';

// Coordinates compatibility gates before reading or dispatching a registered adapter.
const fs = require('node:fs');
const path = require('node:path');
const registration = require('./registration-record');
const versions = require('./registration-version');

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

function checkRegisteredExecutable(projectRoot, record, exists) {
  const argv0 = record.argv[0];
  if (argv0.includes('/') || argv0.includes(path.sep) || argv0.endsWith('.js')) {
    let resolved = argv0;
    if (!path.isAbsolute(resolved)) resolved = path.resolve(projectRoot, resolved);
    let present = false;
    try {
      present = exists(resolved);
    } catch {
      present = false;
    }
    if (!present) {
      return registration.fail(
        'ENTERPRISE_ADAPTER_UNAVAILABLE',
        `Registered adapter executable is missing: ${argv0}. Re-run enterprise install; the event stays pending and no GitHub calls were made.`
      );
    }
  }
  return { ok: true };
}

function preflightResult(core, loaded, legacyV3Pair) {
  const result = {
    ok: true,
    code: null,
    message: null,
    record: loaded.record,
    path: loaded.path,
    core,
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
  const executable = checkRegisteredExecutable(projectRoot, loaded.record, exists);
  if (!executable.ok) return executable;
  return preflightResult(core, loaded, compatiblePair.legacyV3Pair);
}

module.exports = { preflight };
