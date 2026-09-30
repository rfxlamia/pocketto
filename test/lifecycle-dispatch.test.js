'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');
const FIXED_CLOCK = '2026-09-19T12:00:00.000Z';

function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

function runCli(args, { cwd, env } = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
      code: err.status === null ? 1 : err.status,
    };
  }
}

test('lifecycle drain delivers contiguous events serially in revision order without creating events', () => {
  // Given pending/retryable events for one plan at contiguous revisions 1, 2, and 3,
  // When public `lifecycle drain` runs with a temporary plan and fake adapter,
  // Then it dispatches serially in ascending revision, creates no event, and
  // preserves each original event ID. The fixed clock and lifecycle store/files are real.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-order-'));
  try {
    const projectDir = path.join(root, 'project');
    const specDir = path.join(projectDir, 'spec', 'demo-plan');
    const planDir = path.join(projectDir, 'plans', 'demo-plan');
    const pocketDir = path.join(projectDir, '.pocket');
    mkdirSync(specDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });

    const specContent = 'approved spec\n';
    const phaseOneContent = 'phase one evidence\n';
    const phaseTwoContent = 'phase two evidence\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    writeFileSync(path.join(planDir, 'phase-one.md'), phaseOneContent);
    writeFileSync(path.join(planDir, 'phase-two.md'), phaseTwoContent);

    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const commit = (type, rootName, kind, relativePath, content, evidenceRevision) => {
      const result = commitTransition({
        specDir,
        planDir: type === 'spec-approved' ? null : planDir,
        planId: 'demo-plan',
        type,
        artifacts: [{
          root: rootName,
          kind,
          path: relativePath,
          sha256: sha256Hex(content),
          revision: evidenceRevision,
        }],
        deps: { now: () => FIXED_CLOCK },
      });
      assert.equal(result.ok, true, `event seed should succeed: ${JSON.stringify(result)}`);
      return result.event;
    };

    commit('spec-approved', 'spec', 'spec-doc', 'spec.md', specContent, 1);
    commit('phase-complete', 'plan', 'phase-evidence', 'phase-one.md', phaseOneContent, 1);
    commit('phase-complete', 'plan', 'phase-evidence', 'phase-two.md', phaseTwoContent, 2);

    const lifecyclePath = lifecyclePathFor(specDir);
    const before = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    before.events[1].delivery.status = 'retryable';
    before.events[1].delivery.attempts = 1;
    writeFileSync(lifecyclePath, `${JSON.stringify(before, null, 2)}\n`);
    const originalEventIds = before.events.map((event) => event.event_id);

    const callsPath = path.join(root, 'adapter-calls.jsonl');
    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) {
  process.stderr.write('event file argument is missing\\n');
  process.exit(2);
}
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const delayMs = { 1: 150, 2: 75, 3: 0 }[event.revision] || 0;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id, revision: event.revision }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved', 'phase-complete', 'plan-closed'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const result = runCli(
      ['lifecycle', 'drain', specDir, '--json', '--contract', '3'],
      {
        cwd: projectDir,
        env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: callsPath },
      },
    );
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(
      envelope.ok,
      true,
      `public lifecycle drain should succeed: ${JSON.stringify(envelope)}${result.stderr}`,
    );
    assert.equal(result.code, 0);
    assert.equal(envelope.command, 'lifecycle drain');
    assert.equal(envelope.contract, 3);

    const delivered = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      delivered,
      before.events.map((event) => ({ event_id: event.event_id, revision: event.revision })),
      'adapter completion order must remain serial and ascending by revision',
    );

    const after = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(after.plan.revision, before.plan.revision, 'drain must not create a lifecycle revision');
    assert.equal(after.events.length, before.events.length, 'drain must not append lifecycle events');
    assert.deepEqual(
      after.events.map((event) => event.event_id),
      originalEventIds,
      'drain must preserve every original event ID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle drain leaves revision gaps pending with an actionable diagnostic', () => {
  // Given revision 5 arrives while revision 4 is unavailable,
  // When public `lifecycle drain` runs,
  // Then revision 5 remains pending and the JSON envelope identifies the plan,
  // blocked revision, missing predecessor, and next actionable recovery step.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-gap-'));
  try {
    const projectDir = path.join(root, 'project');
    const specDir = path.join(projectDir, 'spec', 'demo-plan');
    const planDir = path.join(projectDir, 'plans', 'demo-plan');
    const pocketDir = path.join(projectDir, '.pocket');
    mkdirSync(specDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });

    const specContent = 'approved spec for gap test\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const seeded = commitTransition({
      specDir,
      planDir: null,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec.md',
        sha256: sha256Hex(specContent),
        revision: 1,
      }],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(seeded.ok, true, `revision 1 seed should succeed: ${JSON.stringify(seeded)}`);

    for (let revision = 2; revision <= 5; revision += 1) {
      const content = `phase ${revision} evidence\n`;
      const relativePath = `phase-${revision}.md`;
      writeFileSync(path.join(planDir, relativePath), content);
      const result = commitTransition({
        specDir,
        planDir,
        planId: 'demo-plan',
        type: 'phase-complete',
        artifacts: [{
          root: 'plan',
          kind: 'phase-evidence',
          path: relativePath,
          sha256: sha256Hex(content),
          revision,
        }],
        deps: { now: () => FIXED_CLOCK },
      });
      assert.equal(result.ok, true, `revision ${revision} seed should succeed: ${JSON.stringify(result)}`);
    }

    const lifecyclePath = lifecyclePathFor(specDir);
    const before = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    before.events = before.events
      .filter((event) => event.revision !== 4)
      .map((event) => {
        if (event.revision < 5) event.delivery.status = 'succeeded';
        return event;
      });
    writeFileSync(lifecyclePath, `${JSON.stringify(before, null, 2)}\n`);

    const callsPath = path.join(root, 'adapter-calls.jsonl');
    writeFileSync(callsPath, '');
    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved', 'phase-complete', 'plan-closed'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const result = runCli(
      ['lifecycle', 'drain', specDir, '--json', '--contract', '3'],
      {
        cwd: projectDir,
        env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: callsPath },
      },
    );
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.ok, true, `lifecycle drain should return a gap result: ${JSON.stringify(envelope)}`);
    assert.equal(envelope.command, 'lifecycle drain');
    assert.equal(envelope.contract, 3);

    const gaps = Array.isArray(envelope.data.gaps) ? envelope.data.gaps : [];
    assert.equal(gaps.length, 1, 'drain must classify the blocked revision gap');
    assert.equal(gaps[0].plan_id, 'demo-plan');
    assert.equal(gaps[0].blocked_revision, 5);
    assert.equal(gaps[0].missing_predecessor, 4);
    assert.ok(
      typeof gaps[0].next_step === 'string'
        && /4/.test(gaps[0].next_step)
        && /(restore|replay|recover)/i.test(gaps[0].next_step),
      'gap diagnostic must give an actionable recovery step for revision 4',
    );

    const after = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(after.plan.revision, 5);
    assert.equal(after.events.length, before.events.length);
    const revisionFive = after.events.find((event) => event.revision === 5);
    assert.equal(revisionFive.delivery.status, 'pending', 'revision 5 must remain pending behind the gap');
    assert.equal(readFileSync(callsPath, 'utf8'), '', 'revision 5 must not be dispatched out of order');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle repair updates a stale phase projection without losing task progress or dispatching', () => {
  // Given a valid stale log.json with task progress and committed lifecycle state,
  // When public `lifecycle repair <spec_dir> --json --contract 3` runs,
  // Then lifecycle-derived phase state is repaired while task progress, original
  // baseline, revision, journal length, event IDs, and delivery state are preserved.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-repair-'));
  const planDir = path.join(root, 'plan-90');
  mkdirSync(planDir, { recursive: true });
  const executionDir = path.join(planDir, 'execution-plan');
  mkdirSync(executionDir, { recursive: true });

  const specContent = 'approved spec content\n';
  const phaseOne = 'seed evidence one\n';
  const phaseTwo = 'seed evidence two\n';
  const phaseContent = '# Phase 1\n\n### Task 1: First\n\nWork done.\n';
  writeFileSync(path.join(planDir, 'spec-doc.md'), specContent);
  writeFileSync(path.join(planDir, 'seed-one.md'), phaseOne);
  writeFileSync(path.join(planDir, 'seed-two.md'), phaseTwo);
  writeFileSync(path.join(planDir, 'execution-plan.md'), '# Execution Plan\n\n### Task 1: First\n\nBody.\n');
  writeFileSync(path.join(executionDir, 'index.md'), '# Plan Index\n\n**Source Plan:** ../execution-plan.md\n');
  writeFileSync(path.join(executionDir, 'phase-1.md'), phaseContent);

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Pocket Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Pocket Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args) => execFileSync('git', args, {
    cwd: planDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: gitEnv,
  });

  const originalClock = process.env.POCKETTO_LIFECYCLE_NOW;
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Pocket Test']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'plan snapshot']);
    git(['checkout', '-q', '-b', 'feature/issue-90']);

    const initialized = runCli(['log', 'init', planDir, '--json', '--contract', '3'], { cwd: planDir });
    assert.equal(JSON.parse(initialized.stdout.trim()).ok, true, `log init should succeed: ${initialized.stdout}`);
    const logPath = path.join(planDir, 'log.json');
    const initialProjection = JSON.parse(readFileSync(logPath, 'utf8'));
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

    const progressedProjection = JSON.parse(readFileSync(logPath, 'utf8'));
    const progressedPhase = progressedProjection.phases[0];
    progressedPhase.tasks[0].status = 'DONE';
    progressedPhase.tasks[0].done_sha = doneSha;
    progressedPhase.corrections = [{ sha: correctionSha, files: ['correction-output.md'], for_task: 'T1' }];
    writeFileSync(logPath, `${JSON.stringify(progressedProjection, null, 2)}\n`);

    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const seed = (input) => {
      const result = commitTransition({ ...input, deps: { now: () => FIXED_CLOCK } });
      assert.equal(result.ok, true, `lifecycle seed should succeed: ${JSON.stringify(result)}`);
      return result;
    };
    seed({
      specDir: planDir,
      planDir: null,
      planId: 'plan-90',
      type: 'spec-approved',
      artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(specContent), revision: 1 }],
    });
    seed({
      specDir: planDir,
      planDir,
      planId: 'plan-90',
      type: 'phase-complete',
      artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'seed-one.md', sha256: sha256Hex(phaseOne), revision: 1 }],
    });
    seed({
      specDir: planDir,
      planDir,
      planId: 'plan-90',
      type: 'phase-complete',
      artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'seed-two.md', sha256: sha256Hex(phaseTwo), revision: 1 }],
    });

    process.env.POCKETTO_LIFECYCLE_NOW = FIXED_CLOCK;
    const logCmd = require('../cli/commands/log');
    const failingProjectionWriter = () => {
      throw new Error('injected projection writer failure');
    };
    let projectionError = null;
    try {
      logCmd.run({
        sub: 'update',
        positionals: [planDir, phaseFile, 'REVIEW'],
        projectionWriter: failingProjectionWriter,
      });
    } catch (err) {
      projectionError = err;
    }
    assert.ok(projectionError, 'projection writer failure should be injected');
    assert.equal(projectionError.code, 'PROJECTION_REPAIR_REQUIRED');

    const lifecyclePath = lifecyclePathFor(planDir);
    const before = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(before.plan.revision, 4);
    assert.equal(before.events.length, 4);
    assert.equal(before.events[3].event_id, 'plan-90:phase-complete:r4');
    assert.equal(before.events[3].delivery.status, 'pending');
    const staleProjectionBytes = readFileSync(logPath, 'utf8');
    const staleProjection = JSON.parse(staleProjectionBytes);
    assert.equal(staleProjection.phases[0].status, 'WAITING');
    assert.deepEqual(staleProjection.phases[0].tasks[0], progressedPhase.tasks[0]);
    assert.deepEqual(staleProjection.phases[0].corrections, progressedPhase.corrections);
    assert.equal(staleProjection.header.baseline_sha, originalBaselineSha);

    const repaired = runCli(
      ['lifecycle', 'repair', planDir, '--json', '--contract', '3'],
      { cwd: planDir, env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK } },
    );
    const envelope = JSON.parse(repaired.stdout.trim());
    assert.equal(envelope.ok, true, `public lifecycle repair should succeed: ${JSON.stringify(envelope)}${repaired.stderr}`);
    assert.equal(repaired.code, 0);
    assert.equal(envelope.command, 'lifecycle repair');
    assert.equal(envelope.contract, 3);

    const rebuiltProjection = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.equal(rebuiltProjection.phases[0].status, 'REVIEW');
    assert.deepEqual(rebuiltProjection.phases[0].tasks, staleProjection.phases[0].tasks, 'repair must preserve task statuses and done_sha');
    assert.deepEqual(rebuiltProjection.phases[0].corrections, staleProjection.phases[0].corrections, 'repair must preserve correction records');
    assert.equal(rebuiltProjection.header.baseline_sha, originalBaselineSha, 'repair must preserve the original baseline');
    const after = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(after.plan.revision, before.plan.revision, 'repair must not change lifecycle revision');
    assert.equal(after.events.length, before.events.length, 'repair must not append an event');
    assert.deepEqual(after.events, before.events, 'repair must not dispatch or mutate lifecycle events');
  } finally {
    if (originalClock === undefined) delete process.env.POCKETTO_LIFECYCLE_NOW;
    else process.env.POCKETTO_LIFECYCLE_NOW = originalClock;
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle repair fails closed when damaged projection progress is not recoverable', () => {
  // Given progressed task state in a structurally damaged log.json that the
  // lifecycle journal cannot reproduce, When repair runs, Then it returns an
  // actionable error, preserves both files, and never dispatches an adapter.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-repair-fail-closed-'));
  const projectDir = path.join(root, 'project');
  const planDir = path.join(projectDir, 'plans', 'plan-91');
  const phasePath = path.join(planDir, 'execution-plan-phase-1.md');
  const logPath = path.join(planDir, 'log.json');
  const lifecyclePath = path.join(planDir, 'lifecycle.json');
  const pocketDir = path.join(projectDir, '.pocket');
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  mkdirSync(planDir, { recursive: true });
  mkdirSync(pocketDir, { recursive: true });

  const specContent = 'approved spec for fail-closed repair\n';
  const phaseContent = '# Phase 1\n\n### Task 1: Completed work\n\n### Task 2: Later work\n';
  writeFileSync(path.join(planDir, 'spec-doc.md'), specContent);
  writeFileSync(phasePath, phaseContent);

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Pocket Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Pocket Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args) => execFileSync('git', args, {
    cwd: planDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: gitEnv,
  });

  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Pocket Test']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'initial plan snapshot']);
    const baselineSha = git(['rev-parse', 'HEAD']).trim();

    const initialized = runCli(['log', 'init', planDir, '--json', '--contract', '3'], { cwd: planDir });
    assert.equal(JSON.parse(initialized.stdout.trim()).ok, true, `log init should succeed: ${initialized.stdout}`);
    writeFileSync(path.join(planDir, 'task-output.txt'), 'completed task output\n');
    git(['add', 'task-output.txt']);
    git(['commit', '-q', '-m', 'complete task one']);
    const doneSha = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(planDir, 'correction-output.txt'), 'follow-up correction\n');
    git(['add', 'correction-output.txt']);
    git(['commit', '-q', '-m', 'record correction']);
    const correctionSha = git(['rev-parse', 'HEAD']).trim();

    const progressed = JSON.parse(readFileSync(logPath, 'utf8'));
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

    const { commitTransition } = require('../cli/lib/lifecycle-store');
    const seed = (input) => {
      const result = commitTransition({ ...input, deps: { now: () => FIXED_CLOCK } });
      assert.equal(result.ok, true, `lifecycle seed should succeed: ${JSON.stringify(result)}`);
      return result;
    };
    seed({
      specDir: planDir,
      planDir: null,
      planId: 'plan-91',
      type: 'spec-approved',
      artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(specContent), revision: 1 }],
    });
    seed({
      specDir: planDir,
      planDir,
      planId: 'plan-91',
      type: 'phase-complete',
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'execution-plan-phase-1.md', sha256: sha256Hex(phaseContent), revision: 1 }],
    });
    const lifecycleBefore = readFileSync(lifecyclePath, 'utf8');
    const lifecycleDoc = JSON.parse(lifecycleBefore);
    assert.equal(lifecycleDoc.plan.plan_dir, planDir, 'lifecycle seed must commit the plan root required by repair');
    assert.equal(lifecycleDoc.plan.revision, 2);
    assert.equal(lifecycleDoc.events.length, 2);
    const taskProjectionFields = new Set([
      'baseline_sha',
      'done_sha',
      'corrections',
      'tasks',
      'task_id',
      'task_status',
      'task_statuses',
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

    // Keep the plan path and original baseline metadata. Corrupt the task-state
    // collection shape while retaining T1 progress in the damaged bytes; the
    // legacy repair path treats the non-array phases value as rebuildable.
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
    writeFileSync(callsPath, '');
    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
const event = eventPath ? JSON.parse(fs.readFileSync(eventPath, 'utf8')) : {};
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved', 'phase-complete'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const result = runCli(
      ['lifecycle', 'repair', planDir, '--json', '--contract', '3'],
      { cwd: projectDir, env: { ADAPTER_CALLS: callsPath, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK } },
    );
    const envelope = JSON.parse(result.stdout.trim());
    if (envelope.ok) {
      const unsafeRebuild = JSON.parse(readFileSync(logPath, 'utf8'));
      const regeneratedTask = unsafeRebuild.phases[0].tasks.find((task) => task.id === 'T1');
      assert.equal(regeneratedTask.status, 'WAITING', 'unsafe fallback regenerates task progress as WAITING');
      assert.equal(regeneratedTask.done_sha, undefined, 'unsafe fallback drops the task done_sha');
      assert.equal(unsafeRebuild.phases[0].corrections, undefined, 'unsafe fallback drops phase corrections');
      assert.notEqual(unsafeRebuild.header.baseline_sha, baselineSha, 'unsafe fallback replaces the original baseline with current HEAD');
    }
    assert.equal(envelope.ok, false, `repair must refuse lossy reconstruction: ${JSON.stringify(envelope)}`);
    assert.equal(result.code, 1);
    assert.equal(envelope.error.code, 'LIFECYCLE_REPAIR_STATE_UNRECOVERABLE');
    assert.match(envelope.error.message, /(restore|backup).*(log\.json|projection)|(log\.json|projection).*(restore|backup)/i);
    assert.equal(readFileSync(logPath, 'utf8'), damagedBytes, 'repair must preserve the damaged projection bytes');
    assert.equal(readFileSync(lifecyclePath, 'utf8'), lifecycleBefore, 'repair must preserve the lifecycle journal bytes');
    const lifecycleAfter = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(lifecycleAfter.plan.revision, lifecycleDoc.plan.revision);
    assert.equal(lifecycleAfter.events.length, lifecycleDoc.events.length);
    assert.equal(readFileSync(callsPath, 'utf8'), '', 'repair must not dispatch lifecycle events');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent lifecycle drains allow only one UUID-owned event claim', async () => {
  // Given two workers receive the same pending event,
  // When both attempt processing,
  // Then only one UUID-owned claim succeeds and only one adapter invocation is possible.
  // Exercise public drain workers concurrently; use a real .lifecycle.lock and ledger.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-claim-'));
  const projectDir = path.join(root, 'project');
  const specDir = path.join(projectDir, 'spec', 'demo-plan');
  const pocketDir = path.join(projectDir, '.pocket');
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  const releasePath = path.join(root, 'release-adapter');
  const lockPath = path.join(specDir, '.lifecycle.lock');
  const workers = [];
  let results = [];
  let callsDuringClaim = [];
  let callsAfterRelease = [];
  let lockOwner = null;
  let deliveryDuringClaim = null;
  let after = null;
  let adapterStarted = false;

  try {
    mkdirSync(specDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });
    const specContent = 'approved spec for claim test\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    writeFileSync(callsPath, '');

    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const seeded = commitTransition({
      specDir,
      planDir: null,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec.md',
        sha256: sha256Hex(specContent),
        revision: 1,
      }],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(seeded.ok, true, `pending event seed should succeed: ${JSON.stringify(seeded)}`);

    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ worker_id: process.env.WORKER_ID, event_id: event.event_id }) + '\\n');
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 5000;
while (!fs.existsSync(process.env.ADAPTER_RELEASE) && Date.now() < deadline) Atomics.wait(waitBuffer, 0, 0, 10);
if (!fs.existsSync(process.env.ADAPTER_RELEASE)) process.exit(3);
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const startWorker = (workerId) => {
      const child = spawn('node', [
        CLI,
        'lifecycle',
        'drain',
        specDir,
        '--json',
        '--contract',
        '3',
      ], {
        cwd: projectDir,
        env: {
          ...process.env,
          POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK,
          ADAPTER_CALLS: callsPath,
          ADAPTER_RELEASE: releasePath,
          WORKER_ID: workerId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const spawned = new Promise((resolve) => {
        child.once('spawn', () => resolve(true));
        child.once('error', () => resolve(false));
      });
      const done = new Promise((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
        child.once('error', (err) => resolve({ code: -1, signal: null, stdout, stderr: `${stderr}${err.message}` }));
      });
      return { child, spawned, done };
    };

    const readCalls = () => {
      const content = readFileSync(callsPath, 'utf8').trim();
      return content ? content.split('\n').map((line) => JSON.parse(line)) : [];
    };
    const waitForFirstInvocation = async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (readCalls().length > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return readCalls().length > 0;
    };

    workers.push(startWorker('worker-a'));
    workers.push(startWorker('worker-b'));
    const spawned = await Promise.all(workers.map((worker) => worker.spawned));
    assert.ok(spawned.every(Boolean), 'both drain workers should start');
    adapterStarted = await waitForFirstInvocation();
    if (adapterStarted) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      callsDuringClaim = readCalls();
      if (existsSync(lockPath)) {
        try {
          lockOwner = JSON.parse(readFileSync(lockPath, 'utf8'));
        } catch {
          lockOwner = null;
        }
      }
      const during = JSON.parse(readFileSync(lifecyclePathFor(specDir), 'utf8'));
      deliveryDuringClaim = during.events[0].delivery;
    }

    writeFileSync(releasePath, 'release');
    results = await Promise.all(workers.map((worker) => worker.done));
    callsAfterRelease = readCalls();
    after = JSON.parse(readFileSync(lifecyclePathFor(specDir), 'utf8'));
  } finally {
    try {
      writeFileSync(releasePath, 'release');
    } catch {}
    await Promise.all(workers.map((worker) => worker.done));
    rmSync(root, { recursive: true, force: true });
  }

  assert.ok(adapterStarted, 'the claimed event should reach the fake adapter');
  assert.ok(lockOwner, 'the per-plan .lifecycle.lock must contain an owner record during invocation');
  assert.equal(lockOwner.event_id, 'demo-plan:spec-approved:r1');
  assert.match(lockOwner.owner_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(deliveryDuringClaim.status, 'claimed', 'the ledger must record the event claim before invocation');
  assert.equal(deliveryDuringClaim.attempts, 1, 'the first claim must increment attempts before invocation');
  assert.equal(callsDuringClaim.length, 1, 'only one worker may invoke the adapter for the event');
  assert.equal(callsAfterRelease.length, 1, 'the competing worker must not invoke after the first completes');
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.code, 0, `drain worker should exit cleanly: ${result.stdout}${result.stderr}`);
    assert.equal(JSON.parse(result.stdout.trim()).ok, true);
  }
  assert.equal(after.plan.revision, 1, 'claiming and delivering must not create a lifecycle event');
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].event_id, 'demo-plan:spec-approved:r1');
  assert.equal(after.events[0].delivery.status, 'succeeded');
  assert.equal(after.events[0].delivery.attempts, 1);
});

