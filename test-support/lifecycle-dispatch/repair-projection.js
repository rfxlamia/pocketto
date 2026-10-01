'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  FIXED_CLOCK, execFileSync, mkdtempSync, parseJson, path, readFileSync, rmSync, runCli,
  seedLifecycleEvent, sha256Hex, tmpdir, writeFileSync, writeExecutable, registerAdapter,
} = require('./common');

function writePlanSources(planDir) {
  const executionDir = path.join(planDir, 'execution-plan');
  const sources = {
    specContent: 'approved spec content\n',
    phaseOne: 'seed evidence one\n',
    phaseTwo: 'seed evidence two\n',
    phaseContent: '# Phase 1\n\n### Task 1: First\n\nWork done.\n',
  };
  const files = {
    'spec-doc.md': sources.specContent,
    'seed-one.md': sources.phaseOne,
    'seed-two.md': sources.phaseTwo,
    'execution-plan.md': '# Execution Plan\n\n### Task 1: First\n\nBody.\n',
    'execution-plan/index.md': '# Plan Index\n\n**Source Plan:** ../execution-plan.md\n',
    'execution-plan/phase-1.md': sources.phaseContent,
  };
  fs.mkdirSync(executionDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(planDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return sources;
}

function gitRunner(planDir) {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Pocket Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Pocket Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  return (args) => execFileSync('git', args, {
    cwd: planDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: gitEnv,
  });
}

function initializeProgressedProjection(planDir, git, phaseStatus = 'WAITING') {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Pocket Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'plan snapshot']);
  git(['checkout', '-q', '-b', 'feature/issue-90']);

  const initialized = runCli(['log', 'init', planDir, '--json', '--contract', '3'], { cwd: planDir });
  assert.equal(parseJson(initialized.stdout.trim(), 'log init response').ok, true, `log init should succeed: ${initialized.stdout}`);
  const logPath = path.join(planDir, 'log.json');
  const initialProjection = parseJson(readFileSync(logPath, 'utf8'), 'initial log projection');
  const phaseFile = initialProjection.phases[0].file;
  const originalBaselineSha = initialProjection.header.baseline_sha;

  writeFileSync(path.join(planDir, 'task-output.md'), 'completed task output\n');
  git(['add', 'task-output.md']);
  git(['commit', '-q', '-m', 'complete task']);
  const doneSha = git(['rev-parse', 'HEAD']).trim();
  writeFileSync(path.join(planDir, 'correction-output.md'), 'follow-up correction\n');
  git(['add', 'correction-output.md']);
  git(['commit', '-q', '-m', 'record correction']);
  const correctionSha = git(['rev-parse', 'HEAD']).trim();

  const progressedProjection = parseJson(readFileSync(logPath, 'utf8'), 'progressed log projection');
  const progressedPhase = progressedProjection.phases[0];
  progressedPhase.tasks[0].status = 'DONE';
  progressedPhase.tasks[0].done_sha = doneSha;
  progressedPhase.status = phaseStatus;
  progressedPhase.corrections = [{ sha: correctionSha, files: ['correction-output.md'], for_task: 'T1' }];
  writeFileSync(logPath, `${JSON.stringify(progressedProjection, null, 2)}\n`);
  return { logPath, phaseFile, originalBaselineSha, progressedPhase };
}

function seedRepairEvents(planDir, sources) {
  const common = { specDir: planDir, planId: 'plan-90' };
  seedLifecycleEvent({
    ...common,
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(sources.specContent), revision: 1 }],
  });
  for (const [pathName, content] of [['seed-one.md', sources.phaseOne], ['seed-two.md', sources.phaseTwo]]) {
    seedLifecycleEvent({
      ...common,
      planDir,
      type: 'phase-complete',
      artifacts: [{ root: 'plan', kind: 'phase-evidence', path: pathName, sha256: sha256Hex(content), revision: 1 }],
    });
  }
  return require('../../cli/lib/lifecycle-store').lifecyclePathFor(planDir);
}

