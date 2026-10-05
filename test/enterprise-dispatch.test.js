'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { invokeAdapter, readAdapterRegistration } = require('../cli/lib/lifecycle-adapter');
const enterpriseMeta = require('../enterprise/meta');
const { createLifecycleDelivery } = require('../enterprise/lifecycle-delivery');
const { dispatchEvent } = require('../enterprise/adapter');
const { handlers: registeredHandlers } = require('../enterprise/dispatch');

const CLI = path.resolve(__dirname, '../enterprise/cli.js');
const CORE_CLI = path.resolve(__dirname, '../cli/index.js');
const DISPATCH = path.resolve(__dirname, '../enterprise/dispatch.js');
const PLAN_ID = 'registered-runner-fixture';
const REPOSITORY = 'acme/pocketto';
const ISSUE_NUMBER = 73;
const PR_NUMBER = 84;
const ISSUE_URL = `https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}`;
const PR_URL = `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`;
const PHASE_PATH = 'execution-plan/phase-1.md';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeEvent(type, revision, refs) {
  return {
    event_id: `${PLAN_ID}:${type}:r${revision}`,
    plan_id: PLAN_ID,
    type,
    revision,
    occurred_at: '2026-09-19T12:00:00.000Z',
    artifact_refs: refs,
    payload_hash: 'a'.repeat(64),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 0 },
  };
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { exit: 0, stdout, json: JSON.parse(stdout) };
  } catch (error) {
    const stdout = String(error.stdout || '');
    let json = null;
    try { json = JSON.parse(stdout); } catch { /* keep null */ }
    return { exit: error.status ?? 1, stdout, json };
  }
}

function runCoreCli(args, options) {
  const stdout = execFileSync(process.execPath, [CORE_CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
    env: options.env,
  });
  return { stdout, json: JSON.parse(stdout) };
}

function writeDispatchObserver(root) {
  const observerPath = path.join(root, 'observe-dispatch.js');
  fs.writeFileSync(observerPath, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const watchedPaths = new Set(JSON.parse(process.env.FORBIDDEN_FILE_IO_PATHS || '[]').map((item) => path.resolve(item)));
const fileIoTrace = process.env.FORBIDDEN_FILE_IO_TRACE;
for (const method of ['existsSync', 'statSync', 'readFileSync', 'writeFileSync']) {
  const original = fs[method];
  fs[method] = function observeExternalFileAccess(target, ...args) {
    if (typeof target === 'string' && watchedPaths.has(path.resolve(target)) && fileIoTrace) {
      fs.appendFileSync(fileIoTrace, JSON.stringify({ method, path: path.resolve(target) }) + '\\n');
    }
    return original.call(this, target, ...args);
  };
}
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function observeAdapterEvent(command, args, options) {
  if (command === process.execPath && Array.isArray(args)
      && args[0] === process.env.ENTERPRISE_DISPATCH_PATH) {
    const eventPath = args.find((arg) => typeof arg === 'string' && path.basename(arg) === 'event.json');
    if (eventPath) {
      const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
      fs.appendFileSync(process.env.ADAPTER_EVENT_TRACE,
        JSON.stringify({ event_id: event.event_id, delivery_status: event.delivery.status }) + '\\n');
    }
  }
  return originalSpawnSync.call(this, command, args, options);
};
`);
  return observerPath;
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const specDir = path.join(root, 'docs', 'pocket', 'spec', PLAN_ID);
  const planDir = path.join(root, 'docs', 'pocket', 'plans', PLAN_ID);
  const phaseFile = path.join(planDir, PHASE_PATH);
  fs.mkdirSync(specDir, { recursive: true });
  fs.mkdirSync(path.dirname(phaseFile), { recursive: true });
  fs.mkdirSync(path.join(planDir, 'reviews'), { recursive: true });

  const approvedSpec = '# Approved specification\n\nA subprocess integration fixture.\n';
  fs.writeFileSync(path.join(specDir, 'approved-spec.md'), approvedSpec);
  const phaseEvidence = '# Phase 1\n\nContains tasks: T1\n';
  fs.writeFileSync(phaseFile, phaseEvidence);
  const log = {
    header: {
      plan_dir: `docs/pocket/plans/${PLAN_ID}`,
      plan_type: 'phased',
      status: 'DONE',
      date_started: '2026-09-19',
      date_completed: '2026-09-20',
    },
    phases: [{
      order: 1,
      file: PHASE_PATH,
      status: 'DONE',
      tasks: [{ id: 'T1', name: 'Exercise registered dispatch', status: 'DONE', done_sha: 'abc123' }],
    }],
  };
  fs.writeFileSync(path.join(planDir, 'log.json'), `${JSON.stringify(log, null, 2)}\n`);
  fs.writeFileSync(path.join(planDir, 'reviews', 'T1-review.json'), `${JSON.stringify({
    task_id: 'T1', overall: 'REVIEW_PASS', stage_1: { issues: [] }, stage_2: { issues: [] },
  }, null, 2)}\n`);

  // Relative lifecycle directories must be resolved from the registered projectRoot,
  // not from Core's subprocess cwd.
  fs.writeFileSync(path.join(specDir, 'lifecycle.json'), `${JSON.stringify({
    schema: 1,
    plan: {
      plan_id: PLAN_ID,
      spec_dir: `docs/pocket/spec/${PLAN_ID}`,
      plan_dir: `docs/pocket/plans/${PLAN_ID}`,
      branch: `feature/${PLAN_ID}`,
      state: { approval: 'APPROVED', phase_status: { 'phase-1': 'COMPLETE' }, status: 'DONE' },
      revision: 3,
    },
    events: [],
  }, null, 2)}\n`);

  enterpriseMeta.setIssueIdentity(specDir, { number: ISSUE_NUMBER, url: ISSUE_URL });
  enterpriseMeta.setPrIdentity(specDir, 'phase-1', { number: PR_NUMBER, url: PR_URL });

  const specEvent = makeEvent('spec-approved', 1, [{
    root: 'spec', kind: 'approved-spec', path: 'approved-spec.md', sha256: sha256(approvedSpec), revision: 1,
  }]);
  const phaseEvent = makeEvent('phase-complete', 2, [{
    root: 'plan', kind: 'phase-evidence', path: PHASE_PATH, sha256: sha256(phaseEvidence), revision: 1,
  }]);
  const closeEvent = makeEvent('plan-closed', 3, [{
    root: 'plan', kind: 'log', path: 'log.json', sha256: sha256(fs.readFileSync(path.join(planDir, 'log.json'))), revision: 1,
  }]);
  return { root, specDir, planDir, specEvent, phaseEvent, closeEvent };
}

function writeFakeGh(root, tracePath) {
  const binDir = path.join(root, 'test-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ghPath = path.join(binDir, 'gh');
  const script = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_TRACE, JSON.stringify(args) + '\\n');
const repo = { owner: { login: 'acme' }, name: 'pocketto', nameWithOwner: '${REPOSITORY}', url: 'https://github.com/${REPOSITORY}' };
const issue = {
  number: ${ISSUE_NUMBER}, url: '${ISSUE_URL}', html_url: '${ISSUE_URL}', state: 'OPEN',
  title: 'Pocket Plan: ${PLAN_ID}', body: 'Approved specification: docs/pocket/spec/${PLAN_ID}/approved-spec.md',
  labels: [{ name: 'pocket-plan' }], createdAt: '2026-09-19T12:00:00.000Z',
  repository: { full_name: '${REPOSITORY}' }
};
const pr = {
  number: ${PR_NUMBER}, url: '${PR_URL}', state: 'OPEN', headRefName: 'feature/${PLAN_ID}',
  baseRefName: 'main', headRefOid: 'abc123def456', title: 'Phase 1: ${PLAN_ID}', body: '${PLAN_ID}'
};
const json = (value) => process.stdout.write(JSON.stringify(value));
const field = (name) => {
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === '-f' || args[i] === '-F') && args[i + 1].startsWith(name + '=')) return args[i + 1].slice(name.length + 1);
  }
  return null;
};
if (args[0] === 'repo' && args[1] === 'view') { json(repo); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'view') { json(issue); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'list') { json([]); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'create') { process.stdout.write('${ISSUE_URL}\\n'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view') { json(pr); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'list') { json([pr]); process.exit(0); }
if (args[0] === 'api' && args[1] === 'graphql') {
  json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'repos/${REPOSITORY}/issues/${ISSUE_NUMBER}') { json(issue); process.exit(0); }
if (args[0] === 'api' && /\\/issues\\/\\d+\\/comments$/.test(args[1] || '') && args.includes('--paginate')) { json([]); process.exit(0); }
if (args[0] === 'api' && /\\/issues\\/\\d+\\/comments$/.test(args[1] || '') && field('body') !== null) {
  json({ id: 900, body: field('body') }); process.exit(0);
}
process.stderr.write('fake gh rejected unexpected request');
process.exit(1);
`;
  fs.writeFileSync(ghPath, script, { mode: 0o755 });
  fs.chmodSync(ghPath, 0o755);
  return { binDir, ghPath, tracePath };
}

function readCalls(tracePath) {
  const text = fs.readFileSync(tracePath, 'utf8');
  return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

function registeredAdapter(root) {
  const loaded = readAdapterRegistration(root);
  assert.equal(loaded.error, null, loaded.error && loaded.error.message);
  assert.ok(loaded.registration, 'Core must load the real installed registration');
  return loaded.registration;
}

function setLifecycleWatermark(fixture, lastAppliedRevision) {
  const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.lifecycle_delivery = {
    schema: 1,
    plan_id: PLAN_ID,
    last_applied_revision: lastAppliedRevision,
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

function prepareRegisteredRunner(t, fixture) {
  const tracePath = path.join(fixture.root, 'fake-gh.jsonl');
  fs.writeFileSync(tracePath, '');
  const fakeGh = writeFakeGh(fixture.root, tracePath);
  const oldPath = process.env.PATH;
  const oldTrace = process.env.FAKE_GH_TRACE;
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.PATH = `${fakeGh.binDir}${path.delimiter}${oldPath || ''}`;
  process.env.FAKE_GH_TRACE = tracePath;
  process.env.GITHUB_TOKEN = 'ghp_symlink_guard_secret_must_never_escape';
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTrace === undefined) delete process.env.FAKE_GH_TRACE;
    else process.env.FAKE_GH_TRACE = oldTrace;
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
  });

  const installed = runCli(['install', fixture.root, '--json']);
  assert.equal(installed.exit, 0, `default install must register the event adapter: ${installed.stdout}`);
  return { tracePath, record: registeredAdapter(fixture.root) };
}

function snapshotTree(root) {
  const snapshot = {};
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(absolute, name);
      else if (entry.isFile()) snapshot[name] = fs.readFileSync(absolute);
      else snapshot[name] = `<${entry.isSymbolicLink() ? 'symlink' : 'other'}>`;
    }
  };
  visit(root);
  return snapshot;
}

