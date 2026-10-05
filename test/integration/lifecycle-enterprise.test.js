'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const enterpriseMeta = require('../../enterprise/meta');

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

function runCore(fixture, args, env = fixture.env) {
  const result = runProcess(process.execPath, [CORE_CLI, ...args], { cwd: fixture.root, env });
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
