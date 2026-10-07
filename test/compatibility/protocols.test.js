'use strict';

const {
  test, assert, fs, os, path, spawnSync, enterpriseRegistration,
  ROOT, CLI, ENTERPRISE_CLI, V3_FIXTURE,
  tempDirectory, copyV3Plan, snapshotTree, runCli,
  installRecordingRemoteBoundary, createAtomicObserver,
} = require('./support');

test('v4 preflight independently rejects mismatched or missing protocol versions', (t) => {
  const projectRoot = tempDirectory(t);
  const installed = enterpriseRegistration.installRegistration(projectRoot, { argv: [process.execPath] });
  assert.equal(installed.ok, true, `fixture registration should install: ${JSON.stringify(installed)}`);

  const validCore = {
    present: true,
    packageMajor: 4,
    releaseMajor: 4,
    contract: 3,
    pipeline: 5,
    lifecycleSchema: 1,
    adapterContract: 1,
    surfaceManifest: 1,
  };
  const validEnterprise = {
    packageMajor: 4,
    releaseMajor: 4,
    adapterContract: 1,
    surfaceManifest: 1,
  };
  const scenarios = [
    { name: 'Core CONTRACT mismatch', surface: 'core', field: 'contract', value: 2 },
    { name: 'missing Core CONTRACT', surface: 'core', field: 'contract', missing: true },
    { name: 'Core PIPELINE mismatch', surface: 'core', field: 'pipeline', value: 4 },
    { name: 'missing Core PIPELINE', surface: 'core', field: 'pipeline', missing: true },
    { name: 'Core LIFECYCLE_SCHEMA mismatch', surface: 'core', field: 'lifecycleSchema', value: 2 },
    { name: 'missing Core LIFECYCLE_SCHEMA', surface: 'core', field: 'lifecycleSchema', missing: true },
    { name: 'Core SURFACE_MANIFEST mismatch', surface: 'core', field: 'surfaceManifest', value: 2 },
    { name: 'missing Core SURFACE_MANIFEST', surface: 'core', field: 'surfaceManifest', missing: true },
    { name: 'Enterprise ADAPTER_CONTRACT mismatch', surface: 'enterprise', field: 'adapterContract', value: 2 },
    { name: 'missing Enterprise ADAPTER_CONTRACT', surface: 'enterprise', field: 'adapterContract', missing: true },
    { name: 'Enterprise SURFACE_MANIFEST mismatch', surface: 'enterprise', field: 'surfaceManifest', value: 2 },
    { name: 'missing Enterprise SURFACE_MANIFEST', surface: 'enterprise', field: 'surfaceManifest', missing: true },
  ];

  for (const scenario of scenarios) {
    const core = { ...validCore };
    const enterprise = { ...validEnterprise };
    const target = scenario.surface === 'core' ? core : enterprise;
    if (scenario.missing) delete target[scenario.field];
    else target[scenario.field] = scenario.value;

    const checked = enterpriseRegistration.preflight(projectRoot, {
      getCoreInfo: () => core,
      getEnterpriseInfo: () => enterprise,
    });
    assert.equal(checked.ok, false, `${scenario.name} must fail closed: ${JSON.stringify(checked)}`);
  }
});
