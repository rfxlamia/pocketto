'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const enterpriseMeta = require('../../enterprise/meta');
const { hashCanonicalPayload } = require('../../cli/lib/lifecycle-contract');

const CORE_CLI = path.resolve(__dirname, '../../cli/index.js');
const ENTERPRISE_CLI = path.resolve(__dirname, '../../enterprise/cli.js');
const PLAN_ID = 'lifecycle-enterprise-integration';
const FIXED_NOW = '2026-09-19T12:00:00.000Z';
const REPOSITORY = 'acme/pocketto';
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const ISSUE_NUMBER = 73;
const PR_NUMBER = 84;
const ISSUE_URL = `${REPOSITORY_URL}/issues/${ISSUE_NUMBER}`;
const PR_URL = `${REPOSITORY_URL}/pull/${PR_NUMBER}`;
const PHASE_PATH = 'execution-plan/phase-1.md';
const ISSUE_MARKER = '<!-- pocket-tasklist -->';
const PHASE_MARKER = '<!-- pocket-phase-1-summary -->';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runProcess(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  return {
    exit: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
  };
}

function startProcess(command, args, { cwd, env = process.env } = {}) {
  const child = spawn(command, args, { cwd, env, encoding: 'utf8' });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({
      exit: typeof status === 'number' ? status : 1,
      signal,
      stdout,
      stderr,
    }));
  });
  return { child, done };
}