function forceProjectionWriterFailure(planDir, phaseFile) {
  process.env.POCKETTO_LIFECYCLE_NOW = FIXED_CLOCK;
  const logCmd = require('../../cli/commands/log');
  let projectionError = null;
  try {
    logCmd.run({
      sub: 'update',
      positionals: [planDir, phaseFile, 'REVIEW'],
      projectionWriter: () => { throw new Error('injected projection writer failure'); },
    });
  } catch (err) {
    projectionError = err;
  }
  assert.ok(projectionError, 'projection writer failure should be injected');
  assert.equal(projectionError.code, 'PROJECTION_REPAIR_REQUIRED');
}

function createRepairFixture(root, { phaseStatus = 'WAITING' } = {}) {
  const planDir = path.join(root, 'plan-90');
  const pocketDir = path.join(planDir, '.pocket');
  const adapterCallsPath = path.join(root, 'adapter-calls.jsonl');
  fs.mkdirSync(planDir, { recursive: true });
  fs.mkdirSync(pocketDir, { recursive: true });
  writeFileSync(adapterCallsPath, '');
  const adapterPath = writeExecutable(path.join(root, 'fake-adapter'), `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
const event = eventPath ? JSON.parse(fs.readFileSync(eventPath, 'utf8')) : {};
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
  registerAdapter(pocketDir, adapterPath, { events: ['spec-approved', 'phase-complete'] });
  const sources = writePlanSources(planDir);
  const progress = initializeProgressedProjection(planDir, gitRunner(planDir), phaseStatus);
  const lifecyclePath = seedRepairEvents(planDir, sources);
  forceProjectionWriterFailure(planDir, progress.phaseFile);
  return { planDir, lifecyclePath, adapterCallsPath, ...progress };
}

function assertProjectionRepaired(fixture) {
  const { planDir, logPath, lifecyclePath, originalBaselineSha, progressedPhase } = fixture;
  const before = parseJson(readFileSync(lifecyclePath, 'utf8'), 'lifecycle state before repair');
  assert.equal(before.plan.revision, 4);
  assert.equal(before.events.length, 4);
  assert.equal(before.events[3].event_id, 'plan-90:phase-complete:r4');
  assert.equal(before.events[3].delivery.status, 'pending');

  const staleProjection = parseJson(readFileSync(logPath, 'utf8'), 'stale log projection');
  assert.equal(staleProjection.phases[0].status, 'WAITING');
  assert.deepEqual(staleProjection.phases[0].tasks[0], progressedPhase.tasks[0]);
  assert.deepEqual(staleProjection.phases[0].corrections, progressedPhase.corrections);
  assert.equal(staleProjection.header.baseline_sha, originalBaselineSha);

  const repaired = runCli(
    ['lifecycle', 'repair', planDir, '--json', '--contract', '3'],
    { cwd: planDir, env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: fixture.adapterCallsPath } },
  );
  const envelope = parseJson(repaired.stdout.trim(), 'lifecycle repair response');
  assert.equal(envelope.ok, true, `public lifecycle repair should succeed: ${JSON.stringify(envelope)}${repaired.stderr}`);
  assert.equal(repaired.code, 0);
  assert.equal(envelope.command, 'lifecycle repair');
  assert.equal(envelope.contract, 3);

  const rebuiltProjection = parseJson(readFileSync(logPath, 'utf8'), 'repaired log projection');
  assert.equal(rebuiltProjection.phases[0].status, 'REVIEW');
  assert.deepEqual(rebuiltProjection.phases[0].tasks, staleProjection.phases[0].tasks, 'repair must preserve task statuses and done_sha');
  assert.deepEqual(rebuiltProjection.phases[0].corrections, staleProjection.phases[0].corrections, 'repair must preserve correction records');
  assert.equal(rebuiltProjection.header.baseline_sha, originalBaselineSha, 'repair must preserve the original baseline');
  const after = parseJson(readFileSync(lifecyclePath, 'utf8'), 'lifecycle state after repair');
  assert.equal(after.plan.revision, before.plan.revision, 'repair must not change lifecycle revision');
  assert.equal(after.events.length, before.events.length, 'repair must not append an event');
  assert.deepEqual(after.events, before.events, 'repair must not dispatch or mutate lifecycle events');
  assert.equal(readFileSync(fixture.adapterCallsPath, 'utf8'), '', 'repair must not invoke the local adapter recorder');
}

// Historical T4 repair intent (verbatim; superseded by the amended contract cases below):
// Test file: `test/lifecycle-dispatch.test.js`
// Level: integration
// Test intent: Given committed lifecycle state and event revision 4 with a damaged or missing `log.json`, When `lifecycle repair <spec_dir> --json --contract 3` runs, Then `log.json` is rebuilt, revision and journal length remain unchanged, and no adapter dispatch or new event occurs.
// Exercise through: public `lifecycle repair` and real temporary projection files.
// Test doubles: injected projection writer failure only.
// Expected RED: no repair command or projection rebuild exists.
// Exact command: `node --test test/lifecycle-dispatch.test.js`
// Current contract-alignment case: missing `log.json` without a verified backup returns LIFECYCLE_REPAIR_STATE_UNRECOVERABLE, preserves all state, and is expected to PASS against unchanged production code.

test('lifecycle repair fails closed when log projection is missing without a trusted backup', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-repair-missing-'));
  const originalClock = process.env.POCKETTO_LIFECYCLE_NOW;
  try {
    const fixture = createRepairFixture(root);
    const lifecycleBefore = readFileSync(fixture.lifecyclePath, 'utf8');
    const lifecycleDocBefore = parseJson(lifecycleBefore, 'lifecycle state before missing-projection repair');
    assert.equal(lifecycleDocBefore.plan.revision, 4);
    assert.equal(lifecycleDocBefore.events.length, 4);
    assert.equal(lifecycleDocBefore.events[3].delivery.status, 'pending');

    rmSync(fixture.logPath);
    assert.equal(fs.existsSync(fixture.logPath), false, 'fixture must remove the real log.json projection');

    const repaired = runCli(
      ['lifecycle', 'repair', fixture.planDir, '--json', '--contract', '3'],
      { cwd: fixture.planDir, env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: fixture.adapterCallsPath } },
    );
    const envelope = parseJson(repaired.stdout.trim(), 'missing-projection lifecycle repair response');
    assert.equal(envelope.ok, false, `public lifecycle repair must fail closed without a task-state source: ${JSON.stringify(envelope)}${repaired.stderr}`);
    assert.equal(repaired.code, 1);
    assert.equal(envelope.command, 'lifecycle');
    assert.equal(envelope.contract, 3);
    assert.equal(envelope.error.code, 'LIFECYCLE_REPAIR_STATE_UNRECOVERABLE');
    assert.match(envelope.error.message, /(restore|backup).*(log\\.json|projection)|(log\\.json|projection).*(restore|backup)/i);
    assert.equal(fs.existsSync(fixture.logPath), false, 'repair must leave missing log.json absent');

    assert.equal(readFileSync(fixture.lifecyclePath, 'utf8'), lifecycleBefore, 'repair must preserve lifecycle journal bytes');
    const lifecycleDocAfter = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'lifecycle state after missing-projection repair');
    assert.equal(lifecycleDocAfter.plan.revision, lifecycleDocBefore.plan.revision, 'repair must preserve lifecycle revision');
    assert.equal(lifecycleDocAfter.events.length, lifecycleDocBefore.events.length, 'repair must not append a lifecycle event');
    assert.deepEqual(lifecycleDocAfter.events, lifecycleDocBefore.events, 'repair must preserve event and delivery state without dispatch');
    assert.equal(readFileSync(fixture.adapterCallsPath, 'utf8'), '', 'repair must not invoke the local adapter recorder');
  } finally {
    if (originalClock === undefined) delete process.env.POCKETTO_LIFECYCLE_NOW;
    else process.env.POCKETTO_LIFECYCLE_NOW = originalClock;
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle repair reconciles a stale BLOCKED phase from the committed event', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-repair-blocked-'));
  const originalClock = process.env.POCKETTO_LIFECYCLE_NOW;
  try {
    const fixture = createRepairFixture(root, { phaseStatus: 'BLOCKED' });
    const lifecycleBefore = readFileSync(fixture.lifecyclePath, 'utf8');
    const before = parseJson(lifecycleBefore, 'lifecycle state before BLOCKED repair');
    const staleProjection = parseJson(readFileSync(fixture.logPath, 'utf8'), 'stale BLOCKED projection');
    assert.equal(staleProjection.phases[0].status, 'BLOCKED');
    assert.deepEqual(staleProjection.phases[0].tasks[0], fixture.progressedPhase.tasks[0]);

    const repaired = runCli(
      ['lifecycle', 'repair', fixture.planDir, '--json', '--contract', '3'],
      { cwd: fixture.planDir, env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: fixture.adapterCallsPath } },
    );
    const envelope = parseJson(repaired.stdout.trim(), 'BLOCKED phase repair response');
    assert.equal(envelope.ok, true, `public repair should reconcile BLOCKED phase: ${JSON.stringify(envelope)}${repaired.stderr}`);
    assert.equal(repaired.code, 0);

    const reconciled = parseJson(readFileSync(fixture.logPath, 'utf8'), 'reconciled BLOCKED projection');
    assert.equal(reconciled.phases[0].status, 'REVIEW', 'committed phase-complete event must reconcile BLOCKED to REVIEW');
    assert.deepEqual(reconciled.phases[0].tasks, staleProjection.phases[0].tasks, 'task status and done_sha must be preserved');
    assert.deepEqual(reconciled.phases[0].corrections, staleProjection.phases[0].corrections, 'corrections must be preserved');
    assert.equal(reconciled.header.baseline_sha, staleProjection.header.baseline_sha);
    assert.equal(readFileSync(fixture.lifecyclePath, 'utf8'), lifecycleBefore, 'repair must not mutate lifecycle bytes');
    const after = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'lifecycle state after BLOCKED repair');
    assert.equal(after.plan.revision, before.plan.revision);
    assert.deepEqual(after.events.map((event) => event.event_id), before.events.map((event) => event.event_id));
    assert.deepEqual(after.events, before.events, 'repair must not mutate journal or delivery state');
    assert.equal(readFileSync(fixture.adapterCallsPath, 'utf8'), '', 'repair must not invoke the adapter');
  } finally {
    if (originalClock === undefined) delete process.env.POCKETTO_LIFECYCLE_NOW;
    else process.env.POCKETTO_LIFECYCLE_NOW = originalClock;
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle repair updates a stale phase projection without losing task progress or dispatching', () => {
  // Given a valid stale log.json with task progress and committed lifecycle state,
  // When public `lifecycle repair <spec_dir> --json --contract 3` runs,
  // Then lifecycle-derived phase state is repaired while task progress, original
  // baseline, revision, journal length, event IDs, and delivery state are preserved.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-repair-'));
  const originalClock = process.env.POCKETTO_LIFECYCLE_NOW;
  try {
    assertProjectionRepaired(createRepairFixture(root));
  } finally {
    if (originalClock === undefined) delete process.env.POCKETTO_LIFECYCLE_NOW;
    else process.env.POCKETTO_LIFECYCLE_NOW = originalClock;
    rmSync(root, { recursive: true, force: true });
  }
});

module.exports = { createRepairFixture, gitRunner };
