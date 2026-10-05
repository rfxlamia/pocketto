'use strict';

const {
  test, assert, fs, os, path, spawnSync, enterpriseRegistration,
  ROOT, CLI, ENTERPRISE_CLI, V3_FIXTURE,
  tempDirectory, copyV3Plan, snapshotTree, runCli,
  installRecordingRemoteBoundary, createAtomicObserver,
} = require('./support');

function writeAdapterReleaseMetadata(packageRoot, adapterPath, packageVersion, surfaceMajor) {
  const relativeAdapterPath = path.relative(packageRoot, adapterPath).split(path.sep).join('/');
  fs.writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'test-enterprise-adapter',
    version: packageVersion,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(packageRoot, 'surfaces.json'), `${JSON.stringify({
    schema: 1,
    release: { major: surfaceMajor },
    roles: {
      'pi/enterprise': {
        kind: 'enterprise',
        includes: [relativeAdapterPath],
      },
    },
  }, null, 2)}\n`);
}

function createAdapterDrainFixture(t, { packageVersion, surfaceMajor, adapterDirectory = null } = {}) {
  const { createHash } = require('node:crypto');
  const lifecycleStore = require('../../cli/lib/lifecycle-store');
  const tempRoot = tempDirectory(t, 'pocket-compat-adapter-ownership-');
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const remote = installRecordingRemoteBoundary(projectRoot, tempRoot);
  fs.copyFileSync(path.join(ROOT, 'surfaces.json'), path.join(projectRoot, 'surfaces.json'));

  const packageRoot = adapterDirectory ? path.join(projectRoot, adapterDirectory) : projectRoot;
  fs.mkdirSync(packageRoot, { recursive: true });
  const adapterPath = path.join(packageRoot, 'recording-adapter.js');
  fs.copyFileSync(path.join(tempRoot, 'recording-adapter.js'), adapterPath);
  const registrationPath = path.join(projectRoot, '.pocket', 'lifecycle-adapter.json');
  const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  registration.argv = [process.execPath, adapterPath];
  fs.writeFileSync(registrationPath, `${JSON.stringify(registration, null, 2)}\n`);

  if (packageVersion !== undefined || surfaceMajor !== undefined) {
    writeAdapterReleaseMetadata(packageRoot, adapterPath, packageVersion, surfaceMajor);
  }

  const artifact = 'approved-spec.md';
  const bytes = Buffer.from('Adapter ownership compatibility fixture.\n');
  fs.writeFileSync(path.join(projectRoot, artifact), bytes);
  fs.writeFileSync(path.join(projectRoot, '.pocket-meta.json'), '{"preserve":"metadata"}\n');
  fs.writeFileSync(path.join(projectRoot, 'log.json'), '{"preserve":"task projection"}\n');
  fs.writeFileSync(path.join(projectRoot, 'remote-marker.md'), '<!-- pocket-plan:adapter-ownership-plan -->\n');
  const committed = lifecycleStore.commitTransition({
    specDir: projectRoot,
    planId: 'adapter-ownership-plan',
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
  return { tempRoot, projectRoot, remote, eventId: committed.event.event_id };
}

function assertRetryableLocalState(fixture, lifecyclePath, before, unchangedFiles) {
  const eventBefore = before.events[0];
  const after = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  assert.deepEqual(after.plan, before.plan, 'rejection must preserve the local plan state');
  assert.equal(after.events.length, 1);
  assert.deepEqual({
    event_id: after.events[0].event_id,
    type: after.events[0].type,
    revision: after.events[0].revision,
    payload_hash: after.events[0].payload_hash,
    artifact_refs: after.events[0].artifact_refs,
  }, {
    event_id: eventBefore.event_id,
    type: eventBefore.type,
    revision: eventBefore.revision,
    payload_hash: eventBefore.payload_hash,
    artifact_refs: eventBefore.artifact_refs,
  }, 'rejection must preserve the original event identity and payload');
  assert.equal(after.events[0].delivery.status, 'retryable');
  assert.equal(after.events[0].delivery.attempts, 1);
  for (const [name, contents] of Object.entries(unchangedFiles)) {
    assert.deepEqual(fs.readFileSync(path.join(fixture.projectRoot, name)), contents, `${name} must remain unchanged`);
  }
}

function drainFixture(fixture) {
  const lifecyclePath = path.join(fixture.projectRoot, 'lifecycle.json');
  const before = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  const unchangedFiles = Object.fromEntries(['.pocket-meta.json', 'log.json', 'remote-marker.md'].map((name) => [
    name,
    fs.readFileSync(path.join(fixture.projectRoot, name)),
  ]));
  const result = runCli(['lifecycle', 'drain', fixture.projectRoot, '--json', '--contract', '3'], {
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      PATH: `${fixture.remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
      REMOTE_CALLS: fixture.remote.remoteCalls,
      GH_CALLS: fixture.remote.ghCalls,
      ...(fixture.executableCalls ? { UNVERIFIED_EXECUTABLE_CALLS: fixture.executableCalls } : {}),
      POCKETTO_LIFECYCLE_NOW: '2026-09-20T12:00:00.000Z',
    },
  });
  assert.equal(result.status, 0, `Core local drain must succeed: ${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.data.deliveries[0].status, 'retryable');
  assert.equal(result.json.data.deliveries[0].error.code, 'ADAPTER_MAJOR_UNVERIFIED');
  assert.equal(fs.readFileSync(fixture.remote.remoteCalls, 'utf8'), '', 'unverified adapter must not be invoked');
  assert.equal(fs.readFileSync(fixture.remote.ghCalls, 'utf8'), '', 'Core must not invoke GitHub');

  assert.equal(result.json.data.deliveries[0].event_id, fixture.eventId);
  assertRetryableLocalState(fixture, lifecyclePath, before, unchangedFiles);
}

function writeMalformedAdapterReleaseMetadata(tempRoot) {
  fs.writeFileSync(path.join(tempRoot, 'package.json'), '{"name":"test-enterprise-adapter","version":"4.0.0"}\n');
  fs.writeFileSync(path.join(tempRoot, 'surfaces.json'), '{"schema":1,"release":{"major":"4"},"roles":{"pi/enterprise":{"kind":"enterprise","includes":["recording-adapter.js"]}}}\n');
}

function createUnknownMajorEvent(projectRoot) {
  const { createHash } = require('node:crypto');
  const lifecycleStore = require('../../cli/lib/lifecycle-store');
  const artifact = 'approved-spec.md';
  const bytes = Buffer.from('Unknown adapter major compatibility fixture.\n');
  fs.writeFileSync(path.join(projectRoot, artifact), bytes);
  fs.writeFileSync(path.join(projectRoot, '.pocket-meta.json'), '{"preserve":"metadata"}\n');
  fs.writeFileSync(path.join(projectRoot, 'log.json'), '{"preserve":"task projection"}\n');
  fs.writeFileSync(path.join(projectRoot, 'remote-marker.md'), '<!-- pocket-plan:compatibility-plan -->\n');
  return lifecycleStore.commitTransition({
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
}

function createUnknownMajorFixture(t, scenario) {
  const tempRoot = tempDirectory(t, 'pocket-compat-unknown-adapter-');
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const remote = installRecordingRemoteBoundary(projectRoot, tempRoot);
  if (scenario.malformed) writeMalformedAdapterReleaseMetadata(tempRoot);
  const committed = createUnknownMajorEvent(projectRoot);
  assert.equal(committed.ok, true, `${scenario.name}: fixture event should commit locally`);
  return { tempRoot, projectRoot, remote, eventId: committed.event.event_id };
}

function snapshotUnknownMajorFixture(fixture) {
  const lifecyclePath = path.join(fixture.projectRoot, 'lifecycle.json');
  const before = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  const unchangedFiles = Object.fromEntries(['.pocket-meta.json', 'log.json', 'remote-marker.md'].map((name) => [
    name,
    fs.readFileSync(path.join(fixture.projectRoot, name)),
  ]));
  return { lifecyclePath, before, unchangedFiles };
}

function drainUnknownMajorFixture(fixture) {
  return runCli(['lifecycle', 'drain', fixture.projectRoot, '--json', '--contract', '3'], {
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      PATH: `${fixture.remote.binDir}${path.delimiter}${process.env.PATH || ''}`,
      REMOTE_CALLS: fixture.remote.remoteCalls,
      GH_CALLS: fixture.remote.ghCalls,
      POCKETTO_LIFECYCLE_NOW: '2026-09-20T12:00:00.000Z',
    },
  });
}

function assertUnknownMajorDelivery(fixture, scenario, result) {
  assert.equal(result.status, 0, `${scenario.name}: Core local drain must remain successful: ${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.data.deliveries[0].event_id, fixture.eventId);
  assert.equal(result.json.data.deliveries[0].status, 'retryable');
  assert.equal(result.json.data.deliveries[0].error.code, 'ADAPTER_MAJOR_UNVERIFIED');
  assert.equal(fs.readFileSync(fixture.remote.remoteCalls, 'utf8'), '', `${scenario.name}: unknown-major adapter must not be invoked`);
  assert.equal(fs.readFileSync(fixture.remote.ghCalls, 'utf8'), '', `${scenario.name}: Core must not invoke GitHub`);
}

function assertUnknownMajorRollback(fixture, scenario, snapshot) {
  const after = JSON.parse(fs.readFileSync(snapshot.lifecyclePath, 'utf8'));
  assert.deepEqual(after.plan, snapshot.before.plan, `${scenario.name}: local plan state must remain intact`);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].event_id, fixture.eventId, `${scenario.name}: pending event identity must survive`);
  assert.equal(after.events[0].delivery.status, 'retryable', `${scenario.name}: the event must remain pending for replay`);
  assertRetryableLocalState(fixture, snapshot.lifecyclePath, snapshot.before, snapshot.unchangedFiles);
  for (const [name, contents] of Object.entries(snapshot.unchangedFiles)) {
    assert.deepEqual(fs.readFileSync(path.join(fixture.projectRoot, name)), contents, `${scenario.name}: ${name} must remain unchanged`);
  }
}

function runUnknownMajorScenario(t, scenario) {
  const fixture = createUnknownMajorFixture(t, scenario);
  const snapshot = snapshotUnknownMajorFixture(fixture);
  const result = drainUnknownMajorFixture(fixture);
  assertUnknownMajorDelivery(fixture, scenario, result);
  assertUnknownMajorRollback(fixture, scenario, snapshot);
}

test('Core does not dispatch to an adapter with an unknown or malformed installed major', async (t) => {
  for (const scenario of [
    { name: 'missing adapter manifest' },
    { name: 'non-integer adapter release major', malformed: true },
  ]) {
    await t.test(scenario.name, (scenarioTest) => runUnknownMajorScenario(scenarioTest, scenario));
  }
});
test('a Core ancestor manifest does not verify an unversioned registered adapter', (t) => {
  const fixture = createAdapterDrainFixture(t);
  const rootManifest = JSON.parse(fs.readFileSync(path.join(fixture.projectRoot, 'surfaces.json'), 'utf8'));
  assert.equal(rootManifest.release.major, 4, 'the project root retains a valid Core v4 manifest');
  assert.equal(rootManifest.schema, 1, 'the project root retains the current surface-manifest schema');
  assert.equal(
    rootManifest.roles['pi/enterprise'].includes.includes('recording-adapter.js'),
    false,
    'the Core manifest does not claim ownership of the registered test adapter',
  );
  assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'package.json')), false, 'the adapter has no owning package manifest');
  drainFixture(fixture);
});

test('an adapter package and its own surface must declare matching majors', (t) => {
  const fixture = createAdapterDrainFixture(t, {
    adapterDirectory: 'enterprise-adapter',
    packageVersion: '3.0.0',
    surfaceMajor: 4,
  });
  const adapterRoot = path.join(fixture.projectRoot, 'enterprise-adapter');
  assert.equal(JSON.parse(fs.readFileSync(path.join(adapterRoot, 'package.json'), 'utf8')).version, '3.0.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(adapterRoot, 'surfaces.json'), 'utf8')).release.major, 4);
  drainFixture(fixture);
});

test('an unrelated owned script cannot attest the invoked executable', (t) => {
  const fixture = createAdapterDrainFixture(t, {
    adapterDirectory: 'enterprise-adapter',
    packageVersion: '4.0.0',
    surfaceMajor: 4,
  });
  const adapterPath = path.join(fixture.projectRoot, 'enterprise-adapter', 'recording-adapter.js');
  const executablePath = path.join(fixture.projectRoot, 'unverified-executable');
  fixture.executableCalls = path.join(fixture.tempRoot, 'unverified-executable-calls.jsonl');
  fs.writeFileSync(fixture.executableCalls, '');
  fs.writeFileSync(executablePath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventFile = process.argv.find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
const event = eventFile ? JSON.parse(fs.readFileSync(eventFile, 'utf8')) : { event_id: 'missing-event' };
fs.appendFileSync(process.env.UNVERIFIED_EXECUTABLE_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
fs.appendFileSync(process.env.REMOTE_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`, { mode: 0o755 });

  const registrationPath = path.join(fixture.projectRoot, '.pocket', 'lifecycle-adapter.json');
  const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  registration.argv = [executablePath, adapterPath];
  fs.writeFileSync(registrationPath, `${JSON.stringify(registration, null, 2)}\n`);

  drainFixture(fixture);
  assert.equal(fs.readFileSync(fixture.executableCalls, 'utf8'), '', 'unverified executable must not be invoked');
});