async function waitForFile(filePath, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    if (child.exitCode !== null) throw new Error(`worker exited before creating ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function runCore(fixture, args, env = fixture.env) {
  const result = runProcess(process.execPath, [CORE_CLI, ...args], { cwd: fixture.root, env });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* Preserve raw output for the assertion. */ }
  return { ...result, json };
}

async function runCoreAsync(fixture, args, env = fixture.env) {
  const result = await startProcess(process.execPath, [CORE_CLI, ...args], { cwd: fixture.root, env }).done;
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* Preserve raw output for the assertion. */ }
  return { ...result, json };
}

function assertCliOk(result, label) {
  assert.equal(result.exit, 0, `${label} must succeed: ${result.stdout}${result.stderr}`);
  assert.ok(result.json && result.json.ok, `${label} must return a successful JSON envelope: ${result.stdout}`);
  return result.json.data;
}

function writeFile(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-enterprise-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const specDir = path.join(root, 'docs', 'pocket', 'spec', PLAN_ID);
  const planDir = path.join(root, 'docs', 'pocket', 'plans', PLAN_ID);
  const approvedSpec = [
    '# Approved lifecycle integration spec',
    '',
    '## Summary',
    'Exercise the public Core-to-Enterprise lifecycle boundary.',
    '',
    '## Acceptance Criteria',
    '- Core emits durable neutral events before Enterprise delivery.',
    '- Enterprise remote effects are reconciled by canonical proof.',
    '',
  ].join('\n');
  const phaseEvidence = [
    '# Phase 1 — lifecycle integration',
    '',
    '### Task 1: Verify the Core-to-Enterprise delivery flow',
    '',
    'Completion evidence: public lifecycle emitters and adapter delivery are exercised.',
    '',
  ].join('\n');
  const index = [
    '# Lifecycle integration fixture',
    '',
    `**Spec:** docs/pocket/spec/${PLAN_ID}/approved-spec.md`,
    '**Source Plan:** execution-plan.md',
    '',
    '## Task Index',
    '',
    `- [T1] Verify public lifecycle delivery for ${PLAN_ID}`,
    '',
  ].join('\n');
  const review = {
    task_id: 'T1',
    overall: 'REVIEW_PASS',
    stage_1: { issues: [] },
    stage_2: { issues: [] },
  };

  writeFile(path.join(specDir, 'approved-spec.md'), approvedSpec);
  writeFile(path.join(planDir, 'execution-plan', 'index.md'), index);
  writeFile(path.join(planDir, PHASE_PATH), phaseEvidence);
  writeFile(path.join(planDir, 'reviews', 'T1-review.json'), `${JSON.stringify(review, null, 2)}\n`);
  writeFile(path.join(planDir, 'execution-plan.md'), '# Complete lifecycle integration plan\n');
  enterpriseMeta.setPrIdentity(specDir, 'phase-1', { number: PR_NUMBER, url: PR_URL });

  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['checkout', '--quiet', '-b', `feature/${PLAN_ID}`], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lifecycle Integration Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lifecycle-test@example.invalid'], { cwd: root });
  execFileSync('git', ['add', 'docs'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture: create lifecycle integration plan'], { cwd: root });

  const remotePath = path.join(root, '.fake-github.json');
  const binDir = path.join(root, '.fake-bin');
  const fakeGhPath = path.join(binDir, 'gh');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(remotePath, `${JSON.stringify({
    calls: [],
    effects: [],
    issues: [],
    pullRequests: [{
      number: PR_NUMBER,
      url: PR_URL,
      state: 'OPEN',
      headRefName: `feature/${PLAN_ID}`,
      baseRefName: 'main',
      headRefOid: 'abc123def456',
      title: `Phase 1: ${PLAN_ID}`,
      body: `Implements ${PLAN_ID}`,
    }],
    comments: {},
    nextIssueNumber: ISSUE_NUMBER,
    nextCommentId: 900,
  }, null, 2)}\n`);
  fs.writeFileSync(fakeGhPath, fakeGhScript(), { mode: 0o755 });
  fs.chmodSync(fakeGhPath, 0o755);

  const env = { ...process.env };
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) delete env[key];
  env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`;
  env.FAKE_GH_STATE = remotePath;
  env.POCKETTO_LIFECYCLE_NOW = FIXED_NOW;

  return { root, specDir, planDir, phaseEvidence, approvedSpec, index, remotePath, fakeGhPath, env };
}

function fakeGhScript() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push(args);
const repo = { owner: { login: 'acme' }, name: 'pocketto', nameWithOwner: '${REPOSITORY}', url: '${REPOSITORY_URL}' };
const json = (value) => { fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\\n'); process.stdout.write(JSON.stringify(value)); process.exit(0); };
const fail = (message) => { fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\\n'); process.stderr.write(message); process.exit(1); };
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
const field = (name) => { for (let i = 0; i < args.length - 1; i++) if ((args[i] === '-f' || args[i] === '-F') && args[i + 1].startsWith(name + '=')) return args[i + 1].slice(name.length + 1); return null; };
const issueByNumber = (number) => state.issues.find((issue) => issue.number === Number(number));
const issueView = (issue) => ({ ...issue, html_url: issue.url, repository: { full_name: '${REPOSITORY}' } });
const commentsFor = (number) => state.comments[String(number)] || (state.comments[String(number)] = []);
if (args[0] === 'repo' && args[1] === 'view') json(repo);
if (args[0] === 'issue' && args[1] === 'list') json(state.issues.filter((issue) => issue.state === 'OPEN'));
if (args[0] === 'issue' && args[1] === 'create') {
  const number = state.nextIssueNumber++;
  const url = '${REPOSITORY_URL}/issues/' + number;
  const bodyFile = value('--body-file');
  const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : '';
  const issue = { number, url, state: 'OPEN', title: value('--title'), body, labels: [{ name: 'pocket-plan' }], createdAt: '${FIXED_NOW}' };
  state.issues.push(issue);
  state.effects.push({ kind: 'issue-create', number });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\\n');
  process.stdout.write(url + '\\n');
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const issue = issueByNumber(args[2]);
  if (issue) json(issueView(issue));
  fail('issue not found in fake repository');
}
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = state.pullRequests.find((candidate) => candidate.number === Number(args[2]));
  if (pr) json(pr);
  fail('pull request not found in fake repository');
}
if (args[0] === 'pr' && args[1] === 'list') json(state.pullRequests);
if (args[0] === 'api' && args[1] === 'graphql') {
  json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
}
if (args[0] === 'api' && typeof args[1] === 'string') {
  const endpoint = args[1];
  if (endpoint.endsWith('/comments')) {
    const match = endpoint.match(/\\/issues\\/(\\d+)\\/comments$/);
    if (!match) fail('unrecognized comments endpoint');
    const number = Number(match[1]);
    const comments = commentsFor(number);
    const method = value('--method') || (field('body') === null ? 'GET' : 'POST');
    if (method === 'GET') json(comments);
    if (method === 'POST') {
      const comment = { id: state.nextCommentId++, body: field('body') || '' };
      comments.push(comment);
      const kind = number === ${PR_NUMBER} ? 'phase-summary-create' : 'tasklist-create';
      state.effects.push({ kind, number, marker: comment.body.split(/\\r?\\n/, 1)[0] });
      json(comment);
    }
  }
  const commentMatch = endpoint.match(/\\/issues\\/comments\\/(\\d+)$/);
  if (commentMatch) {
    const id = Number(commentMatch[1]);
    const comment = Object.values(state.comments).flat().find((item) => item.id === id);
    const method = value('--method');
    if (!comment) fail('comment not found');
    if (method === 'PATCH') { comment.body = field('body') || ''; state.effects.push({ kind: 'comment-update', id }); json(comment); }
    if (method === 'DELETE') { for (const items of Object.values(state.comments)) { const index = items.findIndex((item) => item.id === id); if (index >= 0) items.splice(index, 1); } state.effects.push({ kind: 'comment-delete', id }); fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\\n'); process.exit(0); }
  }
  const issueMatch = endpoint.match(/\\/issues\\/(\\d+)$/);
  if (issueMatch) {
    const issue = issueByNumber(issueMatch[1]);
    if (issue) json(issueView(issue));
    fail('issue not found in fake repository');
  }
}
fail('fake GitHub rejected unexpected request: ' + args.join(' '));
`;
}

function installEnterpriseAdapter(fixture) {
  const result = runProcess(process.execPath, [ENTERPRISE_CLI, 'install', fixture.root, '--json'], {
    cwd: path.resolve(__dirname, '../..'),
    env: fixture.env,
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* Report raw output below. */ }
  assert.equal(result.exit, 0, `Enterprise registration must succeed: ${result.stdout}${result.stderr}`);
  assert.ok(json && json.ok, `Enterprise registration must return success: ${result.stdout}`);
  return json.data;
}

function initializePlan(fixture) {
  installEnterpriseAdapter(fixture);
  const initialized = runCore(fixture, ['log', 'init', fixture.planDir, '--json', '--contract', '3']);
  assertCliOk(initialized, 'public log init');
  const taskDone = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'DONE', '--task', 'T1', '--json', '--contract', '3',
  ]);
  assertCliOk(taskDone, 'public log update task completion');
}

function readLifecycle(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.specDir, 'lifecycle.json'), 'utf8'));
}

function readRemote(fixture) {
  return JSON.parse(fs.readFileSync(fixture.remotePath, 'utf8'));
}

function installFakeAdapter(fixture, tracePath, { recordRemoteEffects = false, remoteGate = null } = {}) {
  const adapterPath = path.join(fixture.root, 'fake-adapter.js');
  writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({ name: 'fake-enterprise-fixture', version: '4.0.0' }, null, 2));
  writeFile(path.join(fixture.root, 'surfaces.json'), JSON.stringify({
    schema: 1,
    release: { major: 4 },
    roles: { 'test/enterprise': { kind: 'enterprise', includes: ['fake-adapter.js'] } },
  }, null, 2));
  const remoteMutation = recordRemoteEffects ? `const { execFileSync } = require('node:child_process');
const body = '<!-- lifecycle-revision -->\\nrevision=' + event.revision;
execFileSync('gh', ['api', 'repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/comments', '-f', 'body=' + body], { stdio: 'ignore' });
` : '';
  const remoteGateWait = remoteGate ? `if (!fs.existsSync(process.env.FAKE_ADAPTER_REMOTE_READY_FILE)) {
  fs.writeFileSync(process.env.FAKE_ADAPTER_REMOTE_READY_FILE, event.event_id);
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(process.env.FAKE_ADAPTER_REMOTE_RELEASE_FILE)) Atomics.wait(signal, 0, 0, 10);
}
` : '';
  writeFile(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const event = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
${remoteMutation}fs.appendFileSync(process.env.FAKE_ADAPTER_TRACE, JSON.stringify({ event_id: event.event_id, revision: event.revision }) + '\\n');
${remoteGateWait}process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded', proof_ref: 'test:proof', proof_hash: '${'a'.repeat(64)}' }) + '\\n');
`);
  fs.chmodSync(adapterPath, 0o755);
  const env = { ...fixture.env, FAKE_ADAPTER_TRACE: tracePath };
  if (remoteGate) {
    env.FAKE_ADAPTER_REMOTE_READY_FILE = remoteGate.readyPath;
    env.FAKE_ADAPTER_REMOTE_RELEASE_FILE = remoteGate.releasePath;
  }
  const installed = runProcess(process.execPath, [
    ENTERPRISE_CLI, 'install', fixture.root, '--argv', adapterPath, '--json',
  ], { cwd: path.resolve(__dirname, '../..'), env });
  let json = null;
  try { json = JSON.parse(installed.stdout); } catch { /* Assert below with raw output. */ }
  assert.equal(installed.exit, 0, `fake adapter registration must succeed: ${installed.stdout}${installed.stderr}`);
  assert.ok(json && json.ok, `fake adapter registration must return success: ${installed.stdout}`);
  return env;
}

