'use strict';

const {
  test, assert, fs, os, path, spawnSync, enterpriseRegistration,
  ROOT, CLI, ENTERPRISE_CLI, V3_FIXTURE,
  tempDirectory, copyV3Plan, snapshotTree, runCli,
  installRecordingRemoteBoundary, createAtomicObserver,
} = require('./support');

test('Core does not dispatch to an adapter with an unknown or malformed installed major', (t) => {
  const { createHash } = require('node:crypto');
  const lifecycleStore = require('../../cli/lib/lifecycle-store');

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
