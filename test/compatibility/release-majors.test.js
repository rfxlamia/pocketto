'use strict';

const {
  test, assert, fs, os, path, spawnSync, enterpriseRegistration,
  ROOT, CLI, ENTERPRISE_CLI, V3_FIXTURE,
  tempDirectory, copyV3Plan, snapshotTree, runCli,
  installRecordingRemoteBoundary, createAtomicObserver,
} = require('./support');

test('preflight fails closed on missing, malformed, unsupported, or inconsistent release majors', (t) => {
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
    { name: 'both release majors missing', update: (core, enterprise) => {
      delete core.releaseMajor;
      delete enterprise.releaseMajor;
    }, code: 'ENTERPRISE_MAJOR_UNVERIFIED' },
    { name: 'Core release major missing', update: (core) => { delete core.releaseMajor; }, code: 'ENTERPRISE_MAJOR_UNVERIFIED' },
    { name: 'Enterprise release major missing', update: (_core, enterprise) => { delete enterprise.releaseMajor; }, code: 'ENTERPRISE_MAJOR_UNVERIFIED' },
    { name: 'Core release major malformed', update: (core) => { core.releaseMajor = '4'; }, code: 'ENTERPRISE_MAJOR_UNVERIFIED' },
    { name: 'Enterprise release major malformed', update: (_core, enterprise) => { enterprise.releaseMajor = 4.5; }, code: 'ENTERPRISE_MAJOR_UNVERIFIED' },
    { name: 'Core package major missing', update: (core) => { delete core.packageMajor; }, code: 'ENTERPRISE_MAJOR_UNVERIFIED' },
    { name: 'Enterprise package major malformed', update: (_core, enterprise) => { enterprise.packageMajor = '4'; }, code: 'ENTERPRISE_MAJOR_UNVERIFIED' },
    { name: 'Core major unsupported', update: (core) => { core.packageMajor = 5; core.releaseMajor = 5; }, code: 'ENTERPRISE_MAJOR_UNSUPPORTED' },
    { name: 'Enterprise major unsupported', update: (_core, enterprise) => { enterprise.packageMajor = 5; enterprise.releaseMajor = 5; }, code: 'ENTERPRISE_MAJOR_UNSUPPORTED' },
    { name: 'Core release/package majors disagree', update: (core) => { core.packageMajor = 3; }, code: 'ENTERPRISE_MAJOR_METADATA_MISMATCH' },
    { name: 'Enterprise release/package majors disagree', update: (_core, enterprise) => { enterprise.packageMajor = 3; }, code: 'ENTERPRISE_MAJOR_METADATA_MISMATCH' },
  ];

  for (const scenario of scenarios) {
    const core = { ...validCore };
    const enterprise = { ...validEnterprise };
    scenario.update(core, enterprise);
    const checked = enterpriseRegistration.preflight(projectRoot, {
      getCoreInfo: () => core,
      getEnterpriseInfo: () => enterprise,
    });
    assert.equal(checked.ok, false, `${scenario.name} must fail closed: ${JSON.stringify(checked)}`);
    assert.equal(checked.code, scenario.code, `${scenario.name} must report a stable compatibility error`);
  }
});