function writeGapDocument(fixture) {
  const ref = {
    root: 'plan',
    kind: 'phase-evidence',
    path: PHASE_PATH,
    sha256: sha256(fixture.phaseEvidence),
    revision: 1,
  };
  const event = (type, revision, status) => ({
    event_id: `${PLAN_ID}:${type}:r${revision}`,
    plan_id: PLAN_ID,
    type,
    revision,
    occurred_at: FIXED_NOW,
    artifact_refs: [ref],
    payload_hash: String(revision).padStart(64, 'a'),
    proof_ref: null,
    proof_hash: null,
    delivery: status === 'succeeded'
      ? { status, attempts: 1, proof_ref: 'test:proof', proof_hash: 'b'.repeat(64) }
      : { status, attempts: 0 },
  });
  const lifecycle = {
    schema: 1,
    plan: {
      plan_id: PLAN_ID,
      spec_dir: fixture.specDir,
      plan_dir: fixture.planDir,
      branch: `feature/${PLAN_ID}`,
      state: { approval: 'APPROVED', phase_status: { 'phase-1': 'COMPLETE' }, status: 'IN_PROGRESS' },
      revision: 5,
    },
    events: [
      event('spec-approved', 1, 'succeeded'),
      event('phase-complete', 2, 'succeeded'),
      event('phase-complete', 3, 'succeeded'),
      event('phase-complete', 5, 'pending'),
    ],
  };
  writeFile(path.join(fixture.specDir, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
  return lifecycle;
}

function appendOrderedPendingRevisions(fixture) {
  const lifecycle = readLifecycle(fixture);
  const existingRevisions = lifecycle.events.map((event) => event.revision);
  assert.deepEqual(existingRevisions, [1, 2], 'the public emitters must create the initial ordered revisions');
  assert.ok(lifecycle.events.every((event) => event.delivery.status === 'succeeded'));

  for (const revision of [3, 4, 5]) {
    const phaseNumber = revision - 1;
    const artifactPath = `execution-plan/phase-${phaseNumber}.md`;
    const contents = `# Phase ${phaseNumber} evidence\\n\\nCompleted lifecycle revision ${revision}.\\n`;
    writeFile(path.join(fixture.planDir, artifactPath), contents);
    const artifactRef = {
      root: 'plan',
      kind: 'phase-evidence',
      path: artifactPath,
      sha256: sha256(contents),
      revision: 1,
    };
    const payload = {
      plan_id: PLAN_ID,
      type: 'phase-complete',
      artifact_refs: [artifactRef],
      proof_ref: null,
      proof_hash: null,
    };
    lifecycle.events.push({
      event_id: `${PLAN_ID}:phase-complete:r${revision}`,
      plan_id: PLAN_ID,
      type: 'phase-complete',
      revision,
      occurred_at: new Date(Date.parse(FIXED_NOW) + revision * 1000).toISOString(),
      artifact_refs: [artifactRef],
      payload_hash: hashCanonicalPayload(payload),
      proof_ref: null,
      proof_hash: null,
      delivery: { status: 'pending', attempts: 0 },
    });
    lifecycle.plan.state.phase_status[`phase-${phaseNumber}`] = 'COMPLETE';
  }

  lifecycle.plan.revision = 5;
  writeFile(path.join(fixture.specDir, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
  return lifecycle;
}

function installLedgerFaultGate(fixture) {
  const hookPath = path.join(fixture.root, 'ledger-fault-gate.js');
  const hitPath = path.join(fixture.root, 'ledger-fault.hit');
  writeFile(hookPath, `const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
let injected = false;
Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== './lifecycle-store' || !parent || !parent.filename.endsWith('/cli/lib/lifecycle-drain.js')) return loaded;
  return {
    ...loaded,
    updateEventDelivery(specDir, eventId, patch) {
      if (!injected && eventId === process.env.LIFECYCLE_LEDGER_FAULT_EVENT_ID && patch.status === 'succeeded') {
        injected = true;
        fs.writeFileSync(process.env.LIFECYCLE_LEDGER_FAULT_HIT_FILE, process.env.LIFECYCLE_LEDGER_FAULT_MODE);
        if (process.env.LIFECYCLE_LEDGER_FAULT_MODE === 'crash-before-success-write') process.kill(process.pid, 'SIGKILL');
        if (process.env.LIFECYCLE_LEDGER_FAULT_MODE === 'timeout-before-success-write') {
          return { ok: false, code: 'TEST_LEDGER_TIMEOUT', message: 'injected lifecycle ledger timeout' };
        }
      }
      return loaded.updateEventDelivery(specDir, eventId, patch);
    },
  };
};
`);
  return { hookPath, hitPath };
}

function installStaleCandidateGate(fixture, workerId = 'stale-candidate') {
  const hookPath = path.join(fixture.root, 'stale-candidate-gate.js');
  const readyPath = path.join(fixture.root, `${workerId}.ready`);
  const releasePath = path.join(fixture.root, `${workerId}.release`);
  writeFile(hookPath, `const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
let paused = false;
Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== './lifecycle-claims' || !parent || !parent.filename.endsWith('/cli/lib/lifecycle-drain.js')) return loaded;
  return {
    ...loaded,
    acquireEventClaim(specDir, planId, eventId) {
      if (!paused && eventId === process.env.STALE_QUEUE_EVENT_ID) {
        paused = true;
        fs.writeFileSync(process.env.STALE_QUEUE_READY_FILE, eventId);
        const signal = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(process.env.STALE_QUEUE_RELEASE_FILE)) Atomics.wait(signal, 0, 0, 10);
      }
      return loaded.acquireEventClaim(specDir, planId, eventId);
    },
  };
};
`);
  return { hookPath, readyPath, releasePath };
}

test('public Core emitters deliver lifecycle events to exactly one canonical Enterprise proof', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);

  const approved = runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    '--artifact', `spec:approved-spec:approved-spec.md:${sha256(fixture.approvedSpec)}`,
    '--json', '--contract', '3',
  ]);
  const approvedData = assertCliOk(approved, 'public spec-approved transition');
  assert.equal(approvedData.event_id, `${PLAN_ID}:spec-approved:r1`);
  assert.equal(approvedData.status, 'pending');
  assert.deepEqual(readRemote(fixture).calls, [], 'Core transition must remain locally successful without making remote calls');

  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'REVIEW', '--json', '--contract', '3',
  ]);
  const phaseData = assertCliOk(review, 'public log update REVIEW');
  assert.deepEqual(phaseData.event, {
    event_id: `${PLAN_ID}:phase-complete:r2`,
    plan_id: PLAN_ID,
    type: 'phase-complete',
    revision: 2,
    status: 'pending',
  });
  assert.deepEqual(readRemote(fixture).calls, [], 'log update must emit locally without invoking GitHub');

  const firstDrain = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]);
  const firstDrainData = assertCliOk(firstDrain, 'public first lifecycle drain');
  assert.deepEqual(firstDrainData.deliveries.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
    { event_id: `${PLAN_ID}:spec-approved:r1`, revision: 1, status: 'succeeded' },
    { event_id: `${PLAN_ID}:phase-complete:r2`, revision: 2, status: 'succeeded' },
  ], 'Core must deliver the public-emitter events in revision order through the registered Enterprise executable');

  const phaseDone = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'DONE', '--json', '--contract', '3',
  ]);
  assertCliOk(phaseDone, 'public log update DONE');
  const closed = runCore(fixture, ['log', 'close', fixture.planDir, '--json', '--contract', '3']);
  const closeData = assertCliOk(closed, 'public log close');
  assert.equal(closeData.event.event_id, `${PLAN_ID}:plan-closed:r3`);
  assert.equal(closeData.event.status, 'pending');
  assert.deepEqual(readRemote(fixture).effects.map((effect) => effect.kind), [
    'issue-create', 'phase-summary-create',
  ], 'Core log emitters must have no remote side effects before drain');

  const secondDrain = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]);
  const secondDrainData = assertCliOk(secondDrain, 'public closure lifecycle drain');
  assert.deepEqual(secondDrainData.deliveries.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
    { event_id: `${PLAN_ID}:plan-closed:r3`, revision: 3, status: 'succeeded' },
  ]);

  const lifecycle = readLifecycle(fixture);
  assert.deepEqual(lifecycle.events.map((event) => ({
    event_id: event.event_id,
    revision: event.revision,
    type: event.type,
    status: event.delivery.status,
  })), [
    { event_id: `${PLAN_ID}:spec-approved:r1`, revision: 1, type: 'spec-approved', status: 'succeeded' },
    { event_id: `${PLAN_ID}:phase-complete:r2`, revision: 2, type: 'phase-complete', status: 'succeeded' },
    { event_id: `${PLAN_ID}:plan-closed:r3`, revision: 3, type: 'plan-closed', status: 'succeeded' },
  ]);
  assert.deepEqual(lifecycle.events.map((event) => event.delivery.proof_ref), [
    'meta:github_issue',
    'meta:phases.phase-1.github_pr+meta:phases.phase-1.review.fingerprints',
    'meta:github_issue|marker:issue-tasklist',
  ], 'Core must store only opaque canonical proof references');
  assert.ok(lifecycle.events.every((event) => /^[0-9a-f]{64}$/.test(event.delivery.proof_hash || '')));
  assert.ok(!JSON.stringify(lifecycle).includes(ISSUE_URL), 'Core lifecycle ledger must not contain remote issue URLs');
  assert.ok(!JSON.stringify(lifecycle).includes(PR_URL), 'Core lifecycle ledger must not contain remote PR URLs');

  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadata.github_issue.ownership.event_id, `${PLAN_ID}:spec-approved:r1`);
  assert.equal(metadata.phases['phase-1'].review.proof.event_id, `${PLAN_ID}:phase-complete:r2`);
  assert.equal(metadata.phases['phase-1'].review.proof.marker, PHASE_MARKER);
  assert.equal(metadata.github_issue.tasklist.event_id, `${PLAN_ID}:plan-closed:r3`);
  assert.equal(metadata.github_issue.tasklist.marker, ISSUE_MARKER);

  const remote = readRemote(fixture);
  assert.deepEqual(remote.effects.map((effect) => effect.kind), [
    'issue-create', 'phase-summary-create', 'tasklist-create',
  ]);
  assert.equal(remote.issues.length, 1, 'spec-approved must create only one issue');
  assert.equal(remote.comments[String(PR_NUMBER)].filter((comment) => comment.body.startsWith(PHASE_MARKER)).length, 1,
    'phase-complete must leave exactly one canonical PR summary marker');
  assert.equal(remote.comments[String(ISSUE_NUMBER)].filter((comment) => comment.body.startsWith(ISSUE_MARKER)).length, 1,
    'plan-closed must leave exactly one canonical tasklist marker');
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true,
    'closure handler must write the local closeout artifact');

  const effectsBeforeReplay = remote.effects.length;
  const callsBeforeReplay = remote.calls.length;
  const replay = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]);
  const replayData = assertCliOk(replay, 'public repeated lifecycle drain');
  assert.deepEqual(replayData.deliveries, [], 'succeeded events must not be invoked again');
  const afterReplay = readRemote(fixture);
  assert.equal(afterReplay.effects.length, effectsBeforeReplay, 'repeated drain must not create another remote effect');
  assert.equal(afterReplay.calls.length, callsBeforeReplay, 'repeated drain must not call the remote transport');
});

