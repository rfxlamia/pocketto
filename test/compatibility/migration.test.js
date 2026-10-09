'use strict';

const {
  test, assert, fs, os, path, spawnSync, enterpriseRegistration,
  ROOT, CLI, ENTERPRISE_CLI, V3_FIXTURE,
  tempDirectory, copyV3Plan, snapshotTree, runCli,
  installRecordingRemoteBoundary, createAtomicObserver,
} = require('./support');

test('RED CYCLE 1: public v3 migration atomically creates a lifecycle snapshot without event or remote effects', (t) => {
  const fixture = copyV3Plan(t);
  const remote = installRecordingRemoteBoundary(fixture.specDir, fixture.tempRoot);
  const initialV3Bytes = snapshotTree(fixture.specDir);
  const atomic = createAtomicObserver(fixture.tempRoot, path.join(fixture.specDir, 'lifecycle.json'));
  const env = {
    ...process.env,
    PATH: `${remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
    REMOTE_CALLS: remote.remoteCalls,
    GH_CALLS: remote.ghCalls,
    ATOMIC_TARGET: path.join(fixture.specDir, 'lifecycle.json'),
    ATOMIC_TRACE: atomic.trace,
  };

  const result = runCli([
    'lifecycle', 'migrate', fixture.specDir,
    '--from', 'v3', '--json', '--contract', '3',
  ], { cwd: fixture.specDir, env, preload: atomic.preload });

  assert.equal(result.status, 0, `migration should succeed: ${result.stdout}${result.stderr}`);
  assert.equal(result.json && result.json.ok, true, `expected success envelope: ${result.stdout}`);
  assert.equal(result.json.command, 'lifecycle migrate');
  assert.equal(result.json.contract, 3);
  assert.equal(result.json.data.plan_id, 'v3-plan');
  assert.equal(result.json.data.revision, 0);

  const lifecyclePath = path.join(fixture.specDir, 'lifecycle.json');
  const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  assert.deepEqual(lifecycle, {
    schema: 1,
    plan: {
      plan_id: 'v3-plan',
      spec_dir: fixture.specDir,
      plan_dir: fixture.specDir,
      branch: null,
      state: { approval: 'PENDING', phase_status: {}, status: 'IN_PROGRESS' },
      revision: 0,
    },
    events: [],
  });
  assert.deepEqual(
    snapshotTree(fixture.specDir).filter(([relative]) => relative !== 'lifecycle.json'),
    initialV3Bytes,
    'migration may add lifecycle.json but must leave every v3/test-boundary file byte-identical',
  );
  const atomicOperations = fs.readFileSync(atomic.trace, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(atomicOperations.map((entry) => entry.operation), ['rename'], 'lifecycle.json must be published by same-directory atomic rename, never written in place');
  assert.ok(atomicOperations[0].source.startsWith('.lifecycle.json.tmp-'), 'atomic rename must publish a temporary lifecycle snapshot');
  assert.equal(fs.readFileSync(remote.remoteCalls, 'utf8'), '', 'migration must not invoke the registered adapter');
  assert.equal(fs.readFileSync(remote.ghCalls, 'utf8'), '', 'migration must not invoke GitHub');
});

test('RED CYCLE 2: repeated v3 migration returns the existing identity without changing revision or bytes', (t) => {
  const fixture = copyV3Plan(t);
  const remote = installRecordingRemoteBoundary(fixture.specDir, fixture.tempRoot);
  const env = {
    ...process.env,
    PATH: `${remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
    REMOTE_CALLS: remote.remoteCalls,
    GH_CALLS: remote.ghCalls,
    POCKETTO_LIFECYCLE_NOW: '2026-09-19T12:00:00.000Z',
  };
  const args = ['lifecycle', 'migrate', fixture.specDir, '--from', 'v3', '--json', '--contract', '3'];

  const first = runCli(args, { cwd: fixture.specDir, env });
  assert.equal(first.status, 0, `first migration should succeed: ${first.stdout}${first.stderr}`);
  const lifecyclePath = path.join(fixture.specDir, 'lifecycle.json');
  const lifecycleBefore = fs.readFileSync(lifecyclePath);
  const documentBefore = JSON.parse(lifecycleBefore.toString('utf8'));
  const v3BytesBefore = snapshotTree(fixture.specDir).filter(([relative]) => relative !== 'lifecycle.json');
  const fullTreeBefore = snapshotTree(fixture.specDir);

  const second = runCli(args, { cwd: fixture.specDir, env });
  assert.equal(second.status, 0, `repeated migration should return the existing result: ${second.stdout}${second.stderr}`);
  assert.equal(second.json && second.json.ok, true, `expected idempotent success envelope: ${second.stdout}`);
  assert.equal(second.json.command, 'lifecycle migrate');
  assert.deepEqual(
    [second.json.data.plan_id, second.json.data.revision, second.json.data.idempotent],
    [documentBefore.plan.plan_id, documentBefore.plan.revision, true],
    'replay must report the existing lifecycle identity and revision',
  );
  assert.deepEqual(fs.readFileSync(lifecyclePath), lifecycleBefore, 'replay must not rewrite or increment lifecycle state');
  assert.deepEqual(snapshotTree(fixture.specDir), fullTreeBefore, 'replay must make no filesystem changes');
  assert.deepEqual(
    snapshotTree(fixture.specDir).filter(([relative]) => relative !== 'lifecycle.json'),
    v3BytesBefore,
    'replay must leave all v3 bytes unchanged',
  );
  assert.equal(documentBefore.events.length, 0, 'migration identity must not be represented as a retrospective event');
  assert.equal(fs.readFileSync(remote.remoteCalls, 'utf8'), '', 'replay must not invoke the registered adapter');
  assert.equal(fs.readFileSync(remote.ghCalls, 'utf8'), '', 'replay must not invoke GitHub');
});

function migrationCommand(specDir) {
  return ['lifecycle', 'migrate', specDir, '--from', 'v3', '--json', '--contract', '3'];
}

function recordingEnv(remote) {
  return {
    ...process.env,
    PATH: `${remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
    REMOTE_CALLS: remote.remoteCalls,
    GH_CALLS: remote.ghCalls,
  };
}

function assertNoRemoteOrByteChanges(specDir, remote, before, label) {
  assert.deepEqual(snapshotTree(specDir), before, `${label}: refusal must leave every file byte-identical`);
  assert.equal(fs.readFileSync(remote.remoteCalls, 'utf8'), '', `${label}: refusal must not invoke the adapter`);
  assert.equal(fs.readFileSync(remote.ghCalls, 'utf8'), '', `${label}: refusal must not invoke GitHub`);
}

function writeIdentityLifecycle(specDir, mutate) {
  const doc = {
    schema: 1,
    plan: {
      plan_id: 'v3-plan',
      spec_dir: path.resolve(specDir),
      plan_dir: path.resolve(specDir),
      branch: null,
      state: { approval: 'PENDING', phase_status: {}, status: 'IN_PROGRESS' },
      revision: 0,
    },
    events: [],
  };
  mutate(doc);
  fs.writeFileSync(path.join(specDir, 'lifecycle.json'), `${JSON.stringify(doc, null, 2)}\n`);
}

function markV3PhaseReview(specDir) {
  const logPath = path.join(specDir, 'log.json');
  const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  log.phases[0].status = 'REVIEW';
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
}

test('migration replay re-checks the v3 snapshot and does not treat a planted lifecycle as idempotent', (t) => {
  const scenarios = [
    {
      name: 'migrated snapshot then v3 progress',
      prepare(specDir) {
        const remote = installRecordingRemoteBoundary(specDir, path.dirname(specDir));
        const migrated = runCli(migrationCommand(specDir), { cwd: specDir, env: recordingEnv(remote) });
        assert.equal(migrated.status, 0, `setup migration should succeed: ${migrated.stdout}${migrated.stderr}`);
        markV3PhaseReview(specDir);
      },
    },
    {
      name: 'planted pristine lifecycle beside v3 progress',
      prepare(specDir) {
        writeIdentityLifecycle(specDir, () => {});
        markV3PhaseReview(specDir);
      },
    },
    {
      name: 'planted journal with events beside v3 progress',
      prepare(specDir) {
        writeIdentityLifecycle(specDir, (doc) => {
          doc.plan.revision = 2;
          doc.events.push({ event_id: 'v3-plan:spec-approved:r2', revision: 2 });
        });
        markV3PhaseReview(specDir);
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = copyV3Plan(t);
    scenario.prepare(fixture.specDir);
    const remote = installRecordingRemoteBoundary(fixture.specDir, fixture.tempRoot);
    const before = snapshotTree(fixture.specDir);
    const result = runCli(migrationCommand(fixture.specDir), {
      cwd: fixture.specDir,
      env: recordingEnv(remote),
    });

    assert.notEqual(result.status, 0, `${scenario.name}: progressed v3 must not replay as success`);
    assert.equal(result.json && result.json.ok, false, `${scenario.name}: expected a JSON refusal: ${result.stdout}`);
    assert.equal(result.json.error.code, 'PIN_V3_REQUIRED', `${scenario.name}: an existing lifecycle must not skip the pristine check`);
    assert.match(result.json.error.message, /finish.*under v3|v3.*finish/i, `${scenario.name}: explain that the plan must finish on v3`);
    assertNoRemoteOrByteChanges(fixture.specDir, remote, before, scenario.name);
  }
});

test('migration replay refuses a journal that is no longer the pristine snapshot without rewriting it', (t) => {
  const fixture = copyV3Plan(t);
  const remote = installRecordingRemoteBoundary(fixture.specDir, fixture.tempRoot);
  const env = recordingEnv(remote);
  const created = runCli(migrationCommand(fixture.specDir), { cwd: fixture.specDir, env });
  assert.equal(created.status, 0, `setup migration should succeed: ${created.stdout}${created.stderr}`);
  writeIdentityLifecycle(fixture.specDir, (doc) => {
    doc.plan.revision = 1;
    doc.events.push({
      event_id: 'v3-plan:spec-approved:r1',
      type: 'spec-approved',
      revision: 1,
      delivery: { status: 'pending', attempts: 0 },
    });
  });
  const before = snapshotTree(fixture.specDir);

  const result = runCli(migrationCommand(fixture.specDir), { cwd: fixture.specDir, env });

  assert.notEqual(result.status, 0, `a moved journal must not report idempotent migration: ${result.stdout}${result.stderr}`);
  assert.equal(result.json && result.json.ok, false, `expected a JSON refusal: ${result.stdout}`);
  assert.equal(result.json.error.code, 'LIFECYCLE_ALREADY_EXISTS');
  assert.match(result.json.error.message, /not the pristine v3 migration snapshot/);
  assertNoRemoteOrByteChanges(fixture.specDir, remote, before, 'moved journal');
});

test('RED CYCLE 3: v3 progress refuses migration with PIN_V3_REQUIRED and no file or remote changes', (t) => {
  const scenarios = [
    { name: 'phase REVIEW', mutate: (log) => { log.phases[0].status = 'REVIEW'; } },
    { name: 'phase DONE', mutate: (log) => { log.phases[0].status = 'DONE'; } },
    { name: 'phase BLOCKED', mutate: (log) => { log.phases[0].status = 'BLOCKED'; } },
    { name: 'task progress', mutate: (log) => {
      log.phases[0].tasks[0].status = 'DONE';
      log.phases[0].tasks[0].done_sha = 'abcdef0123456789abcdef0123456789abcdef01';
    } },
    { name: 'non-pristine header', mutate: (log) => {
      log.header.status = 'DONE';
      log.header.date_completed = '2026-09-20';
    } },
    { name: 'undocumented progress field', mutate: (log) => { log.header.execution_started_at = '2026-09-19T12:00:00.000Z'; } },
  ];

  for (const scenario of scenarios) {
    const fixture = copyV3Plan(t);
    const logPath = path.join(fixture.specDir, 'log.json');
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    scenario.mutate(log);
    fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
    const remote = installRecordingRemoteBoundary(fixture.specDir, fixture.tempRoot);
    const before = snapshotTree(fixture.specDir);
    const result = runCli([
      'lifecycle', 'migrate', fixture.specDir,
      '--from', 'v3', '--json', '--contract', '3',
    ], {
      cwd: fixture.specDir,
      env: {
        ...process.env,
        PATH: `${remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
        REMOTE_CALLS: remote.remoteCalls,
        GH_CALLS: remote.ghCalls,
      },
    });

    assert.notEqual(result.status, 0, `${scenario.name}: migration must refuse progress`);
    assert.equal(result.json && result.json.ok, false, `${scenario.name}: expected a JSON refusal: ${result.stdout}`);
    assert.equal(result.json.error.code, 'PIN_V3_REQUIRED', `${scenario.name}: refusal needs stable v3 pin guidance`);
    assert.match(result.json.error.message, /finish.*under v3|v3.*finish/i, `${scenario.name}: explain that the plan must finish on v3`);
    assert.match(result.json.error.message, /pocketto-pi@3\.1\.3/, `${scenario.name}: name the compatible v3 CLI release`);
    assert.deepEqual(snapshotTree(fixture.specDir), before, `${scenario.name}: refusal must leave every file byte-identical`);
    assert.equal(fs.existsSync(path.join(fixture.specDir, 'lifecycle.json')), false, `${scenario.name}: no lifecycle document may be created`);
    assert.equal(fs.readFileSync(remote.remoteCalls, 'utf8'), '', `${scenario.name}: refusal must not invoke the adapter`);
    assert.equal(fs.readFileSync(remote.ghCalls, 'utf8'), '', `${scenario.name}: refusal must not invoke GitHub`);
  }
});

