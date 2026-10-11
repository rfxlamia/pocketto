'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PLAN_ID } = require('./support/constants');
const { runCore, assertCliOk } = require('./support/core-cli');
const { installFakeGitHub, createEnvironment } = require('./support/fixture');
const { installEnterpriseAdapter } = require('./support/enterprise');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');
const { sha256, writeFile } = require('./support/files');
const { validateAdapterResponse } = require('../../cli/lib/lifecycle-contract');

// Every branch name below is derived from PLAN_ID (pocket/<plan_id>/phase-N).
const ROOT_BASE = `feature/${PLAN_ID}`;
const PUSH_CONSENT = 'phase-branches';

function phaseBranch(order) {
  return `pocket/${PLAN_ID}/phase-${order}`;
}

function phasePath(order) {
  return `execution-plan/phase-${order}.md`;
}

// Temp fixture: a work repo, a bare origin, and the fake gh state all live in
// sibling directories of one mkdtemp root. Only `work/` is a git worktree, so
// the fake gh plumbing never shows up as dirty work outside the plan.
function createStackedFixture(t, { ignored = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-stacked-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'work');
  const origin = path.join(base, 'origin.git');
  const hooks = path.join(base, 'no-hooks');
  fs.mkdirSync(root);
  fs.mkdirSync(hooks);
  execFileSync('git', ['init', '--quiet', '--bare', origin]);
  const fake = installFakeGitHub(path.join(base, 'gh'));
  const plan = writeStackedPlan(root, { ignored });
  initializeStackedGit({ root, origin, hooks, ignored });
  const fixture = {
    base, root, origin, ...plan, remotePath: fake.remotePath, env: createEnvironment(fake), trace: [],
  };
  installEnterpriseAdapter(fixture, { pushConsent: PUSH_CONSENT });
  return fixture;
}

function writeStackedPlan(root, { ignored }) {
  const specDir = path.join(root, 'docs', 'pocket', 'spec', PLAN_ID);
  const planDir = path.join(root, 'docs', 'pocket', 'plans', PLAN_ID);
  const approvedSpec = [
    '# Stacked integration spec', '', '## Summary',
    'Exercise the stacked phase PR flow through public surfaces only.', '',
  ].join('\n');
  writeFile(path.join(specDir, 'approved-spec.md'), approvedSpec);
  writeFile(path.join(planDir, 'execution-plan.md'), '# Stacked integration plan\n');
  writeFile(path.join(planDir, 'execution-plan', 'index.md'), planIndex());
  for (const order of [1, 2]) {
    writeFile(path.join(planDir, phasePath(order)), phaseFile(order));
    writeFile(path.join(planDir, 'reviews', `T${order}-review.json`), reviewFile(order));
  }
  return { specDir, planDir, approvedSpec, ignored };
}

function planIndex() {
  return [
    '# Stacked integration fixture', '',
    `**Spec:** docs/pocket/spec/${PLAN_ID}/approved-spec.md`,
    '**Source Plan:** execution-plan.md', '', '## Task Index', '',
    '- [T1] Phase 1 task', '- [T2] Phase 2 task', '',
  ].join('\n');
}

function phaseFile(order) {
  return [
    `# Phase ${order} — stacked integration`, '',
    `### Task ${order}: Stacked task ${order}`, '',
    `Completion evidence: phase ${order} is exercised through the public CLI.`, '',
  ].join('\n');
}

function reviewFile(order) {
  const review = { task_id: `T${order}`, overall: 'REVIEW_PASS', stage_1: { issues: [] }, stage_2: { issues: [] } };
  return `${JSON.stringify(review, null, 2)}\n`;
}

function initializeStackedGit({ root, origin, hooks, ignored }) {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('checkout', '--quiet', '-b', ROOT_BASE);
  git('config', 'user.name', 'Stacked Integration Test');
  git('config', 'user.email', 'stacked-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', hooks);
  git('remote', 'add', 'origin', origin);
  if (ignored) {
    writeFile(path.join(root, '.gitignore'), 'docs/pocket/\n');
    git('add', '.gitignore');
  } else {
    git('add', 'docs');
  }
  git('commit', '--quiet', '-m', 'fixture: create stacked integration plan');
  git('push', '--quiet', 'origin', ROOT_BASE);
}