test('revision gaps remain pending with an actionable predecessor diagnostic', (t) => {
  const fixture = createFixture(t);
  const adapterTrace = path.join(fixture.root, 'fake-adapter.jsonl');
  fs.writeFileSync(adapterTrace, '');
  const env = installFakeAdapter(fixture, adapterTrace);
  writeGapDocument(fixture);
  const lifecycleBefore = fs.readFileSync(path.join(fixture.specDir, 'lifecycle.json'));

  const drain = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], env);
  const data = assertCliOk(drain, 'public drain with revision gap');
  assert.equal(data.plan_id, PLAN_ID);
  assert.equal(data.revision, 5);
  assert.deepEqual(data.deliveries, [{
    event_id: `${PLAN_ID}:phase-complete:r5`,
    revision: 5,
    status: 'pending',
    deferred: true,
    blocked_by_gap: true,
  }]);
  assert.deepEqual(data.gaps, [{
    plan_id: PLAN_ID,
    blocked_revision: 5,
    missing_predecessor: 4,
    next_step: `Restore or replay lifecycle revision 4 for plan ${PLAN_ID}, then rerun lifecycle drain.`,
  }], 'the gap diagnostic must identify the plan, missing predecessor, and recovery action');
  assert.equal(fs.readFileSync(path.join(fixture.specDir, 'lifecycle.json')).toString(), lifecycleBefore.toString(),
    'a blocked gap must not mutate the event ledger or increment attempts');
  assert.equal(fs.readFileSync(adapterTrace, 'utf8'), '', 'the registered adapter must not be invoked across a revision gap');
  assert.deepEqual(readRemote(fixture).calls, [], 'the fake GitHub runner must remain untouched across a gap');
  assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false,
    'a gap must be detected before a worker claim is acquired');
});

