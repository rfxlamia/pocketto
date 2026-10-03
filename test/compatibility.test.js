'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const enterpriseRegistration = require('../enterprise/registration');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'index.js');
const ENTERPRISE_CLI = path.join(ROOT, 'enterprise', 'cli.js');
const V3_FIXTURE = path.join(__dirname, 'fixtures', 'v3-plan');

function tempDirectory(t, prefix = 'pocket-compat-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function copyV3Plan(t) {
  const tempRoot = tempDirectory(t);
  const specDir = path.join(tempRoot, 'v3-plan');
  fs.cpSync(V3_FIXTURE, specDir, { recursive: true });
  return { tempRoot, specDir };
}

function snapshotTree(root) {
  const snapshot = [];
  const walk = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = path.join(relative, entry.name);
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(childPath, childRelative);
      else if (entry.isFile()) snapshot.push([childRelative, fs.readFileSync(childPath).toString('base64')]);
      else if (entry.isSymbolicLink()) snapshot.push([childRelative, `symlink:${fs.readlinkSync(childPath)}`]);
    }
  };
  walk(root);
  return snapshot;
}

function runCli(args, options = {}) {
  const nodeArgs = [];
  if (options.preload) nodeArgs.push('--require', options.preload);
  nodeArgs.push(options.entrypoint || CLI, ...args);
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    env: options.env || process.env,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout.trim());
  } catch {
    // Preserve stdout/stderr for a useful assertion message.
  }
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, json };
}

