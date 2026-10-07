'use strict';

// Reads and validates the independent Core/Enterprise release and protocol versions.
const fs = require('node:fs');
const path = require('node:path');
const { ADAPTER_CONTRACT, CORE_VERSION, CORE_VERSION_PATH, fail } = require('./registration-record');

const SUPPORTED_RELEASE_MAJORS = new Set([3, 4]);

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
    return { present: false, packageMajor: null, releaseMajor: null, contract: null, pipeline: null, lifecycleSchema: null, adapterContract: null };
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

function validateReleasePair(core, enterprise) {
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
  return { ok: true, coreMajor, enterpriseMajor, legacyV3Pair };
}

function expectedProtocolVersions() {
  return {
    contract: CORE_VERSION ? CORE_VERSION.CONTRACT : 3,
    pipeline: CORE_VERSION ? CORE_VERSION.PIPELINE : 5,
    lifecycleSchema: CORE_VERSION ? CORE_VERSION.LIFECYCLE_SCHEMA : 1,
    adapterContract: CORE_VERSION ? CORE_VERSION.ADAPTER_CONTRACT : ADAPTER_CONTRACT,
    surfaceManifest: CORE_VERSION ? CORE_VERSION.SURFACE_MANIFEST : 1,
  };
}

function validateCoreProtocols(core, expected, legacyV3Pair) {
  if (legacyV3Pair) return { ok: true };
  if (core.contract !== expected.contract || core.lifecycleSchema !== expected.lifecycleSchema) {
    return fail(
      'ENTERPRISE_CORE_INCOMPATIBLE',
      `Core contract ${core.contract}/schema ${core.lifecycleSchema} is incompatible with Enterprise (expected contract ${expected.contract}/schema ${expected.lifecycleSchema}). Upgrade Core to v4; Core remains usable and no GitHub calls were made.`
    );
  }
  if (core.pipeline !== expected.pipeline) {
    return fail(
      'ENTERPRISE_CORE_INCOMPATIBLE',
      `Core pipeline ${core.pipeline} is incompatible with Enterprise (expected pipeline ${expected.pipeline}). Upgrade Core to v4; Core remains usable and no GitHub calls were made.`
    );
  }
  if (core.surfaceManifest !== expected.surfaceManifest) {
    return fail(
      'ENTERPRISE_CORE_INCOMPATIBLE',
      `Core surface manifest schema ${core.surfaceManifest} is incompatible with Enterprise (expected ${expected.surfaceManifest}). Upgrade Core to v4; Core remains usable and no GitHub calls were made.`
    );
  }
  return { ok: true };
}

function validateEnterpriseProtocols(enterprise, expected, legacyV3Pair) {
  if (legacyV3Pair) return { ok: true };
  if (!enterprise || enterprise.adapterContract !== expected.adapterContract) {
    return fail(
      'ENTERPRISE_ADAPTER_CONTRACT_MISMATCH',
      `Enterprise adapter contract ${enterprise && enterprise.adapterContract} is incompatible with Core adapter contract ${expected.adapterContract}. Upgrade Enterprise to a matching v4 release; Core remains usable and no GitHub calls were made.`,
    );
  }
  if (!enterprise || enterprise.surfaceManifest !== expected.surfaceManifest) {
    return fail(
      'ENTERPRISE_SURFACE_MANIFEST_MISMATCH',
      `Enterprise surface manifest schema ${enterprise && enterprise.surfaceManifest} is incompatible with Core (expected ${expected.surfaceManifest}). Upgrade Enterprise to a matching v4 release; Core remains usable and no GitHub calls were made.`,
    );
  }
  return { ok: true };
}

function validateProtocolCompatibility(core, enterprise, legacyV3Pair) {
  const expected = expectedProtocolVersions();
  const coreProtocols = validateCoreProtocols(core, expected, legacyV3Pair);
  if (!coreProtocols.ok) return coreProtocols;
  return validateEnterpriseProtocols(enterprise, expected, legacyV3Pair);
}

function legacyV3Warning() {
  return {
    code: 'LEGACY_V3_PAIR',
    message: 'Core v3 and Enterprise v3 remain usable on the legacy workflow. Upgrade both surfaces to v4 when ready; finish active v3 plans with the v3 CLI.',
  };
}

module.exports = {
  defaultCoreInfo,
  defaultEnterpriseInfo,
  legacyV3Warning,
  validateProtocolCompatibility,
  validateReleasePair,
};