test('a stale lower revision is a no-op after a later revision has succeeded', async (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const approved = runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    '--artifact', `spec:approved-spec:approved-spec.md:${sha256(fixture.approvedSpec)}`,
    '--json', '--contract', '3',
  ]);
  assert.equal(assertCliOk(approved, 'public spec-approved transition').event_id, `${PLAN_ID}:spec-approved:r1`);
  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'REVIEW', '--json', '--contract', '3',
  ]);
  assert.equal(assertCliOk(review, 'public log update REVIEW').event.event_id, `${PLAN_ID}:phase-complete:r2`);

  const adapterTrace = path.join(fixture.root, 'fake-adapter.jsonl');
  fs.writeFileSync(adapterTrace, '');
  const env = installFakeAdapter(fixture, adapterTrace, { recordRemoteEffects: true });
  const initialDrain = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], env);
  assert.deepEqual(assertCliOk(initialDrain, 'public initial lifecycle drain').deliveries.map(({ revision, status }) => ({ revision, status })), [
    { revision: 1, status: 'succeeded' },
    { revision: 2, status: 'succeeded' },
  ]);

  const lifecycle = appendOrderedPendingRevisions(fixture);
  assert.deepEqual(lifecycle.events.map((event) => event.revision), [1, 2, 3, 4, 5],
    'the append-only journal must retain monotonically increasing revision order');
  assert.deepEqual(lifecycle.events.map((event) => event.delivery.status), [
    'succeeded', 'succeeded', 'pending', 'pending', 'pending',
  ]);

  const gate = installStaleCandidateGate(fixture);
  const staleEventId = `${PLAN_ID}:phase-complete:r3`;
  const gatedEnv = {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, `--require=${gate.hookPath}`].filter(Boolean).join(' '),
    STALE_QUEUE_EVENT_ID: staleEventId,
    STALE_QUEUE_READY_FILE: gate.readyPath,
    STALE_QUEUE_RELEASE_FILE: gate.releasePath,
  };
  const staleWorker = startProcess(process.execPath, [
    CORE_CLI, 'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], { cwd: fixture.root, env: gatedEnv });

  try {
    await waitForFile(gate.readyPath, staleWorker.child);
    assert.equal(fs.readFileSync(gate.readyPath, 'utf8'), staleEventId,
      'the delayed worker must have queued revision 3 before attempting its real claim');
    assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false,
      'the delayed worker must not hold revision 3 while another worker advances the ledger');

    const orderedDrain = await runCoreAsync(fixture, [
      'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
    ], env);
    assert.deepEqual(assertCliOk(orderedDrain, 'public ordered lifecycle drain').deliveries.map(({ revision, status }) => ({ revision, status })), [
      { revision: 3, status: 'succeeded' },
      { revision: 4, status: 'succeeded' },
      { revision: 5, status: 'succeeded' },
    ]);

    const afterRevisionFive = readLifecycle(fixture);
    assert.equal(afterRevisionFive.events.find((event) => event.revision === 5).delivery.status, 'succeeded');
    assert.ok(afterRevisionFive.events.slice(2).every((event) => event.delivery.status === 'succeeded'));
    const remoteAtRevisionFive = readRemote(fixture);
    const traceAtRevisionFive = fs.readFileSync(adapterTrace, 'utf8');
    const appliedRevisions = (remoteAtRevisionFive.comments[String(ISSUE_NUMBER)] || [])
      .map(({ body }) => Number(body.match(/revision=(\d+)/)?.[1]));
    assert.deepEqual(appliedRevisions, [1, 2, 3, 4, 5], 'the fake GitHub state must advance monotonically through revision 5');
    assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false,
      'the advancing worker must release its real claim before the delayed worker resumes');

    const ledgerAtRevisionFive = fs.readFileSync(path.join(fixture.specDir, 'lifecycle.json'));
    assert.equal(afterRevisionFive.events.find((event) => event.revision === 3).delivery.status, 'succeeded',
      'revision 3 must already be complete when its queued candidate is resumed');
    writeFile(gate.releasePath, 'resume');
    const staleOutput = await staleWorker.done;
    let staleJson = null;
    try { staleJson = JSON.parse(staleOutput.stdout); } catch { /* Preserve raw output for the assertion. */ }
    const staleData = assertCliOk({ ...staleOutput, json: staleJson }, 'delayed public drain with a stale revision-3 candidate');
    assert.equal(staleData.plan_id, PLAN_ID);
    assert.deepEqual(staleData.deliveries, [], 'the stale queued candidate must be a no-op after revision 5 succeeds');
    assert.deepEqual(staleData.gaps, []);
    assert.equal(fs.readFileSync(path.join(fixture.specDir, 'lifecycle.json')).toString(), ledgerAtRevisionFive.toString(),
      'the delayed stale candidate must not mutate the authoritative lifecycle ledger');
    assert.equal(fs.readFileSync(adapterTrace, 'utf8'), traceAtRevisionFive,
      'the delayed stale candidate must not invoke the registered adapter');
    assert.deepEqual(readRemote(fixture), remoteAtRevisionFive,
      'the delayed stale candidate must not regress remote state or create another effect');
    assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false,
      'the delayed worker must release its real claim after rechecking the ledger');
  } finally {
    writeFile(gate.releasePath, 'resume');
    await staleWorker.done.catch(() => {});
  }
});