function assertBoundedFailure(response, event) {
  assert.equal(response.event_id, event.event_id);
  assert.notEqual(response.status, 'succeeded');
  assert.ok(response.error, 'a rejected event must include a bounded adapter error');
  assert.ok(Object.keys(response).every((key) => ['event_id', 'status', 'proof_ref', 'proof_hash', 'error'].includes(key)),
    'Core must receive only the bounded adapter response fields');
}

function assertRawResponse(response, event) {
  assert.equal(response.event_id, event.event_id, 'adapter response must preserve the original event ID');
  assert.equal(response.status, 'succeeded');
  assert.ok(Object.keys(response).every((key) => ['event_id', 'status', 'proof_ref', 'proof_hash', 'error'].includes(key)),
    'Core must receive the raw bounded adapter object, not an envelope');
  assert.equal(typeof response.proof_ref, 'string');
  assert.match(response.proof_hash, /^[0-9a-f]{64}$/);
}

function symlinkToExternalFile(t, localPath, prefix, contents) {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const externalPath = path.join(externalRoot, path.basename(localPath));
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  fs.writeFileSync(externalPath, bytes);
  fs.rmSync(localPath, { force: true });
  fs.symlinkSync(externalPath, localPath, 'file');
  return { externalPath, externalBefore: Buffer.from(bytes) };
}

test('registered phase-complete rejects phase evidence file symlinks escaping the plan root before GitHub', (t) => {
  const fixture = createFixture(t);
  const phaseEvidence = '# Phase 1\n\nContains tasks: T1\n';
  const external = symlinkToExternalFile(
    t,
    path.join(fixture.planDir, PHASE_PATH),
    'enterprise-dispatch-external-phase-evidence-',
    phaseEvidence,
  );
  const { tracePath, record } = prepareRegisteredRunner(t, fixture);

  const response = invokeAdapter(fixture.phaseEvent, record);

  assert.equal(readCalls(tracePath).length, 0,
    `symlinked phase evidence must be rejected before fake GitHub; handler status was ${response.status}`);
  assertBoundedFailure(response, fixture.phaseEvent);
  assert.deepEqual(fs.readFileSync(external.externalPath), external.externalBefore,
    'the external phase evidence sentinel must remain unchanged');
});

