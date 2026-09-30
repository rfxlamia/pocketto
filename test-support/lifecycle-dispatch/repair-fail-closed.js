'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, parseJson, execFileSync, mkdirSync, mkdtempSync, path, readFileSync,
  rmSync, runCli, seedLifecycleEvent, sha256Hex, tmpdir, writeExecutable,
  writeFileSync, registerAdapter,
} = require('./common');

function gitRunner(planDir) {
  const env = {
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
    env,
  });
}

function initializePlan(planDir, git) {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Pocket Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial plan snapshot']);
  const baselineSha = git(['rev-parse', 'HEAD']).trim();
  const initialized = runCli(['log', 'init', planDir, '--json', '--contract', '3'], { cwd: planDir });
  assert.equal(parseJson(initialized.stdout.trim(), 'log init response').ok, true, `log init should succeed: ${initialized.stdout}`);
  return baselineSha;
}

function commitTaskProgress(planDir, git, logPath, baselineSha) {
  writeFileSync(path.join(planDir, 'task-output.txt'), 'completed task output\n');
  git(['add', 'task-output.txt']);
  git(['commit', '-q', '-m', 'complete task one']);
  const doneSha = git(['rev-parse', 'HEAD']).trim();
  writeFileSync(path.join(planDir, 'correction-output.txt'), 'follow-up correction\n');
  git(['add', 'correction-output.txt']);
  git(['commit', '-q', '-m', 'record correction']);
  const correctionSha = git(['rev-parse', 'HEAD']).trim();

  const progressed = parseJson(readFileSync(logPath, 'utf8'), 'progressed log projection');
  const phase = progressed.phases[0];
  const completedTask = phase.tasks.find((task) => task.id === 'T1');
  const laterTask = phase.tasks.find((task) => task.id === 'T2');
  assert.ok(completedTask && laterTask, 'fixture must contain both planned tasks');
  completedTask.status = 'DONE';
  completedTask.done_sha = doneSha;
  laterTask.status = 'REVIEW';
  phase.status = 'REVIEW';
  phase.corrections = [{ sha: correctionSha, files: ['correction-output.txt'], for_task: 'T1' }];
  assert.equal(progressed.header.baseline_sha, baselineSha, 'fixture must retain its original baseline before damage');
  assert.equal(completedTask.status, 'DONE');
  assert.equal(completedTask.done_sha, doneSha);
  assert.equal(phase.corrections[0].sha, correctionSha);
  writeFileSync(logPath, `${JSON.stringify(progressed, null, 2)}\n`);
  return progressed;
}

function seedLifecycleState(planDir, git, specContent, phaseContent) {
  seedLifecycleEvent({
    specDir: planDir,
    planId: 'plan-91',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(specContent), revision: 1 }],
  });
  seedLifecycleEvent({
    specDir: planDir,
    planDir,
    planId: 'plan-91',
    type: 'phase-complete',
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'execution-plan-phase-1.md', sha256: sha256Hex(phaseContent), revision: 1 }],
  });
  return require('../../cli/lib/lifecycle-store').lifecyclePathFor(planDir);
}

function assertNeutralLifecycleSchema(lifecycleDoc) {
  assert.equal(lifecycleDoc.plan.revision, 2);
  assert.equal(lifecycleDoc.events.length, 2);
  const taskProjectionFields = new Set([
    'baseline_sha', 'done_sha', 'corrections', 'tasks', 'task_id', 'task_status', 'task_statuses',
  ]);
  const hasTaskProjectionField = (value) => {
    if (Array.isArray(value)) return value.some(hasTaskProjectionField);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) =>
      taskProjectionFields.has(key) || hasTaskProjectionField(child));
  };
  assert.equal(
    hasTaskProjectionField(lifecycleDoc),
    false,
    'authoritative lifecycle schema must not encode task progress or projection-only fields',
  );
}

function damageProjection(planDir, progressed, baselineSha, doneSha, correctionSha, logPath) {
  // Keep plan path and baseline metadata while corrupting the task collection shape.
  const retainedPhase = { ...progressed.phases[0] };
  retainedPhase.tasks = { retained: retainedPhase.tasks };
  progressed.phases = { damagedTaskState: [retainedPhase] };
  const retainedTask = progressed.phases.damagedTaskState[0].tasks.retained.find((task) => task.id === 'T1');
  assert.equal(progressed.header.plan_dir, planDir, 'fixture must keep the plan path needed by repair');
  assert.equal(progressed.header.baseline_sha, baselineSha, 'fixture must keep original baseline metadata');
  assert.equal(retainedTask.status, 'DONE', 'damaged bytes must retain task status');
  assert.equal(retainedTask.done_sha, doneSha, 'damaged bytes must retain task done_sha');
  assert.equal(progressed.phases.damagedTaskState[0].corrections[0].sha, correctionSha);
  const damagedBytes = `${JSON.stringify(progressed, null, 2)}\n`;
  writeFileSync(logPath, damagedBytes);
  return damagedBytes;
}