test('expired event claims are reclaimed without overlapping the prior worker or duplicating remote proof', async (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const approved = runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    '--artifact', `spec:approved-spec:approved-spec.md:${sha256(fixture.approvedSpec)}`,
    '--json', '--contract', '3',
  ]);
  const eventId = assertCliOk(approved, 'public spec-approved transition').event_id;
  const faultGate = installLedgerFaultGate(fixture);
  const crashedWorker = startProcess(process.execPath, [
    CORE_CLI, 'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    cwd: fixture.root,
    env: {
      ...fixture.env,
      NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' '),
      LIFECYCLE_LEDGER_FAULT_EVENT_ID: eventId,
      LIFECYCLE_LEDGER_FAULT_HIT_FILE: faultGate.hitPath,
      LIFECYCLE_LEDGER_FAULT_MODE: 'crash-before-success-write',
    },
  });
  const crashedOutput = await crashedWorker.done;
  assert.equal(crashedOutput.signal, 'SIGKILL',
    'the first worker must terminate after the real Enterprise handler writes remote proof but before local success persists');
  assert.equal(fs.readFileSync(faultGate.hitPath, 'utf8'), 'crash-before-success-write');
  assert.throws(() => process.kill(crashedWorker.child.pid, 0), (error) => error.code === 'ESRCH',
    'the expired claim owner must be dead before the later worker starts');

  const claimedEvent = readLifecycle(fixture).events[0];
  assert.equal(claimedEvent.event_id, eventId);
  assert.equal(claimedEvent.delivery.status, 'claimed');
  assert.equal(claimedEvent.delivery.attempts, 1);
  const claimPath = path.join(fixture.specDir, '.lifecycle.lock');
  const expiredOwnerClaim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  assert.equal(expiredOwnerClaim.event_id, eventId);
  assert.equal(expiredOwnerClaim.owner_pid, crashedWorker.child.pid);
  const effectsBeforeRecovery = readRemote(fixture).effects;
  assert.equal(effectsBeforeRecovery.length, 1, 'the real issue handler must have committed one remote proof before the worker died');
  assert.equal(readRemote(fixture).issues.length, 1);
  const metadataBeforeRecovery = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadataBeforeRecovery.github_issue.ownership.event_id, eventId);

  const recoveryNow = new Date(Date.parse(FIXED_NOW) + 60_001).toISOString();
  assert.ok(Date.parse(expiredOwnerClaim.lease_expires_at) < Date.parse(recoveryNow),
    'the deterministic recovery clock must be beyond the original lease expiry');
  const recovered = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], { ...fixture.env, POCKETTO_LIFECYCLE_NOW: recoveryNow });
  assert.deepEqual(assertCliOk(recovered, 'public drain after event-claim lease expiry').deliveries.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
    { event_id: eventId, revision: 1, status: 'succeeded' },
  ]);

  const finalEvent = readLifecycle(fixture).events[0];
  assert.equal(finalEvent.delivery.status, 'succeeded');
  assert.equal(finalEvent.delivery.attempts, 2, 'the recovered worker must record exactly one later invocation');
  assert.equal(finalEvent.delivery.proof_ref, 'meta:github_issue');
  assert.equal(readRemote(fixture).effects.length, 1, 'recovery must reuse the existing issue proof without a duplicate remote effect');
  assert.equal(readRemote(fixture).issues.length, 1);
  assert.deepEqual(readRemote(fixture).effects, effectsBeforeRecovery);
  assert.equal(fs.existsSync(claimPath), false, 'the reclaimed worker must release the real lock after success');
});

