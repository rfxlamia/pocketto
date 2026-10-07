'use strict';

const {
  test, assert, fs, os, path, spawnSync, enterpriseRegistration,
  ROOT, CLI, ENTERPRISE_CLI, V3_FIXTURE,
  tempDirectory, copyV3Plan, snapshotTree, runCli,
  installRecordingRemoteBoundary, createAtomicObserver,
} = require('./support');

test('public Enterprise preflight CLI emits LEGACY_V3_PAIR warning in human and JSON output', (t) => {
  const projectRoot = tempDirectory(t);
  const installed = enterpriseRegistration.installRegistration(projectRoot, { argv: [process.execPath] });
  assert.equal(installed.ok, true, `fixture registration should install: ${JSON.stringify(installed)}`);

  const preload = path.join(projectRoot, 'legacy-preflight.cjs');
  const registrationPath = path.join(ROOT, 'enterprise', 'registration.js');
  fs.writeFileSync(preload, `'use strict';
const registration = require(${JSON.stringify(registrationPath)});
const preflight = registration.preflight;
registration.preflight = (root, deps = {}) => preflight(root, {
  ...deps,
  getCoreInfo: () => ({
    present: true,
    packageMajor: 3,
    releaseMajor: 3,
    contract: 2,
    pipeline: 4,
    lifecycleSchema: null,
    adapterContract: 1,
  }),
  getEnterpriseInfo: () => ({
    packageMajor: 3,
    releaseMajor: 3,
    adapterContract: 1,
  }),
});
`);

  const options = { entrypoint: ENTERPRISE_CLI, preload };
  const human = runCli(['preflight', projectRoot], options);
  const json = runCli(['preflight', projectRoot, '--json'], options);
  assert.equal(human.status, 0, `human preflight should pass: ${human.stdout}${human.stderr}`);
  assert.equal(json.status, 0, `JSON preflight should pass: ${json.stdout}${json.stderr}`);

  const humanOutput = `${human.stdout}\n${human.stderr}`;
  const warningMessage = json.json && json.json.data && json.json.data.warning && json.json.data.warning.message;
  assert.deepEqual({
    humanCode: /\bLEGACY_V3_PAIR\b/.exec(humanOutput)?.[0] || null,
    humanActionable: /upgrade both surfaces to v4/i.test(humanOutput),
    jsonCode: json.json && json.json.data && json.json.data.warning && json.json.data.warning.code || null,
    jsonActionable: typeof warningMessage === 'string' && /upgrade both surfaces to v4/i.test(warningMessage),
  }, {
    humanCode: 'LEGACY_V3_PAIR',
    humanActionable: true,
    jsonCode: 'LEGACY_V3_PAIR',
    jsonActionable: true,
  }, 'the public preflight CLI must expose the v4-aware upgrade warning to operators');
});