function gitOut(fixture, ...args) {
  return execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8' }).trim();
}

function ghCallCount(fixture) {
  return readRemote(fixture).calls.length;
}

function prCreates(fixture) {
  return readRemote(fixture).calls.filter((args) => args[0] === 'pr' && args[1] === 'create');
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
}

// Runs one Core command and snapshots the fake gh call count around it. Every
// Core command goes through here, so the trace proves which commands touch gh.
function coreCommand(fixture, command, args) {
  const before = ghCallCount(fixture);
  const data = assertCliOk(runCore(fixture, [...args, '--json', '--contract', '3']), command);
  const ghCalls = ghCallCount(fixture) - before;
  fixture.trace.push({ command, ghCalls });
  return { data, ghCalls };
}

function drain(fixture) {
  return coreCommand(fixture, 'lifecycle drain', ['lifecycle', 'drain', fixture.specDir]);
}

function logUpdate(fixture, order, ...extra) {
  return coreCommand(fixture, 'log update', ['log', 'update', fixture.planDir, phasePath(order), ...extra]).data;
}

function setUpPlan(fixture) {
  coreCommand(fixture, 'log init', ['log', 'init', fixture.planDir, '--phase-branches', 'stacked']);
  coreCommand(fixture, 'lifecycle transition', [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    '--artifact', `spec:approved-spec:approved-spec.md:${sha256(fixture.approvedSpec)}`,
  ]);
  // Delivers spec-approved (creates the issue) before any phase-complete work,
  // so phase drains below are measured without that one-time issue create.
  drain(fixture);
}

// REVIEW a phase: task DONE, phase REVIEW, then the drain that delivers phase-complete.
function reviewPhase(fixture, order) {
  logUpdate(fixture, order, 'DONE', '--task', `T${order}`);
  logUpdate(fixture, order, 'REVIEW');
  return drain(fixture);
}