test('remote phase proof survives a local ledger timeout without another remote effect', async (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const approved = runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    '--artifact', `spec:approved-spec:approved-spec.md:${sha256(fixture.approvedSpec)}`,
    '--json', '--contract', '3',
  ]);
  assert.equal(assertCliOk(approved, 'public spec-approved transition').event_id, `${PLAN_ID}:spec-approved:r1`);
  const initialDrain = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]);
  assert.equal(assertCliOk(initialDrain, 'public initial lifecycle drain').deliveries[0].status, 'succeeded');
  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'REVIEW', '--json', '--contract', '3',
  ]);
  const eventId = assertCliOk(review, 'public log update REVIEW').event.event_id;
  assert.equal(eventId, `${PLAN_ID}:phase-complete:r2`);

  const faultGate = installLedgerFaultGate(fixture);
  const timedOutWorker = startProcess(process.execPath, [
    CORE_CLI, 'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    cwd: fixture.root,
    env: {
      ...fixture.env,
      NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' '),
      LIFECYCLE_LEDGER_FAULT_EVENT_ID: eventId,
      LIFECYCLE_LEDGER_FAULT_HIT_FILE: faultGate.hitPath,
      LIFECYCLE_LEDGER_FAULT_MODE: 'timeout-before-success-write',
    },
  });
  const timeoutOutput = await timedOutWorker.done;
  assert.equal(timeoutOutput.exit, 1, 'the injected local ledger timeout must fail the first delivery attempt');
  assert.equal(fs.readFileSync(faultGate.hitPath, 'utf8'), 'timeout-before-success-write');
  const timeoutEnvelope = JSON.parse(timeoutOutput.stdout);
  assert.equal(timeoutEnvelope.error.code, 'TEST_LEDGER_TIMEOUT');
  const lifecycleAfterTimeout = readLifecycle(fixture);
  assert.equal(lifecycleAfterTimeout.events[1].event_id, eventId);
  assert.equal(lifecycleAfterTimeout.events[1].delivery.status, 'claimed',
    'the local ledger must remain at the pre-success claim state after its writer times out');
  assert.equal(lifecycleAfterTimeout.events[1].delivery.attempts, 1);
  const claimPath = path.join(fixture.specDir, '.lifecycle.lock');
  const timedOutClaim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  assert.equal(timedOutClaim.event_id, eventId);
  assert.equal(timedOutClaim.owner_pid, timedOutWorker.child.pid);

  const remoteAfterTimeout = readRemote(fixture);
  const phaseMarkersAfterTimeout = (remoteAfterTimeout.comments[String(PR_NUMBER)] || [])
    .filter(({ body }) => body.startsWith(PHASE_MARKER));
  assert.equal(phaseMarkersAfterTimeout.length, 1, 'the real Enterprise phase handler must write one canonical marker before the local timeout');
  const metadataAfterTimeout = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadataAfterTimeout.phases['phase-1'].review.proof.event_id, eventId,
    'the adapter must have persisted event-bound proof before Core reports the ledger timeout');
  const effectsBeforeReplay = remoteAfterTimeout.effects;

  const recoveryNow = new Date(Date.parse(FIXED_NOW) + 60_001).toISOString();
  const replay = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], { ...fixture.env, POCKETTO_LIFECYCLE_NOW: recoveryNow });
  assert.deepEqual(assertCliOk(replay, 'public phase-event replay after local ledger timeout').deliveries.map(({ event_id, status }) => ({ event_id, status })), [
    { event_id: eventId, status: 'succeeded' },
  ]);

  const finalEvent = readLifecycle(fixture).events[1];
  assert.equal(finalEvent.delivery.status, 'succeeded');
  assert.equal(finalEvent.delivery.attempts, 2);
  assert.equal(finalEvent.delivery.proof_ref, 'meta:phases.phase-1.github_pr+meta:phases.phase-1.review.fingerprints');
  const remoteAfterReplay = readRemote(fixture);
  assert.deepEqual(remoteAfterReplay.effects, effectsBeforeReplay,
    'replay must find the canonical remote marker before mutation and must not duplicate its effect');
  assert.equal((remoteAfterReplay.comments[String(PR_NUMBER)] || []).filter(({ body }) => body.startsWith(PHASE_MARKER)).length, 1);
  const metadataAfterReplay = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadataAfterReplay.phases['phase-1'].review.proof.event_id, eventId);
  assert.equal(fs.existsSync(claimPath), false, 'successful proof reconciliation must release the recovered claim');
});

