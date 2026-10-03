'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'index.js');
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
  nodeArgs.push(CLI, ...args);
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    env: options.env || process.env,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout.trim());
  } catch (_) {
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
const target = path.resolve(process.env.ATOMIC_TARGET);
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