function appendCloseout(fixture, order) {
  const file = path.join(fixture.planDir, 'closeout.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Closeout\n';
  fs.writeFileSync(file, `${existing}\n## Phase ${order}\n<!-- pocket-closeout:phase-${order} -->\nPhase ${order} closeout body.\n`);
}

// Phase DONE, closeout section appended (as pocket-closing does), then log handoff.
function handOffPhase(fixture, order) {
  logUpdate(fixture, order, 'DONE');
  appendCloseout(fixture, order);
  return coreCommand(fixture, 'log handoff', ['log', 'handoff', fixture.planDir, phasePath(order)]).data;
}

// Full phase delivery: REVIEW, handoff, then the drain that delivers phase-closed.
function deliverPhase(fixture, order) {
  const review = reviewPhase(fixture, order);
  const handoff = handOffPhase(fixture, order);
  const drained = drain(fixture);
  return { review, handoff, drained };
}

// REVIEW then handoff with no drain in between; returns the handoff data.
function reviewAndHandOff(fixture, order) {
  reviewPhase(fixture, order);
  return handOffPhase(fixture, order);
}

test('stacked end to end: bases', (t) => {
  const fixture = createStackedFixture(t);
  setUpPlan(fixture);

  const { review: reviewOne } = deliverPhase(fixture, 1);
  assert.deepEqual(reviewOne.data.deliveries.map(({ event_id, status }) => [event_id, status]), [
    [`${PLAN_ID}:phase-complete:r2`, 'succeeded'],
  ], 'phase-1 phase-complete must succeed as deferred');
  assert.equal(reviewOne.ghCalls, 0, 'phase-1 phase-complete drain must make zero gh calls');

  const { review: reviewTwo } = deliverPhase(fixture, 2);
  assert.deepEqual(reviewTwo.data.deliveries.map(({ event_id, status }) => [event_id, status]), [
    [`${PLAN_ID}:phase-complete:r4`, 'succeeded'],
  ], 'phase-2 phase-complete must succeed as deferred');
  assert.equal(reviewTwo.ghCalls, 0, 'phase-2 phase-complete drain must make zero gh calls');

  const creates = prCreates(fixture);
  const rootPr = creates.findIndex((args) => flag(args, '--base') === ROOT_BASE && flag(args, '--head') === phaseBranch(1));
  const childPr = creates.findIndex((args) => flag(args, '--base') === phaseBranch(1) && flag(args, '--head') === phaseBranch(2));
  assert.ok(rootPr >= 0, `phase 1 PR must target root base ${ROOT_BASE}: ${JSON.stringify(creates)}`);
  assert.ok(childPr > rootPr, `phase 2 PR must target ${phaseBranch(1)} after the root PR: ${JSON.stringify(creates)}`);
  assert.equal(gitOut(fixture, 'rev-parse', '--abbrev-ref', 'HEAD'), phaseBranch(2), 'HEAD must end on the phase-2 branch');
});

test('stacked end to end: core no gh', (t) => {
  const fixture = createStackedFixture(t);
  const baseline = ghCallCount(fixture);
  setUpPlan(fixture);
  deliverPhase(fixture, 1);
  reviewAndHandOff(fixture, 2);
  coreCommand(fixture, 'log close', ['log', 'close', fixture.planDir]);
  drain(fixture);

  for (const expected of ['log init', 'lifecycle transition', 'log update', 'log handoff', 'log close']) {
    assert.ok(fixture.trace.some((entry) => entry.command === expected),
      `${expected} must be snapshotted around its call`);
  }
  for (const entry of fixture.trace.filter((item) => item.command !== 'lifecycle drain')) {
    assert.equal(entry.ghCalls, 0, `${entry.command} must not change the fake gh call log`);
  }
  const drainCalls = fixture.trace
    .filter((entry) => entry.command === 'lifecycle drain')
    .reduce((sum, entry) => sum + entry.ghCalls, 0);
  assert.ok(drainCalls > 0, 'lifecycle drain must be the command that changes the fake gh call log');
  assert.equal(ghCallCount(fixture) - baseline, drainCalls, 'only lifecycle drain may change the fake gh call log');
});

test('stacked end to end: plan.phases identity', (t) => {
  const fixture = createStackedFixture(t);
  setUpPlan(fixture);
  reviewAndHandOff(fixture, 1);

  const before = readLifecycle(fixture);
  assert.equal(before.plan.phases['phase-1'].branch, phaseBranch(1), 'handoff must record phase-1 identity in plan.phases');
  const pendingClosed = before.events.find((event) => event.type === 'phase-closed');
  assert.equal(pendingClosed.delivery.status, 'pending', 'phase-1 phase-closed must still be pending before drain');
  t.diagnostic(`plan.branch before fixture edit: ${before.plan.branch}`);

  // Fixture-only edit: a misleading plan.branch. Identity must come from plan.phases.
  const lifecycleFile = path.join(fixture.specDir, 'lifecycle.json');
  before.plan.branch = phaseBranch(2);
  fs.writeFileSync(lifecycleFile, `${JSON.stringify(before, null, 2)}\n`);
  assert.equal(readLifecycle(fixture).plan.branch, phaseBranch(2), 'the plan.branch edit must be on disk before drain');

  const { data } = drain(fixture);
  assert.equal(readLifecycle(fixture).plan.branch, phaseBranch(2),
    'the misleading plan.branch must still be in place when drain reads the lifecycle document');
  assert.deepEqual(data.deliveries.map((delivery) => delivery.status), ['succeeded'],
    'phase-1 phase-closed must succeed');
  const creates = prCreates(fixture);
  assert.equal(creates.length, 1, 'drain must create exactly the phase-1 PR');
  assert.equal(flag(creates[0], '--head'), phaseBranch(1), 'phase-1 PR head must come from plan.phases, not plan.branch');
  assert.equal(flag(creates[0], '--base'), ROOT_BASE, 'phase-1 PR base must be the recorded root base');
});

test('stacked end to end: pushed tip', (t) => {
  const fixture = createStackedFixture(t);
  setUpPlan(fixture);
  const { handoff } = deliverPhase(fixture, 1);
  assert.equal(handoff.steps.commit, 'committed', 'tracked plan artifacts must produce a handoff commit');

  const handoffCommits = gitOut(fixture, 'log', '--all', '--format=%H', '--fixed-strings',
    `--grep=Pocket-Handoff: ${PLAN_ID}/phase-1`).split('\n').filter(Boolean);
  assert.equal(handoffCommits.length, 1, 'exactly one commit must carry the phase-1 Pocket-Handoff trailer');
  assert.equal(handoff.commit.sha, handoffCommits[0], 'log handoff must report the trailer commit');
  const remoteTip = execFileSync('git', ['--git-dir', fixture.origin, 'rev-parse', `refs/heads/${phaseBranch(1)}`],
    { encoding: 'utf8' }).trim();
  assert.equal(remoteTip, handoffCommits[0], 'origin phase-1 tip must be the local handoff commit');
});

test('stacked end to end: notices', (t) => {
  const fixture = createStackedFixture(t, { ignored: true });
  setUpPlan(fixture);
  const { handoff, drained } = deliverPhase(fixture, 1);
  t.diagnostic(`ignored fixture: handoff commit step = ${handoff.steps.commit}`);
  const { data } = drained;

  const delivery = data.deliveries.find((item) => item.event_id.includes(':phase-closed:'));
  assert.ok(delivery, 'phase-1 phase-closed must be delivered by the drain after handoff');
  assert.equal(delivery.status, 'succeeded', 'phase-1 phase-closed must succeed under ignored artifacts');
  const notices = delivery.notices || [];
  const codes = notices.map((notice) => notice.code);
  assert.ok(codes.includes('PR_CREATED'), `notices must include PR_CREATED: ${JSON.stringify(notices)}`);
  assert.ok(codes.includes('POCKET_ARTIFACTS_IGNORED'),
    `notices must include POCKET_ARTIFACTS_IGNORED: ${JSON.stringify(notices)}`);
  for (const notice of notices) {
    assert.doesNotMatch(notice.message, /https?:\/\//, `notice ${notice.code} must not carry a URL`);
  }
  const checked = validateAdapterResponse({
    event_id: delivery.event_id,
    status: delivery.status,
    proof_ref: delivery.proof_ref,
    proof_hash: delivery.proof_hash,
    notices,
  }, delivery.event_id);
  assert.equal(checked.ok, true, `every notice must pass validateAdapterResponse: ${JSON.stringify(checked)}`);
});

test('stacked end to end: close ordering', (t) => {
  const fixture = createStackedFixture(t);
  setUpPlan(fixture);
  deliverPhase(fixture, 1);
  reviewAndHandOff(fixture, 2);
  // The last phase is handed off before close: phase-closed after plan-closed is rejected (LIFECYCLE_BAD_STATE).
  coreCommand(fixture, 'log close', ['log', 'close', fixture.planDir]);

  const pending = readLifecycle(fixture);
  const phaseClosedRevisions = pending.events.filter((event) => event.type === 'phase-closed').map((event) => event.revision);
  const planClosed = pending.events.find((event) => event.type === 'plan-closed');
  assert.equal(phaseClosedRevisions.length, 2, 'both phases must have a phase-closed event');
  for (const revision of phaseClosedRevisions) {
    assert.ok(planClosed.revision > revision, `plan-closed (r${planClosed.revision}) must follow phase-closed (r${revision})`);
  }
  assert.equal(pending.events.find((event) => event.revision === phaseClosedRevisions[1]).delivery.status, 'pending',
    'phase-2 phase-closed must still be pending when the closing drain runs');

  const { data } = drain(fixture);
  assert.deepEqual(data.deliveries.map((delivery) => [delivery.revision, delivery.status]), [
    [phaseClosedRevisions[1], 'succeeded'],
    [planClosed.revision, 'succeeded'],
  ], 'the closing drain must deliver phase-2 phase-closed and then plan-closed, in revision order');

  const branches = gitOut(fixture, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/pocket/').split('\n').filter(Boolean).sort();
  assert.deepEqual(branches, [phaseBranch(1), phaseBranch(2)], 'the last-phase handoff must not create a phase-3 branch');
  assert.equal(gitOut(fixture, 'rev-parse', '--abbrev-ref', 'HEAD'), phaseBranch(2), 'HEAD must stay on the phase-2 branch');
});