test('concurrent public drains produce one claim and one remote effect', async (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const approved = runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    '--artifact', `spec:approved-spec:approved-spec.md:${sha256(fixture.approvedSpec)}`,
    '--json', '--contract', '3',
  ]);
  const eventId = assertCliOk(approved, 'public spec-approved transition').event_id;
  const adapterTrace = path.join(fixture.root, 'concurrent-adapter.jsonl');
  fs.writeFileSync(adapterTrace, '');
  const remoteGate = {
    readyPath: path.join(fixture.root, 'adapter-remote.ready'),
    releasePath: path.join(fixture.root, 'adapter-remote.release'),
  };
  const env = installFakeAdapter(fixture, adapterTrace, { recordRemoteEffects: true, remoteGate });
  const gateA = installStaleCandidateGate(fixture, 'worker-a');
  const gateB = installStaleCandidateGate(fixture, 'worker-b');
  const startGatedDrain = (gate) => startProcess(process.execPath, [
    CORE_CLI, 'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    cwd: fixture.root,
    env: {
      ...env,
      NODE_OPTIONS: [env.NODE_OPTIONS, `--require=${gate.hookPath}`].filter(Boolean).join(' '),
      STALE_QUEUE_EVENT_ID: eventId,
      STALE_QUEUE_READY_FILE: gate.readyPath,
      STALE_QUEUE_RELEASE_FILE: gate.releasePath,
    },
  });
  const workerA = startGatedDrain(gateA);
  let workerB;

  try {
    await waitForFile(gateA.readyPath, workerA.child);
    workerB = startGatedDrain(gateB);
    await waitForFile(gateB.readyPath, workerB.child);
    assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false,
      'both workers must have observed the pending event before either acquires its claim');

    writeFile(gateA.releasePath, 'claim');
    await waitForFile(remoteGate.readyPath, workerA.child);
    const claimPath = path.join(fixture.specDir, '.lifecycle.lock');
    const activeClaim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    assert.equal(activeClaim.event_id, eventId);
    assert.equal(activeClaim.owner_pid, workerA.child.pid,
      'worker A must hold the one real event claim while its remote invocation is active');
    const claimedEvent = readLifecycle(fixture).events[0];
    assert.equal(claimedEvent.delivery.status, 'claimed');
    assert.equal(claimedEvent.delivery.attempts, 1);

    writeFile(gateB.releasePath, 'claim');
    const workerBOutput = await workerB.done;
    let workerBJson = null;
    try { workerBJson = JSON.parse(workerBOutput.stdout); } catch { /* Preserve raw output for the assertion. */ }
    const workerBData = assertCliOk({ ...workerBOutput, json: workerBJson }, 'concurrent public drain worker B');
    assert.deepEqual(workerBData.deliveries, [{
      event_id: eventId,
      revision: 1,
      status: 'pending',
      deferred: true,
      reason: 'claim-held',
    }], 'the competing worker must fail the real claim rather than invoke the adapter');
    assert.equal(fs.readFileSync(adapterTrace, 'utf8').trim().split('\\n').length, 1,
      'only the claim owner may invoke the registered adapter');
    const remoteWhileWorkerAHeldClaim = readRemote(fixture);
    assert.equal(remoteWhileWorkerAHeldClaim.effects.length, 1,
      'the fake GitHub runner must observe one remote effect while the owner is held');
    assert.equal(JSON.parse(fs.readFileSync(claimPath, 'utf8')).owner_pid, workerA.child.pid,
      'worker B must not replace or release worker A’s claim');

    writeFile(remoteGate.releasePath, 'complete');
    const workerAOutput = await workerA.done;
    let workerAJson = null;
    try { workerAJson = JSON.parse(workerAOutput.stdout); } catch { /* Preserve raw output for the assertion. */ }
    const workerAData = assertCliOk({ ...workerAOutput, json: workerAJson }, 'concurrent public drain worker A');
    assert.deepEqual(workerAData.deliveries.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
      { event_id: eventId, revision: 1, status: 'succeeded' },
    ]);
    const finalLifecycle = readLifecycle(fixture);
    assert.equal(finalLifecycle.events[0].delivery.status, 'succeeded');
    assert.equal(finalLifecycle.events[0].delivery.attempts, 1,
      'the shared ledger must record one invocation, not a second delivery attempt');
    assert.equal(readRemote(fixture).effects.length, 1,
      'both workers must converge on exactly one remote effect');
    assert.equal(fs.readFileSync(adapterTrace, 'utf8').trim().split('\\n').length, 1);
    assert.equal(fs.existsSync(claimPath), false, 'the successful owner must release the real claim');
  } finally {
    writeFile(gateA.releasePath, 'claim');
    writeFile(gateB.releasePath, 'claim');
    writeFile(remoteGate.releasePath, 'complete');
    await workerA.done.catch(() => {});
    if (workerB) await workerB.done.catch(() => {});
  }
});
