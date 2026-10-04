'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCli, installRecordingRemoteBoundary } = require('./support');
const {
  createMatrixFixture,
  createPendingEvent,
  readCoreInfo,
  readEnterpriseInfo,
  snapshotLocalState,
  writeSurface,
} = require('./mixed-major-fixtures');
const enterpriseRegistration = require('../../enterprise/registration');

function testMajorPairingMatrix(t) {
  const matrix = [
    { name: 'v3/v3', core: 3, enterprise: 3, warning: 'LEGACY_V3_PAIR' },
    { name: 'v4/v4', core: 4, enterprise: 4 },
    { name: 'v4/v3', core: 4, enterprise: 3, error: 'ENTERPRISE_MAJOR_MISMATCH' },
    { name: 'v3/v4', core: 3, enterprise: 4, error: 'ENTERPRISE_MAJOR_MISMATCH' },
  ];

  for (const pairing of matrix) {
    const fixture = createMatrixFixture(t, pairing.core, pairing.enterprise);
    const coreInfo = readCoreInfo(fixture.coreManifest);
    const enterpriseInfo = readEnterpriseInfo(fixture.enterpriseManifest);
    const ghCallsBefore = fs.readFileSync(fixture.remote.ghCalls, 'utf8');
    const checked = enterpriseRegistration.preflight(fixture.projectRoot, {
      getCoreInfo: () => coreInfo,
      getEnterpriseInfo: () => enterpriseInfo,
    });
    if (pairing.error) {
      assert.equal(checked.ok, false, `${pairing.name}: Enterprise preflight must fail closed`);
      assert.equal(checked.code, pairing.error, `${pairing.name}: report a stable mixed-major error`);
      assert.match(checked.message, /upgrade.*(Core|Enterprise)|(?:Core|Enterprise).*upgrade/i);
    } else {
      assert.equal(checked.ok, true, `${pairing.name}: compatible preflight should pass: ${JSON.stringify(checked)}`);
      if (pairing.warning) assert.equal(checked.warning.code, pairing.warning);
    }
    assert.equal(fs.readFileSync(fixture.remote.ghCalls, 'utf8'), ghCallsBefore, `${pairing.name}: preflight must make no GitHub calls`);
    assert.equal(fs.readFileSync(fixture.remote.remoteCalls, 'utf8'), '', `${pairing.name}: preflight must not dispatch the adapter`);
  }
}

function testSupportedV4Dispatch(t) {
  const supported = createMatrixFixture(t, 4, 4);
  const supportedEventId = createPendingEvent(supported.projectRoot);
  const supportedDrain = runCli(['lifecycle', 'drain', supported.projectRoot, '--json', '--contract', '3'], {
    cwd: supported.projectRoot,
    env: {
      ...process.env,
      PATH: `${supported.remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
      REMOTE_CALLS: supported.remote.remoteCalls,
      GH_CALLS: supported.remote.ghCalls,
      POCKETTO_LIFECYCLE_NOW: '2026-09-20T12:00:00.000Z',
    },
  });
  assert.equal(supportedDrain.status, 0, `v4/v4 drain should succeed: ${supportedDrain.stdout}${supportedDrain.stderr}`);
  assert.equal(supportedDrain.json.ok, true);
  assert.equal(supportedDrain.json.data.deliveries[0].event_id, supportedEventId);
  assert.equal(supportedDrain.json.data.deliveries[0].status, 'succeeded');
  assert.deepEqual(JSON.parse(fs.readFileSync(supported.remote.remoteCalls, 'utf8').trim()).event_id, supportedEventId);
  assert.equal(fs.readFileSync(supported.remote.ghCalls, 'utf8'), '', 'Core must not invoke gh for a compatible adapter');
}

function testMixedMajorDispatch(t) {
  const mixed = createMatrixFixture(t, 4, 3);
  const mixedEventId = createPendingEvent(mixed.projectRoot);
  const mixedBefore = snapshotLocalState(mixed.projectRoot);
  const mixedDrain = runCli(['lifecycle', 'drain', mixed.projectRoot, '--json', '--contract', '3'], {
    cwd: mixed.projectRoot,
    env: {
      ...process.env,
      PATH: `${mixed.remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
      REMOTE_CALLS: mixed.remote.remoteCalls,
      GH_CALLS: mixed.remote.ghCalls,
      POCKETTO_LIFECYCLE_NOW: '2026-09-20T12:00:00.000Z',
    },
  });
  assert.equal(mixedDrain.status, 0, `Core must remain locally successful for mixed majors: ${mixedDrain.stdout}${mixedDrain.stderr}`);
  assert.equal(mixedDrain.json.ok, true);
  assert.equal(mixedDrain.json.data.deliveries[0].event_id, mixedEventId);
  assert.equal(mixedDrain.json.data.deliveries[0].status, 'retryable');
  assert.equal(mixedDrain.json.data.deliveries[0].error.code, 'ADAPTER_MAJOR_MISMATCH');
  assert.equal(fs.readFileSync(mixed.remote.remoteCalls, 'utf8'), '', 'mixed-major dispatch must not invoke the adapter');
  assert.equal(fs.readFileSync(mixed.remote.ghCalls, 'utf8'), '', 'mixed-major dispatch must not invoke GitHub');
  assert.deepEqual(snapshotLocalState(mixed.projectRoot), mixedBefore, 'mixed-major refusal must preserve local plan, journal identity, metadata, task projection, and remote markers');
  assert.equal(JSON.parse(fs.readFileSync(path.join(mixed.projectRoot, 'lifecycle.json'), 'utf8')).events[0].delivery.status, 'retryable');
}

function prepareUnavailableAdapter(fixture, mode) {
  const registrationPath = path.join(fixture.projectRoot, '.pocket', 'lifecycle-adapter.json');
  const validRegistration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  if (mode === 'removed') {
    fs.rmSync(registrationPath);
  } else {
    const disabledRoot = path.join(fixture.tempRoot, 'disabled-enterprise');
    writeSurface(disabledRoot, 4);
    fs.writeFileSync(registrationPath, `${JSON.stringify({
      ...validRegistration,
      argv: [process.execPath, path.join(disabledRoot, 'disabled-adapter.js')],
    }, null, 2)}\n`);
  }
  return { registrationPath, validRegistration };
}

function restoreUnavailableAdapter(fixture, mode, registrationPath, validRegistration) {
  if (mode === 'removed') {
    installRecordingRemoteBoundary(fixture.projectRoot, fixture.tempRoot);
    writeSurface(fixture.tempRoot, 4);
  } else {
    fs.writeFileSync(registrationPath, `${JSON.stringify(validRegistration, null, 2)}\n`);
  }
}

function assertAdapterReplay(fixture, mode, eventId, env) {
  const replay = runCli(['lifecycle', 'drain', fixture.projectRoot, '--json', '--contract', '3'], {
    cwd: fixture.projectRoot,
    env: { ...env, POCKETTO_LIFECYCLE_NOW: '2026-09-20T12:00:01.002Z' },
  });
  assert.equal(replay.status, 0, `${mode} adapter replay should succeed: ${replay.stdout}${replay.stderr}`);
  assert.equal(replay.json.data.deliveries[0].event_id, eventId, `${mode} adapter replay must reuse the original event ID`);
  assert.equal(replay.json.data.deliveries[0].status, 'succeeded');
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.remote.remoteCalls, 'utf8').trim()).event_id, eventId);
  assert.equal(fs.readFileSync(fixture.remote.ghCalls, 'utf8'), '', `${mode} adapter replay must not invoke gh`);
}