test('registered phase-complete rejects review JSON symlinks escaping the plan root before GitHub', (t) => {
  const fixture = createFixture(t);
  const externalReport = `${JSON.stringify({
    task_id: 'T1', overall: 'REVIEW_PASS', stage_1: { issues: [] }, stage_2: { issues: [] },
  }, null, 2)}\n`;
  const external = symlinkToExternalFile(
    t,
    path.join(fixture.planDir, 'reviews', 'T1-review.json'),
    'enterprise-dispatch-external-review-',
    externalReport,
  );
  const { tracePath, record } = prepareRegisteredRunner(t, fixture);

  const response = invokeAdapter(fixture.phaseEvent, record);

  assert.equal(readCalls(tracePath).length, 0,
    `symlinked review JSON must be rejected before fake GitHub; handler status was ${response.status}`);
  assertBoundedFailure(response, fixture.phaseEvent);
  assert.deepEqual(fs.readFileSync(external.externalPath), external.externalBefore,
    'the external review report sentinel must remain unchanged');
});

test('registered plan-closed rejects log.json symlinks escaping the plan root before GitHub', (t) => {
  const fixture = createFixture(t);
  const external = symlinkToExternalFile(
    t,
    path.join(fixture.planDir, 'log.json'),
    'enterprise-dispatch-external-log-',
    fs.readFileSync(path.join(fixture.planDir, 'log.json')),
  );
  const { tracePath, record } = prepareRegisteredRunner(t, fixture);

  const response = invokeAdapter(fixture.closeEvent, record);

  assert.equal(readCalls(tracePath).length, 0,
    `symlinked log.json must be rejected before fake GitHub; handler status was ${response.status}`);
  assertBoundedFailure(response, fixture.closeEvent);
  assert.deepEqual(fs.readFileSync(external.externalPath), external.externalBefore,
    'the external log sentinel must remain unchanged');
});

test('registered plan-closed rejects closeout.md symlinks without overwriting external targets', (t) => {
  const fixture = createFixture(t);
  const external = symlinkToExternalFile(
    t,
    path.join(fixture.planDir, 'closeout.md'),
    'enterprise-dispatch-external-closeout-',
    'external closeout sentinel must remain byte-for-byte unchanged\n',
  );
  const { tracePath, record } = prepareRegisteredRunner(t, fixture);

  const response = invokeAdapter(fixture.closeEvent, record);

  assert.deepEqual(fs.readFileSync(external.externalPath), external.externalBefore,
    `T10 must not overwrite the external closeout target; status=${response.status}, fake-gh-calls=${readCalls(tracePath).length}`);
  assert.equal(readCalls(tracePath).length, 0,
    'a symlinked closeout target must be rejected before fake GitHub');
  assertBoundedFailure(response, fixture.closeEvent);
});

test('Core invokes the packaged Enterprise runner for all concrete handlers through the registered event-file protocol', (t) => {
  const fixture = createFixture(t);
  const tracePath = path.join(fixture.root, 'fake-gh.jsonl');
  fs.writeFileSync(tracePath, '');
  const fakeGh = writeFakeGh(fixture.root, tracePath);
  const oldPath = process.env.PATH;
  const oldTrace = process.env.FAKE_GH_TRACE;
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.PATH = `${fakeGh.binDir}${path.delimiter}${oldPath || ''}`;
  process.env.FAKE_GH_TRACE = tracePath;
  process.env.GITHUB_TOKEN = 'ghp_dispatch_secret_must_never_escape';
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTrace === undefined) delete process.env.FAKE_GH_TRACE;
    else process.env.FAKE_GH_TRACE = oldTrace;
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
  });

  const installed = runCli(['install', fixture.root, '--json']);
  assert.equal(installed.exit, 0, `default install must register a runnable event adapter: ${installed.stdout}`);
  assert.equal(installed.json.ok, true);
  const registrationPath = path.join(fixture.root, '.pocket', 'lifecycle-adapter.json');
  const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  assert.deepEqual(registration.argv, [process.execPath, DISPATCH, fixture.root],
    'default argv must pin Node, the packaged dispatcher, and this explicit project root');
  assert.deepEqual(registration.events, ['spec-approved', 'phase-complete', 'plan-closed']);

  const record = registeredAdapter(fixture.root);
  const beforeSpec = readCalls(tracePath).length;
  const specResponse = invokeAdapter(fixture.specEvent, record);
  assertRawResponse(specResponse, fixture.specEvent);
  const specCalls = readCalls(tracePath).slice(beforeSpec);
  assert.ok(specCalls.some((args) => args[0] === 'issue' && args[1] === 'view' && args[2] === String(ISSUE_NUMBER)),
    'spec-approved must reach T8 issue ownership reconciliation');

  const beforePhase = readCalls(tracePath).length;
  const phaseResponse = invokeAdapter(fixture.phaseEvent, record);
  assertRawResponse(phaseResponse, fixture.phaseEvent);
  const phaseCalls = readCalls(tracePath).slice(beforePhase);
  assert.ok(phaseCalls.some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === String(PR_NUMBER)),
    'phase-complete must reach T9 PR reconciliation');
  assert.ok(phaseCalls.some((args) => args[0] === 'api' && args[1] === 'graphql'),
    'phase-complete must run T9 review-thread reconciliation');

  const beforeClose = readCalls(tracePath).length;
  const closeResponse = invokeAdapter(fixture.closeEvent, record);
  assertRawResponse(closeResponse, fixture.closeEvent);
  const closeCalls = readCalls(tracePath).slice(beforeClose);
  assert.ok(closeCalls.some((args) => args[0] === 'api' && args[1] === `repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`),
    'plan-closed must reach T10 linked issue validation');
  assert.ok(closeCalls.some((args) => args[0] === 'api' && args[1] === `repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/comments`),
    'plan-closed must reach T10 tasklist marker reconciliation');
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true,
    'T10 must write its local closeout artifact in lifecycle-derived planDir');

  const secret = process.env.GITHUB_TOKEN;
  for (const response of [specResponse, phaseResponse, closeResponse]) {
    const serialized = JSON.stringify(response);
    assert.ok(!serialized.includes(secret), 'adapter responses must not contain environment credentials');
    assert.ok(!serialized.includes(ISSUE_URL), 'adapter responses must not contain remote issue URLs');
    assert.ok(!serialized.includes(PR_URL), 'adapter responses must not contain remote PR URLs');
  }
  assert.ok(readCalls(tracePath).length > 0, 'all remote operations must pass through the fake gh executable');
});