function createFailClosedFixture(root) {
  const projectDir = path.join(root, 'project');
  const planDir = path.join(projectDir, 'plans', 'plan-91');
  const phasePath = path.join(planDir, 'execution-plan-phase-1.md');
  const logPath = path.join(planDir, 'log.json');
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  const pocketDir = path.join(projectDir, '.pocket');
  mkdirSync(planDir, { recursive: true });
  mkdirSync(pocketDir, { recursive: true });
  const specContent = 'approved spec for fail-closed repair\n';
  const phaseContent = '# Phase 1\n\n### Task 1: Completed work\n\n### Task 2: Later work\n';
  writeFileSync(path.join(planDir, 'spec-doc.md'), specContent);
  writeFileSync(phasePath, phaseContent);

  const git = gitRunner(planDir);
  const baselineSha = initializePlan(planDir, git);
  const progressed = commitTaskProgress(planDir, git, logPath, baselineSha);
  const lifecyclePath = seedLifecycleState(planDir, git, specContent, phaseContent);
  const lifecycleBefore = readFileSync(lifecyclePath, 'utf8');
  const lifecycleDoc = parseJson(lifecycleBefore, 'lifecycle document');
  assert.equal(lifecycleDoc.plan.plan_dir, planDir, 'lifecycle seed must commit the plan root required by repair');
  assertNeutralLifecycleSchema(lifecycleDoc);

  const doneSha = progressed.phases[0].tasks.find((task) => task.id === 'T1').done_sha;
  const correctionSha = progressed.phases[0].corrections[0].sha;
  const damagedBytes = damageProjection(planDir, progressed, baselineSha, doneSha, correctionSha, logPath);
  writeFileSync(callsPath, '');
  const adapterPath = writeExecutable(path.join(root, 'fake-adapter'), `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
const event = eventPath ? JSON.parse(fs.readFileSync(eventPath, 'utf8')) : {};
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
  registerAdapter(pocketDir, adapterPath, { events: ['spec-approved', 'phase-complete'] });
  return { projectDir, planDir, logPath, lifecyclePath, lifecycleBefore, lifecycleDoc, damagedBytes, callsPath, baselineSha };
}

function assertRepairFailsClosed(fixture) {
  const result = runCli(
    ['lifecycle', 'repair', fixture.planDir, '--json', '--contract', '3'],
    { cwd: fixture.projectDir, env: { ADAPTER_CALLS: fixture.callsPath, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK } },
  );
  const envelope = parseJson(result.stdout.trim(), 'lifecycle repair response');
  if (envelope.ok) {
    const unsafeRebuild = parseJson(readFileSync(fixture.logPath, 'utf8'), 'unsafe repaired projection');
    const regeneratedTask = unsafeRebuild.phases[0].tasks.find((task) => task.id === 'T1');
    assert.equal(regeneratedTask.status, 'WAITING', 'unsafe fallback regenerates task progress as WAITING');
    assert.equal(regeneratedTask.done_sha, undefined, 'unsafe fallback drops the task done_sha');
    assert.equal(unsafeRebuild.phases[0].corrections, undefined, 'unsafe fallback drops phase corrections');
    assert.notEqual(unsafeRebuild.header.baseline_sha, fixture.baselineSha, 'unsafe fallback replaces the original baseline with current HEAD');
  }
  assert.equal(envelope.ok, false, `repair must refuse lossy reconstruction: ${JSON.stringify(envelope)}`);
  assert.equal(result.code, 1);
  assert.equal(envelope.error.code, 'LIFECYCLE_REPAIR_STATE_UNRECOVERABLE');
  assert.match(envelope.error.message, /(restore|backup).*(log\.json|projection)|(log\.json|projection).*(restore|backup)/i);
  assert.equal(readFileSync(fixture.logPath, 'utf8'), fixture.damagedBytes, 'repair must preserve the damaged projection bytes');
  assert.equal(readFileSync(fixture.lifecyclePath, 'utf8'), fixture.lifecycleBefore, 'repair must preserve the lifecycle journal bytes');
  const lifecycleAfter = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'lifecycle document after repair');
  assert.equal(lifecycleAfter.plan.revision, fixture.lifecycleDoc.plan.revision);
  assert.equal(lifecycleAfter.events.length, fixture.lifecycleDoc.events.length);
  assert.equal(readFileSync(fixture.callsPath, 'utf8'), '', 'repair must not dispatch lifecycle events');
}

test('lifecycle repair fails closed when damaged projection progress is not recoverable', () => {
  // Given progressed task state in a structurally damaged log.json that the
  // lifecycle journal cannot reproduce, When repair runs, Then it returns an
  // actionable error, preserves both files, and never dispatches an adapter.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-repair-fail-closed-'));
  try {
    assertRepairFailsClosed(createFailClosedFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