function testUnavailableAdapterMode(t, mode) {
  const fixture = createMatrixFixture(t, 4, 4);
  const eventId = createPendingEvent(fixture.projectRoot);
  const { registrationPath, validRegistration } = prepareUnavailableAdapter(fixture, mode);
  const before = snapshotLocalState(fixture.projectRoot);
  const env = {
    ...process.env,
    PATH: `${fixture.remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
    REMOTE_CALLS: fixture.remote.remoteCalls,
    GH_CALLS: fixture.remote.ghCalls,
    POCKETTO_LIFECYCLE_NOW: '2026-09-20T12:00:00.000Z',
  };
  const unavailable = runCli(['lifecycle', 'drain', fixture.projectRoot, '--json', '--contract', '3'], {
    cwd: fixture.projectRoot,
    env,
  });
  assert.equal(unavailable.status, 0, `${mode} adapter must not block local Core: ${unavailable.stdout}${unavailable.stderr}`);
  assert.equal(unavailable.json.ok, true);
  assert.equal(unavailable.json.data.deliveries[0].event_id, eventId);
  assert.equal(unavailable.json.data.deliveries[0].status, 'retryable');
  assert.deepEqual(snapshotLocalState(fixture.projectRoot), before, `${mode} adapter must preserve local lifecycle identity and rollback files`);
  assert.equal(fs.readFileSync(fixture.remote.remoteCalls, 'utf8'), '', `${mode} adapter must not reach the recording remote`);
  assert.equal(fs.readFileSync(fixture.remote.ghCalls, 'utf8'), '', `${mode} adapter must not invoke gh`);
  restoreUnavailableAdapter(fixture, mode, registrationPath, validRegistration);
  assertAdapterReplay(fixture, mode, eventId, env);
}

function testUnavailableAdapters(t) {
  for (const mode of ['removed', 'disabled']) testUnavailableAdapterMode(t, mode);
}

function testCoreOnlyExecution(t) {
  const coreOnly = createMatrixFixture(t, 4, 4);
  const coreOnlyEventId = createPendingEvent(coreOnly.projectRoot);
  fs.rmSync(path.join(coreOnly.projectRoot, '.pocket', 'lifecycle-adapter.json'));
  const coreOnlyBefore = snapshotLocalState(coreOnly.projectRoot);
  const local = runCli(['lifecycle', 'drain', coreOnly.projectRoot, '--json', '--contract', '3'], {
    cwd: coreOnly.projectRoot,
    env: {
      ...process.env,
      PATH: `${coreOnly.remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
      REMOTE_CALLS: coreOnly.remote.remoteCalls,
      GH_CALLS: coreOnly.remote.ghCalls,
      POCKETTO_LIFECYCLE_NOW: '2026-09-20T12:00:00.000Z',
    },
  });
  assert.equal(local.status, 0, `Core-only local drain must succeed: ${local.stdout}${local.stderr}`);
  assert.equal(local.json.ok, true);
  assert.equal(local.json.data.deliveries[0].event_id, coreOnlyEventId);
  assert.equal(local.json.data.deliveries[0].status, 'retryable');
  assert.deepEqual(snapshotLocalState(coreOnly.projectRoot), coreOnlyBefore);
  assert.equal(fs.readFileSync(coreOnly.remote.remoteCalls, 'utf8'), '', 'Core-only drain must make no adapter call');
  assert.equal(fs.readFileSync(coreOnly.remote.ghCalls, 'utf8'), '', 'Core-only drain must make no GitHub call');
}

module.exports = {
  testCoreOnlyExecution,
  testMajorPairingMatrix,
  testMixedMajorDispatch,
  testSupportedV4Dispatch,
  testUnavailableAdapters,
};
