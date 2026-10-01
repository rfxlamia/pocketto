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

const CLI = path.resolve(__dirname, '../enterprise/cli.js');
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
  assert.equal(fs.readFileSync(path.join(externalPlanDir, 'closeout.md'), 'utf8'), closeoutSentinel);
  assert.deepEqual(fs.readFileSync(path.join(externalPlanDir, 'log.json')), logBefore);
  assert.deepEqual(snapshotTree(externalPlanDir), externalBefore, 'the external plan tree must not be written');
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