test('lifecycle drain reclaims an expired 60-second claim without overlapping invocation', () => {
  // Given a claimed event with an expired 60-second lease,
  // When a later worker drains,
  // Then it may reclaim the event, records the new owner, and does not overlap
  // the expired worker's invocation. Use a fixed clock and real claim/ledger files.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-expired-claim-'));
  try {
    const projectDir = path.join(root, 'project');
    const specDir = path.join(projectDir, 'spec', 'demo-plan');
    const pocketDir = path.join(projectDir, '.pocket');
    mkdirSync(specDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });

    const specContent = 'approved spec for expired claim test\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    const { commitTransition, lifecyclePathFor, updateEventDelivery } = require('../cli/lib/lifecycle-store');
    const seeded = commitTransition({
      specDir,
      planDir: null,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec.md',
        sha256: sha256Hex(specContent),
        revision: 1,
      }],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(seeded.ok, true, `pending event seed should succeed: ${JSON.stringify(seeded)}`);
    const eventId = seeded.event.event_id;
    const claimed = updateEventDelivery(specDir, eventId, { status: 'claimed', attempts: 1 });
    assert.equal(claimed.ok, true, `claimed event fixture should persist: ${JSON.stringify(claimed)}`);

    const oldOwnerId = '00000000-0000-4000-8000-000000000001';
    const oldOwnerPid = 2147483647;
    const lockPath = path.join(specDir, '.lifecycle.lock');
    const expiredClaim = {
      plan_id: 'demo-plan',
      event_id: eventId,
      owner_id: oldOwnerId,
      owner_pid: oldOwnerPid,
      claimed_at: '2026-09-19T11:58:59.000Z',
      lease_expires_at: '2026-09-19T11:59:59.000Z',
    };
    assert.equal(
      Date.parse(expiredClaim.lease_expires_at) - Date.parse(expiredClaim.claimed_at),
      60_000,
      'fixture lease must be exactly 60 seconds',
    );
    assert.ok(Date.parse(expiredClaim.lease_expires_at) < Date.parse(FIXED_CLOCK), 'fixture lease must be expired');
    writeFileSync(lockPath, `${JSON.stringify(expiredClaim)}\n`);

    const callsPath = path.join(root, 'adapter-calls.jsonl');
    const activePath = path.join(root, 'active-invocations.txt');
    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(callsPath, '');
    writeFileSync(activePath, '0');
    writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(process.env.LIFECYCLE_LOCK, 'utf8'));
const active = Number(fs.readFileSync(process.env.ACTIVE_INVOCATIONS, 'utf8')) + 1;
fs.writeFileSync(process.env.ACTIVE_INVOCATIONS, String(active));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({
  event_id: event.event_id,
  owner_id: lock.owner_id,
  overlapping: active > 1,
}) + '\\n');
fs.writeFileSync(process.env.ACTIVE_INVOCATIONS, String(active - 1));
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const result = runCli(
      ['lifecycle', 'drain', specDir, '--json', '--contract', '3'],
      {
        cwd: projectDir,
        env: {
          POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK,
          ADAPTER_CALLS: callsPath,
          ACTIVE_INVOCATIONS: activePath,
          LIFECYCLE_LOCK: lockPath,
        },
      },
    );
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.ok, true, `later lifecycle drain should complete: ${JSON.stringify(envelope)}${result.stderr}`);
    assert.equal(result.code, 0);

    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, 1, 'later worker should reclaim the expired event and invoke the adapter once');
    assert.equal(calls[0].event_id, eventId);
    assert.notEqual(calls[0].owner_id, oldOwnerId, 'reclaim must persist a new UUID owner before invocation');
    assert.match(calls[0].owner_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    assert.equal(calls[0].overlapping, false, 'reclaimed invocation must not overlap another adapter invocation');
    assert.equal(readFileSync(activePath, 'utf8'), '0');

    const after = JSON.parse(readFileSync(lifecyclePathFor(specDir), 'utf8'));
    assert.equal(after.plan.revision, 1);
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].event_id, eventId);
    assert.equal(after.events[0].delivery.status, 'succeeded');
    assert.equal(after.events[0].delivery.attempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle drain reclaims a dead guard owner but never steals from a live owner', () => {
  // Given a real per-plan guard written by an exited owner and another guard
  // owned by this live process, When drain runs, Then only the dead owner's
  // guard is reclaimed and each pending event can be invoked at most once.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-stale-guard-'));
  const projectDir = path.join(root, 'project');
  const specRoot = path.join(projectDir, 'spec');
  const pocketDir = path.join(projectDir, '.pocket');
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  mkdirSync(specRoot, { recursive: true });
  mkdirSync(pocketDir, { recursive: true });
  writeFileSync(callsPath, '');

  const adapterPath = path.join(root, 'fake-adapter');
  writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
  chmodSync(adapterPath, 0o755);
  writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
    schema: 1,
    adapter_contract: 1,
    argv: [adapterPath],
    events: ['spec-approved'],
    timeout_ms: 30000,
  }, null, 2)}\n`);

  const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
  const makePendingPlan = (planId) => {
    const specDir = path.join(specRoot, planId);
    mkdirSync(specDir, { recursive: true });
    const content = `approved spec for ${planId}\n`;
    writeFileSync(path.join(specDir, 'spec.md'), content);
    const seeded = commitTransition({
      specDir,
      planDir: null,
      planId,
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec.md',
        sha256: sha256Hex(content),
        revision: 1,
      }],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(seeded.ok, true, `pending event should seed: ${JSON.stringify(seeded)}`);
    return { specDir, eventId: seeded.event.event_id, lifecyclePath: lifecyclePathFor(specDir) };
  };
  const drain = (fixture) => runCli(
    ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
    {
      cwd: projectDir,
      env: { ADAPTER_CALLS: callsPath, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK },
    },
  );
  const readCalls = () => readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  try {
    const deadOwnerPlan = makePendingPlan('dead-guard-plan');
    const deadGuardPath = path.join(deadOwnerPlan.specDir, '.lifecycle.lock.guard');
    const deadOwnerId = '00000000-0000-4000-8000-000000000091';
    const deadOwnerPid = Number(execFileSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fd = fs.openSync(process.env.GUARD_PATH, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ owner_id: process.env.GUARD_OWNER_ID, owner_pid: process.pid }) + '\\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      process.stdout.write(String(process.pid));
    `], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, GUARD_PATH: deadGuardPath, GUARD_OWNER_ID: deadOwnerId },
    }).trim());
    assert.ok(Number.isInteger(deadOwnerPid) && deadOwnerPid > 0, 'guard fixture must record its creator PID');
    let deadOwnerAlive = true;
    try {
      process.kill(deadOwnerPid, 0);
    } catch (err) {
      if (err && err.code === 'ESRCH') deadOwnerAlive = false;
      else throw err;
    }
    assert.equal(deadOwnerAlive, false, 'dead-guard fixture owner must have exited before drain');

    const deadDrain = drain(deadOwnerPlan);
    const deadEnvelope = JSON.parse(deadDrain.stdout.trim());
    assert.equal(deadEnvelope.ok, true, `drain should reclaim a dead guard: ${JSON.stringify(deadEnvelope)}${deadDrain.stderr}`);
    assert.equal(deadDrain.code, 0);
    assert.deepEqual(readCalls(), [{ event_id: deadOwnerPlan.eventId }], 'the reclaimed event must invoke the adapter exactly once');
    assert.equal(
      existsSync(path.join(deadOwnerPlan.specDir, '.lifecycle.lock')),
      false,
      'successful delivery must release the per-plan event lease',
    );
    const deadLedger = JSON.parse(readFileSync(deadOwnerPlan.lifecyclePath, 'utf8'));
    assert.equal(deadLedger.events[0].delivery.status, 'succeeded');
    assert.equal(deadLedger.events[0].delivery.attempts, 1, 'guard recovery must preserve one initial attempt');

    const repeatDeadDrain = drain(deadOwnerPlan);
    assert.equal(JSON.parse(repeatDeadDrain.stdout.trim()).ok, true);
    assert.equal(readCalls().length, 1, 'a completed event must not be invoked again');

    const liveOwnerPlan = makePendingPlan('live-guard-plan');
    const liveGuardPath = path.join(liveOwnerPlan.specDir, '.lifecycle.lock.guard');
    const liveGuardBytes = `${JSON.stringify({
      owner_id: '00000000-0000-4000-8000-000000000092',
      owner_pid: process.pid,
    })}\n`;
    writeFileSync(liveGuardPath, liveGuardBytes, { flag: 'wx', mode: 0o600 });

    const liveDrain = drain(liveOwnerPlan);
    const liveEnvelope = JSON.parse(liveDrain.stdout.trim());
    assert.equal(liveEnvelope.ok, true, `drain should defer to a live guard owner: ${JSON.stringify(liveEnvelope)}${liveDrain.stderr}`);
    assert.equal(liveDrain.code, 0);
    assert.equal(readFileSync(liveGuardPath, 'utf8'), liveGuardBytes, "a live owner's guard must not be replaced or removed");
    const liveLedger = JSON.parse(readFileSync(liveOwnerPlan.lifecyclePath, 'utf8'));
    assert.equal(liveLedger.events[0].delivery.status, 'pending');
    assert.equal(liveLedger.events[0].delivery.attempts, 0, 'a live guard must block claim attempts');
    assert.deepEqual(readCalls(), [{ event_id: deadOwnerPlan.eventId }], 'the live guard must not permit a second adapter invocation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core classifies adapter protocol failures with bounded retry scheduling and no GitHub calls', () => {
  // Given missing registration, wrong adapter contract, timeout, non-zero exit,
  // malformed response, or rate-limit failure, When Core drains committed events,
  // Then it records retryable protocol errors with original IDs and bounded attempts.
  // Timeout/rate-limit retries use 1s, 5s, 30s, 120s, and 600s before terminal state.
  // All remote command calls are trapped by a recording fake `gh`; no network is used.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-adapter-protocol-'));
  try {
    const binDir = path.join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const ghCallsPath = path.join(root, 'gh-calls.txt');
    const ghPath = path.join(binDir, 'gh');
    writeFileSync(ghCallsPath, '');
    writeFileSync(ghPath, `#!/usr/bin/env node
'use strict';
require('node:fs').appendFileSync(process.env.GH_CALLS, 'called\\n');
process.exit(91);
`);
    chmodSync(ghPath, 0o755);

    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const mode = process.env.ADAPTER_MODE;
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id, mode }) + '\\n');
if (mode === 'timeout') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
} else if (mode === 'non-zero') {
  process.stderr.write('injected adapter exit\\n');
  process.exit(7);
} else if (mode === 'malformed') {
  process.stdout.write('{malformed response\\n');
} else if (mode === 'rate-limit') {
  process.stdout.write(JSON.stringify({
    event_id: event.event_id,
    status: 'retryable',
    error: { code: 'RATE_LIMIT', retryable: true, message: 'injected rate limit' },
  }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
}
`);
    chmodSync(adapterPath, 0o755);

    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const createPlan = (slug) => {
      const projectDir = path.join(root, slug);
      const specDir = path.join(projectDir, 'spec', slug);
      const pocketDir = path.join(projectDir, '.pocket');
      mkdirSync(specDir, { recursive: true });
      mkdirSync(pocketDir, { recursive: true });
      const specContent = `approved spec for ${slug}\n`;
      writeFileSync(path.join(specDir, 'spec.md'), specContent);
      const seeded = commitTransition({
        specDir,
        planDir: null,
        planId: slug,
        type: 'spec-approved',
        artifacts: [{
          root: 'spec',
          kind: 'spec-doc',
          path: 'spec.md',
          sha256: sha256Hex(specContent),
          revision: 1,
        }],
        deps: { now: () => FIXED_CLOCK },
      });
      assert.equal(seeded.ok, true, `event seed should succeed: ${JSON.stringify(seeded)}`);
      const callsPath = path.join(projectDir, 'adapter-calls.jsonl');
      writeFileSync(callsPath, '');
      return { projectDir, specDir, pocketDir, callsPath, lifecyclePath: lifecyclePathFor(specDir), eventId: seeded.event.event_id };
    };
    const registerAdapter = (fixture, { adapterContract = 1, timeoutMs = 1000 } = {}) => {
      writeFileSync(path.join(fixture.pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
        schema: 1,
        adapter_contract: adapterContract,
        argv: [adapterPath],
        events: ['spec-approved'],
        timeout_ms: timeoutMs,
      }, null, 2)}\n`);
    };
    const runDrain = (fixture, { mode = 'success', now = FIXED_CLOCK } = {}) => runCli(
      ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
      {
        cwd: fixture.projectDir,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
          GH_CALLS: ghCallsPath,
          ADAPTER_CALLS: fixture.callsPath,
          ADAPTER_MODE: mode,
          POCKETTO_LIFECYCLE_NOW: now,
        },
      },
    );
    const readCalls = (fixture) => readFileSync(fixture.callsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const assertRetryableFailure = (fixture, label) => {
      const doc = JSON.parse(readFileSync(fixture.lifecyclePath, 'utf8'));
      assert.equal(doc.plan.revision, 1, `${label} must not create lifecycle events`);
      assert.equal(doc.events.length, 1, `${label} must preserve the journal length`);
      assert.equal(doc.events[0].event_id, fixture.eventId, `${label} must preserve the original event ID`);
      assert.equal(doc.events[0].delivery.status, 'retryable', `${label} must be classified as retryable`);
      assert.equal(doc.events[0].delivery.attempts, 1, `${label} must record one bounded attempt`);
      assert.ok(doc.events[0].delivery.error, `${label} must record a protocol error`);
      assert.equal(doc.events[0].delivery.error.retryable, true, `${label} error must be marked retryable`);
      assert.equal(doc.events[0].delivery.error.attempts, 1, `${label} error must carry the bounded attempt count`);
      return doc.events[0].delivery;
    };

    const scenarios = [
      { label: 'missing-registration', mode: 'success', registration: null },
      { label: 'wrong-adapter-contract', mode: 'success', registration: { adapterContract: 2 } },
      { label: 'timeout', mode: 'timeout', registration: { timeoutMs: 150 } },
      { label: 'non-zero-exit', mode: 'non-zero', registration: {} },
      { label: 'malformed-response', mode: 'malformed', registration: {} },
    ];
    for (const scenario of scenarios) {
      const fixture = createPlan(`plan-${scenario.label}`);
      if (scenario.registration) registerAdapter(fixture, scenario.registration);
      runDrain(fixture, { mode: scenario.mode });
      assertRetryableFailure(fixture, scenario.label);
    }

    const retryFixture = createPlan('plan-rate-limit-retry');
    registerAdapter(retryFixture, { timeoutMs: 1000 });
    const baseMs = Date.parse(FIXED_CLOCK);
    const isoAt = (milliseconds) => new Date(milliseconds).toISOString();
    const retryDelays = [1_000, 5_000, 30_000, 120_000, 600_000];
    runDrain(retryFixture, { mode: 'rate-limit', now: FIXED_CLOCK });

    let event = JSON.parse(readFileSync(retryFixture.lifecyclePath, 'utf8')).events[0];
    assert.equal(event.delivery.status, 'retryable');
    assert.equal(event.delivery.attempts, 1);
    assert.equal(event.delivery.next_attempt_at, isoAt(baseMs + retryDelays[0]));

    let previousAttemptCount = 1;
    let scheduledAt = baseMs;
    for (let index = 0; index < retryDelays.length; index += 1) {
      const retryAt = scheduledAt + retryDelays[index];
      runDrain(retryFixture, { mode: 'rate-limit', now: isoAt(retryAt - 1) });
      event = JSON.parse(readFileSync(retryFixture.lifecyclePath, 'utf8')).events[0];
      assert.equal(event.delivery.attempts, previousAttemptCount, 'drain must not retry before its scheduled delay');
      assert.equal(readCalls(retryFixture).length, previousAttemptCount, 'no adapter invocation may occur before the delay');

      runDrain(retryFixture, { mode: 'rate-limit', now: isoAt(retryAt) });
      previousAttemptCount += 1;
      scheduledAt = retryAt;
      event = JSON.parse(readFileSync(retryFixture.lifecyclePath, 'utf8')).events[0];
      assert.equal(event.delivery.attempts, previousAttemptCount);
      assert.equal(readCalls(retryFixture).length, previousAttemptCount);
      if (previousAttemptCount < 6) {
        assert.equal(event.delivery.status, 'retryable');
        assert.equal(event.delivery.next_attempt_at, isoAt(retryAt + retryDelays[index + 1]));
      } else {
        assert.equal(event.delivery.status, 'terminal', 'event must become terminal after five retries');
        assert.equal(event.delivery.error.retryable, false);
      }
    }

    assert.equal(readFileSync(ghCallsPath, 'utf8'), '', 'Core must perform zero GitHub calls');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent lifecycle transition and delivery mutations preserve both updates', async () => {
  // Given an existing event, When a delivery save pauses after reading while a
  // new transition overlaps, Then both the new revision and delivery result persist.
  // Child processes exercise the real store and atomic-file writer; file markers
  // make the read-modify-write overlap deterministic without replacing persistence.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-mutation-race-'));
  const specDir = path.join(root, 'spec');
  const planDir = path.join(root, 'plan');
  const lifecyclePath = path.join(specDir, 'lifecycle.json');
  const workers = [];
  const releaseDeliveryPath = path.join(root, 'release-delivery');
  const deliveryReadPath = path.join(root, 'delivery-read');
  const transitionReadPath = path.join(root, 'transition-read');
  const transitionStartedPath = path.join(root, 'transition-started');

  const workerScript = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const options = JSON.parse(process.env.LIFECYCLE_MUTATION_OPTIONS);
const originalReadFileSync = fs.readFileSync;
let paused = false;
fs.readFileSync = function(file, ...args) {
  const content = originalReadFileSync.call(this, file, ...args);
  if (path.resolve(String(file)) === options.lifecyclePath) {
    if (options.readMarker) fs.writeFileSync(options.readMarker, 'read');
    if (options.pauseAfterRead && !paused) {
      paused = true;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(options.releasePath)) Atomics.wait(wait, 0, 0, 10);
    }
  }
  return content;
};
const { commitTransition, updateEventDelivery } = require('./cli/lib/lifecycle-store');
let result;
if (options.operation === 'delivery') {
  result = updateEventDelivery(options.specDir, options.eventId, { status: 'succeeded', attempts: 1 });
} else {
  fs.writeFileSync(options.startedPath, 'started');
  result = commitTransition({
    specDir: options.specDir,
    planDir: options.planDir,
    planId: 'demo-plan',
    type: 'phase-complete',
    artifacts: [{
      root: 'plan',
      kind: 'phase-evidence',
      path: 'phase.md',
      sha256: options.phaseSha,
      revision: 1,
    }],
    deps: { now: () => options.clock },
  });
}
if (!result || !result.ok) throw new Error('lifecycle mutation failed: ' + JSON.stringify(result));
`;

  const startWorker = (options) => {
    const child = spawn(process.execPath, ['-e', workerScript], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, LIFECYCLE_MUTATION_OPTIONS: JSON.stringify(options) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      child.once('error', (err) => resolve({ code: -1, signal: null, stdout, stderr: err.message }));
    });
    return { child, done };
  };
  const waitForFile = async (file, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(file)) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return existsSync(file);
  };

  try {
    mkdirSync(specDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    const specContent = 'approved spec for mutation race\n';
    const phaseContent = 'phase evidence for mutation race\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    writeFileSync(path.join(planDir, 'phase.md'), phaseContent);
    const { commitTransition } = require('../cli/lib/lifecycle-store');
    const seeded = commitTransition({
      specDir,
      planDir: null,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec.md',
        sha256: sha256Hex(specContent),
        revision: 1,
      }],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(seeded.ok, true, `initial event should succeed: ${JSON.stringify(seeded)}`);

    workers.push(startWorker({
      operation: 'delivery',
      specDir,
      lifecyclePath,
      eventId: seeded.event.event_id,
      pauseAfterRead: true,
      readMarker: deliveryReadPath,
      releasePath: releaseDeliveryPath,
    }));
    assert.equal(await waitForFile(deliveryReadPath, 5000), true, 'delivery worker must pause after reading lifecycle.json');

    workers.push(startWorker({
      operation: 'transition',
      specDir,
      planDir,
      lifecyclePath,
      phaseSha: sha256Hex(phaseContent),
      clock: FIXED_CLOCK,
      startedPath: transitionStartedPath,
      readMarker: transitionReadPath,
      pauseAfterRead: false,
    }));
    assert.equal(await waitForFile(transitionStartedPath, 5000), true, 'transition worker must start');

    // Without shared serialization, the transition reads the old document and
    // completes while delivery is paused; releasing delivery then overwrites it.
    // With serialization, it cannot read until delivery commits, so release the
    // first mutation after allowing enough time to observe the competing read.
    if (await waitForFile(transitionReadPath, 1500)) {
      const transitionResult = await workers[1].done;
      assert.equal(transitionResult.code, 0, `transition worker should succeed: ${transitionResult.stderr}`);
    }
    writeFileSync(releaseDeliveryPath, 'release');
    const workerResults = await Promise.all(workers.map((worker) => worker.done));
    for (const result of workerResults) {
      assert.equal(result.code, 0, `lifecycle mutation worker should succeed: ${result.stderr}`);
    }

    const after = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(after.plan.revision, 2, 'the concurrent transition must persist its new revision');
    assert.deepEqual(after.events.map((event) => event.event_id), [
      'demo-plan:spec-approved:r1',
      'demo-plan:phase-complete:r2',
    ], 'the concurrent transition must preserve both journal events');
    assert.equal(after.events[0].delivery.status, 'succeeded', 'the delivery result must survive the transition write');
    assert.equal(after.events[0].delivery.attempts, 1);
    assert.equal(after.events[1].delivery.status, 'pending');
  } finally {
    try { writeFileSync(releaseDeliveryPath, 'release'); } catch {}
    await Promise.all(workers.map((worker) => worker.done));
    rmSync(root, { recursive: true, force: true });
  }
});