function setupRegisteredDispatch(t, fixture = createFixture(t)) {
  const tracePath = path.join(fixture.root, 'fake-gh-drain.jsonl');
  const eventTracePath = path.join(fixture.root, 'adapter-events.jsonl');
  fs.writeFileSync(tracePath, '');
  fs.writeFileSync(eventTracePath, '');
  const fakeGh = writeFakeGh(fixture.root, tracePath);
  const observerPath = writeDispatchObserver(fixture.root);
  const installed = runCli(['install', fixture.root, '--json']);
  assert.equal(installed.exit, 0, `default install must register the executable adapter: ${installed.stdout}`);
  assert.equal(installed.json.ok, true);
  const lifecyclePath = path.join(fixture.specDir, 'lifecycle.json');
  const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  const env = {
    ...process.env,
    PATH: `${fakeGh.binDir}${path.delimiter}${process.env.PATH || ''}`,
    FAKE_GH_TRACE: tracePath,
    GITHUB_TOKEN: 'ghp_drain_secret_must_never_escape',
    POCKETTO_LIFECYCLE_NOW: '2026-09-19T12:00:00.000Z',
    ADAPTER_EVENT_TRACE: eventTracePath,
    ENTERPRISE_DISPATCH_PATH: DISPATCH,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${observerPath}`].filter(Boolean).join(' '),
  };
  return { fixture, tracePath, eventTracePath, lifecyclePath, lifecycle, env };
}

function observeFilePaths(env, root, watchedPaths) {
  const tracePath = path.join(root, 'forbidden-file-io.jsonl');
  const normalizedPaths = new Set();
  for (const target of watchedPaths) {
    const absolute = path.resolve(target);
    normalizedPaths.add(absolute);
    try { normalizedPaths.add(fs.realpathSync(absolute)); } catch { /* dangling targets retain their lexical path */ }
    try {
      normalizedPaths.add(path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute)));
    } catch { /* preserve the lexical path when the parent is unavailable */ }
  }
  fs.writeFileSync(tracePath, '');
  env.FORBIDDEN_FILE_IO_TRACE = tracePath;
  env.FORBIDDEN_FILE_IO_PATHS = JSON.stringify([...normalizedPaths]);
  return tracePath;
}

function readObservedFileIo(tracePath) {
  const contents = fs.readFileSync(tracePath, 'utf8').trim();
  return contents ? contents.split('\n').map((line) => JSON.parse(line)) : [];
}

function runCoreDrainEvent(fixture, lifecyclePath, lifecycle, env, event) {
  const readyEvent = {
    ...event,
    event_id: `${PLAN_ID}:${event.type}:r1`,
    revision: 1,
    delivery: { status: 'pending', attempts: 0 },
  };
  lifecycle.plan.revision = 1;
  lifecycle.events = [readyEvent];
  fs.writeFileSync(lifecyclePath, `${JSON.stringify(lifecycle, null, 2)}\n`);
  const drain = runCoreCli(
    ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
    { cwd: fixture.root, env },
  );
  assert.equal(drain.json.ok, true, `Core drain should return its JSON envelope: ${drain.stdout}`);
  const delivery = drain.json.data.deliveries.find((item) => item.event_id === readyEvent.event_id);
  assert.ok(delivery, `Core drain should report ${readyEvent.event_id}`);
  return { drain, readyEvent, delivery };
}

function withProcessEnvironment(env, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function symlinkMetadataOutsideProject(t, fixture, prefix) {
  const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
  const sentinelBytes = fs.readFileSync(metadataPath);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const externalPath = path.join(externalRoot, '.pocket-meta.json');
  fs.writeFileSync(externalPath, sentinelBytes);
  fs.rmSync(metadataPath);
  fs.symlinkSync(externalPath, metadataPath, 'file');
  return { metadataPath, externalPath, sentinelBytes };
}

test('Core drain dispatches claimed spec, phase, and closure events through the registered Enterprise executable', (t) => {
  const { fixture, tracePath, eventTracePath, lifecyclePath, lifecycle, env } = setupRegisteredDispatch(t);
  const events = [fixture.specEvent, fixture.phaseEvent, fixture.closeEvent].map((event) => ({
    ...event,
    delivery: { status: 'pending', attempts: 0 },
  }));
  lifecycle.plan.revision = events.length;
  lifecycle.events = events;
  fs.writeFileSync(lifecyclePath, `${JSON.stringify(lifecycle, null, 2)}\n`);

  const drain = runCoreCli(
    ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
    { cwd: fixture.root, env },
  );
  assert.equal(drain.json.ok, true, `Core drain should return its JSON envelope: ${drain.stdout}`);
  const observed = fs.readFileSync(eventTracePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(observed[0], {
    event_id: events[0].event_id,
    delivery_status: 'claimed',
  }, 'Core must persist claimed before invoking the registered Enterprise executable');
  assert.deepEqual(drain.json.data.deliveries.map(({ event_id, status }) => ({ event_id, status })),
    events.map((event) => ({ event_id: event.event_id, status: 'succeeded' })),
    `normal claimed attempts must reconcile instead of terminal-failing: ${JSON.stringify(drain.json.data.deliveries)}`);
  assert.deepEqual(observed, events.map((event) => ({
    event_id: event.event_id,
    delivery_status: 'claimed',
  })), 'all three real adapter invocations must receive the Core claimed state');

  const persisted = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  assert.equal(persisted.events.length, 3, 'drain must not create lifecycle events');
  assert.deepEqual(persisted.events.map((event) => event.event_id), events.map((event) => event.event_id));
  assert.ok(persisted.events.every((event) => event.delivery.status === 'succeeded'));
  assert.ok(persisted.events.every((event) => typeof event.delivery.proof_ref === 'string'
    && /^[0-9a-f]{64}$/.test(event.delivery.proof_hash || '')));

  const ghCalls = readCalls(tracePath);
  assert.ok(ghCalls.some((args) => args[0] === 'issue' && args[1] === 'view' && args[2] === String(ISSUE_NUMBER)),
    'claimed spec-approved must reach T8 issue reconciliation');
  assert.ok(ghCalls.some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === String(PR_NUMBER)),
    'claimed phase-complete must reach T9 PR reconciliation');
  assert.ok(ghCalls.some((args) => args[0] === 'api' && args[1] === 'graphql'),
    'claimed phase-complete must run T9 review-thread reconciliation');
  assert.ok(ghCalls.some((args) => args[0] === 'api'
    && args[1] === `repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/comments`),
  'claimed plan-closed must reach T10 tasklist marker reconciliation');
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true,
    'T10 must write its local closeout after the claimed attempt');
});

test('Core drain rejects T8 artifact symlink escapes before any followed file access', async (t) => {
  await t.test('hash-matching external artifact target is not statted or read', (t) => {
    const fixture = createFixture(t);
    const approvedPath = path.join(fixture.specDir, 'approved-spec.md');
    const approvedBytes = fs.readFileSync(approvedPath);
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-dispatch-artifact-'));
    t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
    const externalPath = path.join(externalRoot, 'approved-spec.md');
    fs.writeFileSync(externalPath, approvedBytes);
    fs.rmSync(approvedPath);
    fs.symlinkSync(externalPath, approvedPath, 'file');

    const setup = setupRegisteredDispatch(t, fixture);
    const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
    const metadataBefore = fs.readFileSync(metadataPath);
    const fileIoTrace = observeFilePaths(setup.env, fixture.root, [approvedPath, externalPath]);
    assert.equal(sha256(fs.readFileSync(externalPath)), fixture.specEvent.artifact_refs[0].sha256,
      'the external target must pass the event hash check if read');

    const { delivery } = runCoreDrainEvent(
      fixture, setup.lifecyclePath, setup.lifecycle, setup.env, fixture.specEvent,
    );

    assert.equal(delivery.status, 'terminal');
    assert.equal(delivery.error.code, 'STALE_ARTIFACT');
    assert.equal(readCalls(setup.tracePath).length, 0, 'artifact containment must precede every GitHub call');
    assert.deepEqual(readObservedFileIo(fileIoTrace), [],
      'external artifact bytes must not be statted, read, or written before rejection');
    assert.deepEqual(fs.readFileSync(metadataPath), metadataBefore, 'metadata must remain byte-identical');
    assert.deepEqual(fs.readFileSync(externalPath), approvedBytes, 'the external artifact must remain byte-identical');
    assert.ok(!JSON.stringify(delivery).includes(externalPath), 'terminal diagnostics must not disclose the external path');
  });

  await t.test('a later escaping ref is rejected even when the first ref is safe', (t) => {
    const fixture = createFixture(t);
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-dispatch-later-artifact-'));
    t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
    const externalPath = path.join(externalRoot, 'later-spec.md');
    const externalBytes = Buffer.from('# Later artifact\n\nMust be rejected before any content read.\n');
    fs.writeFileSync(externalPath, externalBytes);
    const laterPath = path.join(fixture.specDir, 'later-spec.md');
    fs.symlinkSync(externalPath, laterPath, 'file');

    const setup = setupRegisteredDispatch(t, fixture);
    const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
    const metadataBefore = fs.readFileSync(metadataPath);
    const fileIoTrace = observeFilePaths(setup.env, fixture.root, [laterPath, externalPath]);
    const event = {
      ...fixture.specEvent,
      artifact_refs: [...fixture.specEvent.artifact_refs, {
        root: 'spec', kind: 'supporting-spec', path: 'later-spec.md',
        sha256: sha256(externalBytes), revision: 1,
      }],
    };

    const { delivery } = runCoreDrainEvent(fixture, setup.lifecyclePath, setup.lifecycle, setup.env, event);

    assert.equal(delivery.status, 'terminal');
    assert.equal(delivery.error.code, 'STALE_ARTIFACT');
    assert.equal(readCalls(setup.tracePath).length, 0, 'all refs must be contained before reconciliation');
    assert.deepEqual(readObservedFileIo(fileIoTrace), [], 'later escaping refs must not be followed');
    assert.deepEqual(fs.readFileSync(metadataPath), metadataBefore);
    assert.deepEqual(fs.readFileSync(externalPath), externalBytes);
    assert.ok(!JSON.stringify(delivery).includes(externalPath));
  });
});

test('Core drain rejects T8 spec directories redirected to sibling plans inside the project', (t) => {
  const fixture = createFixture(t);
  const siblingSpecDir = path.join(path.dirname(fixture.specDir), `${PLAN_ID}-sibling`);
  fs.cpSync(fixture.specDir, siblingSpecDir, { recursive: true });
  const siblingArtifact = path.join(siblingSpecDir, 'approved-spec.md');
  const siblingMetadata = path.join(siblingSpecDir, '.pocket-meta.json');
  const metadataBefore = fs.readFileSync(siblingMetadata);
  fs.rmSync(fixture.specDir, { recursive: true, force: true });
  fs.symlinkSync(siblingSpecDir, fixture.specDir, 'dir');

  const setup = setupRegisteredDispatch(t, fixture);
  const artifactAlias = path.join(fixture.specDir, 'approved-spec.md');
  const metadataAlias = path.join(fixture.specDir, '.pocket-meta.json');
  const fileIoTrace = observeFilePaths(setup.env, fixture.root, [
    siblingArtifact, artifactAlias, siblingMetadata, metadataAlias,
  ]);

  const { delivery } = runCoreDrainEvent(
    fixture, setup.lifecyclePath, setup.lifecycle, setup.env, fixture.specEvent,
  );

  assert.equal(delivery.status, 'terminal');
  assert.equal(delivery.error.code, 'STALE_ARTIFACT');
  assert.equal(readCalls(setup.tracePath).length, 0, 'cross-plan context must be rejected before GitHub');
  assert.deepEqual(readObservedFileIo(fileIoTrace), [], 'sibling artifact and metadata contents must not be followed');
  assert.deepEqual(fs.readFileSync(siblingMetadata), metadataBefore, 'sibling metadata must remain byte-identical');
  assert.ok(!JSON.stringify(delivery).includes(siblingSpecDir), 'terminal diagnostics must not disclose the sibling path');
});

test('Core drain rejects external metadata symlinks before GitHub or external file access for T8, T9, and T10', async (t) => {
  const cases = [
    { type: 'spec-approved', property: 'specEvent', code: 'ISSUE_METADATA_PATH_INVALID' },
    { type: 'phase-complete', property: 'phaseEvent', code: 'PHASE_METADATA_PATH_INVALID' },
    { type: 'plan-closed', property: 'closeEvent', code: 'CLOSEOUT_METADATA_PATH_INVALID' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.type, (t) => {
      const fixture = createFixture(t);
      const setup = setupRegisteredDispatch(t, fixture);
      const external = symlinkMetadataOutsideProject(t, fixture, `enterprise-dispatch-${scenario.type}-metadata-`);
      const metadataAlias = path.join(fixture.specDir, '.pocket-meta.json');
      const fileIoTrace = observeFilePaths(setup.env, fixture.root, [metadataAlias, external.externalPath]);

      const { delivery } = runCoreDrainEvent(
        fixture, setup.lifecyclePath, setup.lifecycle, setup.env, fixture[scenario.property],
      );

      assert.equal(delivery.status, 'terminal');
      assert.equal(delivery.error.code, scenario.code, 'the metadata guard must be the failing validation');
      assert.equal(readCalls(setup.tracePath).length, 0, 'metadata preflight must precede all GitHub calls');
      assert.deepEqual(readObservedFileIo(fileIoTrace), [], 'external metadata must not be exists/stat/read/written');
      assert.deepEqual(fs.readFileSync(external.externalPath), external.sentinelBytes,
        'the external valid metadata sentinel must remain byte-identical');
      assert.equal(fs.lstatSync(metadataAlias).isSymbolicLink(), true, 'the local metadata symlink must remain intact');
      assert.ok(!JSON.stringify(delivery).includes(external.externalPath), 'terminal diagnostics must not disclose the target');
      if (scenario.type === 'plan-closed') {
        assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), false,
          'T10 must not write closeout after metadata preflight fails');
      }
    });
  }
});

test('metadata absence is allowed only for initial T8 creation, while T9 and T10 stop before GitHub', async (t) => {
  const cases = [
    { type: 'spec-approved', property: 'specEvent', status: 'succeeded' },
    { type: 'phase-complete', property: 'phaseEvent', status: 'terminal', code: 'PHASE_METADATA_MISSING' },
    { type: 'plan-closed', property: 'closeEvent', status: 'terminal', code: 'CLOSEOUT_METADATA_MISSING' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.type, (t) => {
      const fixture = createFixture(t);
      const setup = setupRegisteredDispatch(t, fixture);
      const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
      fs.rmSync(metadataPath, { force: true });

      const { delivery } = runCoreDrainEvent(
        fixture, setup.lifecyclePath, setup.lifecycle, setup.env, fixture[scenario.property],
      );

      assert.equal(delivery.status, scenario.status);
      if (scenario.code) {
        assert.equal(delivery.error.code, scenario.code);
        assert.equal(readCalls(setup.tracePath).length, 0, 'missing T9/T10 metadata must fail before GitHub');
        assert.equal(fs.existsSync(metadataPath), false, 'missing metadata must not be synthesized for T9/T10');
      } else {
        assert.ok(fs.statSync(metadataPath).isFile(), 'T8 must create metadata on its initial successful reconciliation');
        assert.ok(readCalls(setup.tracePath).length > 0, 'initial T8 creation must reconcile with GitHub');
      }
    });
  }
});

test('Core drain rejects dangling metadata and artifact symlinks as terminal', async (t) => {
  const cases = [
    { type: 'spec-approved', property: 'specEvent', metadata: true, code: 'ISSUE_METADATA_PATH_INVALID' },
    { type: 'phase-complete', property: 'phaseEvent', metadata: true, code: 'PHASE_METADATA_PATH_INVALID' },
    { type: 'plan-closed', property: 'closeEvent', metadata: true, code: 'CLOSEOUT_METADATA_PATH_INVALID' },
    { type: 'spec-approved', property: 'specEvent', metadata: false, code: 'STALE_ARTIFACT' },
  ];
  for (const scenario of cases) {
    await t.test(`${scenario.type} ${scenario.metadata ? 'metadata' : 'artifact'}`, (t) => {
      const fixture = createFixture(t);
      const setup = setupRegisteredDispatch(t, fixture);
      const danglingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-dispatch-dangling-'));
      t.after(() => fs.rmSync(danglingRoot, { recursive: true, force: true }));
      const danglingTarget = path.join(danglingRoot, 'missing-target.json');
      let alias;
      if (scenario.metadata) {
        alias = path.join(fixture.specDir, '.pocket-meta.json');
        fs.rmSync(alias, { force: true });
        fs.symlinkSync(danglingTarget, alias, 'file');
      } else {
        alias = path.join(fixture.specDir, 'approved-spec.md');
        fs.rmSync(alias, { force: true });
        fs.symlinkSync(danglingTarget, alias, 'file');
      }
      const fileIoTrace = observeFilePaths(setup.env, fixture.root, [alias, danglingTarget]);

      const { delivery } = runCoreDrainEvent(
        fixture, setup.lifecyclePath, setup.lifecycle, setup.env, fixture[scenario.property],
      );

      assert.equal(delivery.status, 'terminal');
      assert.equal(delivery.error.code, scenario.code);
      assert.equal(readCalls(setup.tracePath).length, 0, 'dangling paths must be rejected before GitHub');
      assert.deepEqual(readObservedFileIo(fileIoTrace), [], 'a dangling link must never be followed by file I/O');
      assert.ok(!JSON.stringify(delivery).includes(danglingRoot));
    });
  }
});

test('Core drain allows artifact and metadata symlinks whose targets remain in the same spec directory', async (t) => {
  await t.test('internal artifact symlink', (t) => {
    const fixture = createFixture(t);
    const artifactPath = path.join(fixture.specDir, 'approved-spec.md');
    const targetPath = path.join(fixture.specDir, 'approved-spec-target.md');
    fs.renameSync(artifactPath, targetPath);
    fs.symlinkSync(targetPath, artifactPath, 'file');
    const setup = setupRegisteredDispatch(t, fixture);

    const { delivery } = runCoreDrainEvent(
      fixture, setup.lifecyclePath, setup.lifecycle, setup.env, fixture.specEvent,
    );

    assert.equal(delivery.status, 'succeeded', JSON.stringify(delivery));
    assert.ok(readCalls(setup.tracePath).length > 0);
  });

  await t.test('internal metadata symlink', (t) => {
    const fixture = createFixture(t);
    const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
    const targetPath = path.join(fixture.specDir, '.pocket-meta-target.json');
    fs.renameSync(metadataPath, targetPath);
    fs.symlinkSync(targetPath, metadataPath, 'file');
    const setup = setupRegisteredDispatch(t, fixture);

    const { delivery } = runCoreDrainEvent(
      fixture, setup.lifecyclePath, setup.lifecycle, setup.env, fixture.specEvent,
    );

    assert.equal(delivery.status, 'succeeded', JSON.stringify(delivery));
    const updated = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.equal(updated.github_issue.ownership.event_id, fixture.specEvent.event_id);
    assert.equal(fs.lstatSync(metadataPath).isSymbolicLink(), true);
  });
});

test('registered succeeded replays reject external metadata symlinks without reading them', async (t) => {
  const cases = [
    { type: 'spec-approved', property: 'specEvent', code: 'ISSUE_METADATA_PATH_INVALID' },
    { type: 'phase-complete', property: 'phaseEvent', code: 'PHASE_METADATA_PATH_INVALID' },
    { type: 'plan-closed', property: 'closeEvent', code: 'CLOSEOUT_METADATA_PATH_INVALID' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.type, (t) => {
      const fixture = createFixture(t);
      const setup = setupRegisteredDispatch(t, fixture);
      const { delivery } = runCoreDrainEvent(
        fixture, setup.lifecyclePath, setup.lifecycle, setup.env, fixture[scenario.property],
      );
      assert.equal(delivery.status, 'succeeded', `fixture must first persist a valid proof: ${JSON.stringify(delivery)}`);
      const succeededEvent = JSON.parse(fs.readFileSync(setup.lifecyclePath, 'utf8')).events[0];
      const closeoutPath = path.join(fixture.planDir, 'closeout.md');
      const closeoutBefore = fs.existsSync(closeoutPath) ? fs.readFileSync(closeoutPath) : null;
      const external = symlinkMetadataOutsideProject(t, fixture, `enterprise-dispatch-${scenario.type}-replay-`);
      const metadataAlias = path.join(fixture.specDir, '.pocket-meta.json');
      const fileIoTrace = observeFilePaths(setup.env, fixture.root, [metadataAlias, external.externalPath]);
      const beforeGhCalls = readCalls(setup.tracePath).length;
      const response = withProcessEnvironment(setup.env, () => invokeAdapter(succeededEvent, registeredAdapter(fixture.root)));

      assert.equal(response.status, 'terminal');
      assert.equal(response.error.code, scenario.code);
      assert.equal(readCalls(setup.tracePath).length, beforeGhCalls, 'succeeded replay must not call GitHub');
      assert.deepEqual(readObservedFileIo(fileIoTrace), [], 'external metadata must not be read during proof replay');
      assert.deepEqual(fs.readFileSync(external.externalPath), external.sentinelBytes);
      if (scenario.type === 'plan-closed') {
        assert.deepEqual(fs.readFileSync(closeoutPath), closeoutBefore, 'succeeded replay must not rewrite closeout');
      }
      assert.ok(!JSON.stringify(response).includes(external.externalPath));
    });
  }

  const fixture = createFixture(t);
  const physicalRoot = fs.realpathSync(fixture.root);
  const physicalSpecDir = fs.realpathSync(fixture.specDir);
  const metadataPath = path.join(physicalSpecDir, '.pocket-meta.json');
  const originalLstatSync = fs.lstatSync;
  fs.lstatSync = function failMetadataPreflightWithEio(target, ...args) {
    if (typeof target === 'string' && path.resolve(target) === path.resolve(metadataPath)) {
      const error = new Error('injected transient metadata I/O failure');
      error.code = 'EIO';
      throw error;
    }
    return originalLstatSync.call(this, target, ...args);
  };
  let prepared;
  try {
    prepared = createLifecycleDelivery(fixture.root).prepare({
      ...fixture.specEvent,
      delivery: { ...fixture.specEvent.delivery, status: 'succeeded' },
    });
    assert.throws(() => enterpriseMeta.preflightMetaFor(physicalSpecDir, {
      projectRoot: physicalRoot,
      specDir: physicalSpecDir,
    }), { code: 'EIO' });
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(prepared.response.status, 'retryable');
  assert.equal(prepared.response.error.code, 'ADAPTER_LIFECYCLE_DELIVERY_INVALID');
  assert.equal(prepared.response.error.retryable, true);

  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.lifecycle_delivery = { schema: 1, plan_id: PLAN_ID, last_applied_revision: -1 };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const invalidWatermark = createLifecycleDelivery(fixture.root).prepare(fixture.specEvent);
  assert.equal(invalidWatermark.response.status, 'terminal');
  assert.equal(invalidWatermark.response.error.code, 'ADAPTER_LIFECYCLE_DELIVERY_INVALID');
  assert.equal(invalidWatermark.response.error.retryable, false);
});

test('registered event runner fails closed before GitHub calls and keeps diagnostics secret-free', (t) => {
  const fixture = createFixture(t);
  const tracePath = path.join(fixture.root, 'fake-gh.jsonl');
  fs.writeFileSync(tracePath, '');
  const fakeGh = writeFakeGh(fixture.root, tracePath);
  const oldPath = process.env.PATH;
  const oldTrace = process.env.FAKE_GH_TRACE;
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.PATH = `${fakeGh.binDir}${path.delimiter}${oldPath || ''}`;
  process.env.FAKE_GH_TRACE = tracePath;
  process.env.GITHUB_TOKEN = 'ghp_fail_closed_secret_must_never_escape';
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTrace === undefined) delete process.env.FAKE_GH_TRACE;
    else process.env.FAKE_GH_TRACE = oldTrace;
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
  });

  const installed = runCli(['install', fixture.root, '--json']);
  assert.equal(installed.exit, 0, `default install must register the event adapter: ${installed.stdout}`);
  const registrationPath = path.join(fixture.root, '.pocket', 'lifecycle-adapter.json');
  const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  registration.events = ['spec-approved', 'plan-closed'];
  fs.writeFileSync(registrationPath, `${JSON.stringify(registration, null, 2)}\n`);
  const record = registeredAdapter(fixture.root);
  const before = readCalls(tracePath).length;
  const response = invokeAdapter(fixture.phaseEvent, record);
  assert.equal(response.event_id, fixture.phaseEvent.event_id);
  assert.equal(response.status, 'retryable');
  assert.equal(response.error.code, 'ADAPTER_EVENT_NOT_ALLOWED');
  assert.equal(readCalls(tracePath).length, before, 'allowlist failure must happen before any gh process');
  assert.ok(!JSON.stringify(response).includes(process.env.GITHUB_TOKEN), 'fail-closed diagnostics must not expose secrets');
});

test('registered plan-closed rejects a plan_dir symlink escaping the explicit project root', (t) => {
  const fixture = createFixture(t);
  setLifecycleWatermark(fixture, fixture.closeEvent.revision - 1);
  const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-dispatch-external-plan-'));
  t.after(() => fs.rmSync(externalParent, { recursive: true, force: true }));
  const externalPlanDir = path.join(externalParent, PLAN_ID);
  fs.cpSync(fixture.planDir, externalPlanDir, { recursive: true });
  const logBefore = fs.readFileSync(path.join(externalPlanDir, 'log.json'));
  const closeoutSentinel = 'external closeout must remain byte-for-byte unchanged\n';
  fs.writeFileSync(path.join(externalPlanDir, 'closeout.md'), closeoutSentinel);
  const externalBefore = snapshotTree(externalPlanDir);
  fs.rmSync(fixture.planDir, { recursive: true, force: true });
  fs.symlinkSync(externalPlanDir, fixture.planDir, 'dir');

  const { tracePath, record } = prepareRegisteredRunner(t, fixture);
  const response = invokeAdapter(fixture.closeEvent, record);

  assert.equal(readCalls(tracePath).length, 0,
    'an escaping plan_dir must be rejected before the closure handler reaches fake GitHub');
  assertBoundedFailure(response, fixture.closeEvent);
  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.retryable, false);
  assert.equal(response.error.code, 'PHASE_LIFECYCLE_PATH_INVALID');
  assert.equal(fs.readFileSync(path.join(externalPlanDir, 'closeout.md'), 'utf8'), closeoutSentinel);
  assert.deepEqual(fs.readFileSync(path.join(externalPlanDir, 'log.json')), logBefore);
  assert.deepEqual(snapshotTree(externalPlanDir), externalBefore, 'the external plan tree must not be written');
});

test('registered phase-complete rejects a plan_dir symlink escaping the explicit project root', (t) => {
  const fixture = createFixture(t);
  setLifecycleWatermark(fixture, fixture.phaseEvent.revision - 1);
  const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-dispatch-external-phase-plan-'));
  t.after(() => fs.rmSync(externalParent, { recursive: true, force: true }));
  const externalPlanDir = path.join(externalParent, PLAN_ID);
  fs.cpSync(fixture.planDir, externalPlanDir, { recursive: true });
  const sentinel = 'external phase plan must remain byte-for-byte unchanged\n';
  fs.writeFileSync(path.join(externalPlanDir, 'external-sentinel.txt'), sentinel);
  const externalBefore = snapshotTree(externalPlanDir);
  fs.rmSync(fixture.planDir, { recursive: true, force: true });
  fs.symlinkSync(externalPlanDir, fixture.planDir, 'dir');

  const { tracePath, record } = prepareRegisteredRunner(t, fixture);
  const response = invokeAdapter(fixture.phaseEvent, record);

  assert.equal(readCalls(tracePath).length, 0,
    'an escaping plan_dir must be rejected before the phase handler reaches fake GitHub');
  assertBoundedFailure(response, fixture.phaseEvent);
  assert.equal(response.status, 'terminal');
  assert.equal(response.error.retryable, false);
  assert.equal(response.error.code, 'PHASE_LIFECYCLE_PATH_INVALID');
  assert.equal(fs.readFileSync(path.join(externalPlanDir, 'external-sentinel.txt'), 'utf8'), sentinel);
  assert.deepEqual(snapshotTree(externalPlanDir), externalBefore, 'the external phase plan tree must not be written');
});

test('registered phase-complete preserves retryability and code for transient lifecycle context I/O failures', (t) => {
  const fixture = createFixture(t);
  const { tracePath } = prepareRegisteredRunner(t, fixture);
  const lifecyclePath = path.join(fs.realpathSync(fixture.specDir), 'lifecycle.json');
  let lifecycleReadAttempted = false;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function failLifecycleReadWithEio(target, ...args) {
    if (typeof target === 'string' && path.resolve(target) === path.resolve(lifecyclePath)) {
      lifecycleReadAttempted = true;
      const error = new Error('injected transient lifecycle I/O failure');
      error.code = 'EIO';
      throw error;
    }
    return originalReadFileSync.call(this, target, ...args);
  };

  let response;
  try {
    response = dispatchEvent(fixture.phaseEvent, {
      projectRoot: fixture.root,
      coreContract: 3,
      handlers: registeredHandlers,
    });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(lifecycleReadAttempted, true, `expected lifecycle read at ${lifecyclePath}`);
  assert.equal(response.status, 'retryable');
  assert.equal(response.error.retryable, true);
  assert.equal(response.error.code, 'PHASE_LIFECYCLE_UNAVAILABLE');
  assert.equal(readCalls(tracePath).length, 0, 'transient context I/O failure must happen before GitHub calls');
});

test('registered phase-complete rejects a spec directory symlink escaping the explicit project root', (t) => {
  const fixture = createFixture(t);
  const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-dispatch-external-spec-'));
  t.after(() => fs.rmSync(externalParent, { recursive: true, force: true }));
  const externalSpecDir = path.join(externalParent, PLAN_ID);
  fs.cpSync(fixture.specDir, externalSpecDir, { recursive: true });
  const lifecycleBefore = fs.readFileSync(path.join(externalSpecDir, 'lifecycle.json'));
  fs.writeFileSync(path.join(externalSpecDir, 'external-sentinel.txt'), 'external spec must remain unchanged\n');
  const externalBefore = snapshotTree(externalSpecDir);
  fs.rmSync(fixture.specDir, { recursive: true, force: true });
  fs.symlinkSync(externalSpecDir, fixture.specDir, 'dir');

  const { tracePath, record } = prepareRegisteredRunner(t, fixture);
  const response = invokeAdapter(fixture.phaseEvent, record);

  assert.equal(readCalls(tracePath).length, 0,
    'an escaping spec directory must be rejected before phase reconciliation reaches fake GitHub');
  assertBoundedFailure(response, fixture.phaseEvent);
  assert.deepEqual(fs.readFileSync(path.join(externalSpecDir, 'lifecycle.json')), lifecycleBefore);
  assert.deepEqual(snapshotTree(externalSpecDir), externalBefore, 'the external spec tree must not be written');
});