test('RED CYCLE 4: an active v3 workflow runs locally and a v4-aware boundary records its upgrade warning', (t) => {
  const fixture = copyV3Plan(t);
  const logPath = path.join(fixture.specDir, 'log.json');
  const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  log.phases[0].status = 'REVIEW';
  log.phases[0].tasks[0].status = 'DONE';
  log.phases[0].tasks[0].done_sha = 'abcdef0123456789abcdef0123456789abcdef01';
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  const remote = installRecordingRemoteBoundary(fixture.specDir, fixture.tempRoot);
  const before = snapshotTree(fixture.specDir);
  const sourceFixtureBefore = snapshotTree(V3_FIXTURE);
  const legacyRunner = path.join(V3_FIXTURE, 'legacy-runner.js');

  const legacy = spawnSync(process.execPath, [legacyRunner, fixture.specDir], {
    cwd: fixture.specDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
      REMOTE_CALLS: remote.remoteCalls,
      GH_CALLS: remote.ghCalls,
    },
  });
  assert.equal(legacy.status, 0, `legacy runner must remain operational: ${legacy.stdout}${legacy.stderr}`);
  const legacyResult = JSON.parse(legacy.stdout.trim());
  assert.equal(legacyResult.ok, true);
  assert.equal(legacyResult.workflow_version, 3);
  assert.equal(legacyResult.phase_status, 'REVIEW');
  assert.doesNotMatch(legacy.stdout, /v4|upgrade/i, 'an unchanged v3 runner must not predict a future release');
  assert.equal(fs.existsSync(path.join(fixture.specDir, 'lifecycle.json')), false, 'legacy workflow must not require v4 lifecycle state');

  const checked = enterpriseRegistration.preflight(fixture.specDir, {
    getCoreInfo: () => ({ present: true, packageMajor: 3, releaseMajor: 3, contract: 2, lifecycleSchema: null, adapterContract: 1 }),
    getEnterpriseInfo: () => ({ packageMajor: 3, releaseMajor: 3, adapterContract: 1 }),
  });
  assert.equal(checked.ok, true, `v4-aware compatibility preflight must allow the legacy pair: ${JSON.stringify(checked)}`);
  assert.equal(checked.warning.code, 'LEGACY_V3_PAIR');
  assert.match(checked.warning.message, /upgrade.*v4|v4.*upgrade/i);

  assert.deepEqual(snapshotTree(fixture.specDir), before, 'legacy execution and preflight must not rewrite v3 files');
  assert.deepEqual(snapshotTree(V3_FIXTURE), sourceFixtureBefore, 'the immutable v3 source fixture must remain byte-identical');
  assert.equal(fs.readFileSync(remote.remoteCalls, 'utf8'), '', 'legacy execution/preflight must make no adapter call');
  assert.equal(fs.readFileSync(remote.ghCalls, 'utf8'), '', 'legacy execution/preflight must make no GitHub call');
});