function installRecordingRemoteBoundary(specDir, tempRoot) {
  const pocketDir = path.join(specDir, '.pocket');
  fs.mkdirSync(pocketDir, { recursive: true });
  const remoteCalls = path.join(tempRoot, 'remote-calls.jsonl');
  const ghCalls = path.join(tempRoot, 'gh-calls.jsonl');
  fs.writeFileSync(remoteCalls, '');
  fs.writeFileSync(ghCalls, '');

  const adapter = path.join(tempRoot, 'recording-adapter.js');
  fs.writeFileSync(adapter, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventFile = process.argv.find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
const event = eventFile ? JSON.parse(fs.readFileSync(eventFile, 'utf8')) : { event_id: 'missing-event' };
fs.appendFileSync(process.env.REMOTE_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`, { mode: 0o755 });
  fs.writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
    schema: 1,
    adapter_contract: 1,
    argv: [process.execPath, adapter],
    events: ['spec-approved', 'phase-complete', 'plan-closed'],
    timeout_ms: 30000,
  }, null, 2)}\n`);

  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const gh = path.join(binDir, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env node\n'use strict';\nrequire('node:fs').appendFileSync(process.env.GH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });
  return { remoteCalls, ghCalls, binDir };
}

function createAtomicObserver(tempRoot, targetPath) {
  const preload = path.join(tempRoot, 'atomic-observer.cjs');
  const trace = path.join(tempRoot, 'atomic-trace.jsonl');
  fs.writeFileSync(trace, '');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(process.env.ATOMIC_TARGET || ${JSON.stringify(targetPath)});
const trace = process.env.ATOMIC_TRACE;
const writeFileSync = fs.writeFileSync;
const renameSync = fs.renameSync;
fs.writeFileSync = function (file, ...args) {
  if (typeof file === 'string' && path.resolve(file) === target) {
    fs.appendFileSync(trace, JSON.stringify({ operation: 'direct-write' }) + '\\n');
  }
  return writeFileSync.call(this, file, ...args);
};
fs.renameSync = function (from, to) {
  if (typeof to === 'string' && path.resolve(to) === target) {
    fs.appendFileSync(trace, JSON.stringify({ operation: 'rename', source: path.basename(from) }) + '\\n');
  }
  return renameSync.call(this, from, to);
};
`);
  return { preload, trace };
}

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

test('RED CYCLE 5: mixed-major preflight fails closed while Core preserves local lifecycle events', (t) => {
  const { createHash } = require('node:crypto');
  const lifecycleStore = require('../cli/lib/lifecycle-store');

  function writeSurface(root, major) {
    fs.mkdirSync(root, { recursive: true });
    const manifestPath = path.join(root, 'surfaces.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify({ schema: 1, release: { major } }, null, 2)}\n`);
    return manifestPath;
  }

  function readCoreInfo(manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const major = manifest.release.major;
    return {
      present: true,
      packageMajor: major,
      releaseMajor: major,
      contract: major === 3 ? 2 : 3,
      pipeline: major === 3 ? 4 : 5,
      lifecycleSchema: major === 3 ? null : 1,
      adapterContract: 1,
      surfaceManifest: manifest.schema,
    };
  }

  function readEnterpriseInfo(manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return {
      packageMajor: manifest.release.major,
      releaseMajor: manifest.release.major,
      adapterContract: 1,
      surfaceManifest: manifest.schema,
    };
  }

  function createMatrixFixture(coreMajor, enterpriseMajor) {
    const tempRoot = tempDirectory(t, `pocket-compat-v${coreMajor}-v${enterpriseMajor}-`);
    const projectRoot = path.join(tempRoot, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const coreManifest = writeSurface(path.join(tempRoot, 'core'), coreMajor);
    const enterpriseManifest = writeSurface(tempRoot, enterpriseMajor);
    const remote = installRecordingRemoteBoundary(projectRoot, tempRoot);
    return { tempRoot, projectRoot, coreManifest, enterpriseManifest, remote };
  }

  function createPendingEvent(specDir) {
    fs.mkdirSync(specDir, { recursive: true });
    const artifact = 'approved-spec.md';
    const bytes = Buffer.from('Compatibility fixture approved spec.\n');
    fs.writeFileSync(path.join(specDir, artifact), bytes);
    fs.writeFileSync(path.join(specDir, '.pocket-meta.json'), '{"preserve":"metadata"}\n');
    fs.writeFileSync(path.join(specDir, 'log.json'), '{"preserve":"task projection"}\n');
    fs.writeFileSync(path.join(specDir, 'remote-marker.md'), '<!-- pocket-plan:compatibility-plan -->\n');
    const committed = lifecycleStore.commitTransition({
      specDir,
      planId: 'compatibility-plan',
      planDir: null,
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: artifact,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        revision: 1,
      }],
      deps: { now: () => '2026-09-20T12:00:00.000Z' },
    });
    assert.equal(committed.ok, true, `fixture event should commit locally: ${JSON.stringify(committed)}`);
    return committed.event.event_id;
  }

  function snapshotLocalState(specDir) {
    const doc = JSON.parse(fs.readFileSync(path.join(specDir, 'lifecycle.json'), 'utf8'));
    return {
      plan: doc.plan,
      events: doc.events.map((event) => ({
        event_id: event.event_id,
        type: event.type,
        revision: event.revision,
        payload_hash: event.payload_hash,
        artifact_refs: event.artifact_refs,
      })),
      files: Object.fromEntries(['.pocket-meta.json', 'log.json', 'remote-marker.md'].map((name) => [
        name,
        fs.readFileSync(path.join(specDir, name)),
      ])),
    };
  }

  const matrix = [
    { name: 'v3/v3', core: 3, enterprise: 3, warning: 'LEGACY_V3_PAIR' },
    { name: 'v4/v4', core: 4, enterprise: 4 },
    { name: 'v4/v3', core: 4, enterprise: 3, error: 'ENTERPRISE_MAJOR_MISMATCH' },
    { name: 'v3/v4', core: 3, enterprise: 4, error: 'ENTERPRISE_MAJOR_MISMATCH' },
  ];

  for (const pairing of matrix) {
    const fixture = createMatrixFixture(pairing.core, pairing.enterprise);
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

  const supported = createMatrixFixture(4, 4);
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

  const mixed = createMatrixFixture(4, 3);
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

  for (const mode of ['removed', 'disabled']) {
    const fixture = createMatrixFixture(4, 4);
    const eventId = createPendingEvent(fixture.projectRoot);
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

    if (mode === 'removed') {
      installRecordingRemoteBoundary(fixture.projectRoot, fixture.tempRoot);
      writeSurface(fixture.tempRoot, 4);
    } else {
      fs.writeFileSync(registrationPath, `${JSON.stringify(validRegistration, null, 2)}\n`);
    }
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

  const coreOnly = createMatrixFixture(4, 4);
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
});

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

test('Core does not dispatch to an adapter with an unknown or malformed installed major', (t) => {
  const { createHash } = require('node:crypto');
  const lifecycleStore = require('../cli/lib/lifecycle-store');

  for (const scenario of [
    { name: 'missing adapter manifest' },
    { name: 'non-integer adapter release major', malformed: true },
  ]) {
    const tempRoot = tempDirectory(t, 'pocket-compat-unknown-adapter-');
    const projectRoot = path.join(tempRoot, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const remote = installRecordingRemoteBoundary(projectRoot, tempRoot);
    if (scenario.malformed) {
      fs.writeFileSync(path.join(tempRoot, 'surfaces.json'), '{"schema":1,"release":{"major":"4"}}\n');
    }

    const artifact = 'approved-spec.md';
    const bytes = Buffer.from('Unknown adapter major compatibility fixture.\n');
    fs.writeFileSync(path.join(projectRoot, artifact), bytes);
    fs.writeFileSync(path.join(projectRoot, '.pocket-meta.json'), '{"preserve":"metadata"}\n');
    fs.writeFileSync(path.join(projectRoot, 'log.json'), '{"preserve":"task projection"}\n');
    fs.writeFileSync(path.join(projectRoot, 'remote-marker.md'), '<!-- pocket-plan:compatibility-plan -->\n');
    const committed = lifecycleStore.commitTransition({
      specDir: projectRoot,
      planId: 'compatibility-plan',
      planDir: null,
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: artifact,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        revision: 1,
      }],
      deps: { now: () => '2026-09-20T12:00:00.000Z' },
    });
    assert.equal(committed.ok, true, `${scenario.name}: fixture event should commit locally`);
    const eventId = committed.event.event_id;
    const planBefore = JSON.parse(fs.readFileSync(path.join(projectRoot, 'lifecycle.json'), 'utf8')).plan;
    const unchangedFiles = Object.fromEntries(['.pocket-meta.json', 'log.json', 'remote-marker.md'].map((name) => [
      name,
      fs.readFileSync(path.join(projectRoot, name)),
    ]));

    const result = runCli(['lifecycle', 'drain', projectRoot, '--json', '--contract', '3'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
        REMOTE_CALLS: remote.remoteCalls,
        GH_CALLS: remote.ghCalls,
        POCKETTO_LIFECYCLE_NOW: '2026-09-20T12:00:00.000Z',
      },
    });
    assert.equal(result.status, 0, `${scenario.name}: Core local drain must remain successful: ${result.stdout}${result.stderr}`);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.data.deliveries[0].event_id, eventId);
    assert.equal(result.json.data.deliveries[0].status, 'retryable');
    assert.equal(result.json.data.deliveries[0].error.code, 'ADAPTER_MAJOR_UNVERIFIED');
    assert.equal(fs.readFileSync(remote.remoteCalls, 'utf8'), '', `${scenario.name}: unknown-major adapter must not be invoked`);
    assert.equal(fs.readFileSync(remote.ghCalls, 'utf8'), '', `${scenario.name}: Core must not invoke GitHub`);

    const after = JSON.parse(fs.readFileSync(path.join(projectRoot, 'lifecycle.json'), 'utf8'));
    assert.deepEqual(after.plan, planBefore, `${scenario.name}: local plan state must remain intact`);
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].event_id, eventId, `${scenario.name}: pending event identity must survive`);
    assert.equal(after.events[0].delivery.status, 'retryable', `${scenario.name}: the event must remain pending for replay`);
    for (const [name, contents] of Object.entries(unchangedFiles)) {
      assert.deepEqual(fs.readFileSync(path.join(projectRoot, name)), contents, `${scenario.name}: ${name} must remain unchanged`);
    }
  }
});

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
