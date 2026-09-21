'use strict';

// T3 lifecycle CLI integration tests (child-process CLI + real temp layout).
// Cycle 1: CLI transition emits a valid spec-approved event.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');

function run(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
    assert.ok(!expectFail, `expected failure but succeeded: ${args.join(' ')}`);
    return { stdout, code: 0 };
  } catch (err) {
    assert.ok(expectFail, `command failed unexpectedly: ${args.join(' ')}\n${err.stdout || ''}${err.stderr || ''}`);
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status };
  }
}

function json(args, opts) {
  return JSON.parse(run(args, opts).stdout.trim());
}

function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

test('CYCLE 1: CLI transition emits a valid spec-approved event', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-cli-'));
  const specDir = path.join(root, 'demo-plan');
  mkdirSync(specDir, { recursive: true });
  const content = 'approved spec content\n';
  writeFileSync(path.join(specDir, 'spec-doc.md'), content);
  const sha = sha256Hex(content);

  const env = json([
    'lifecycle', 'transition', specDir, 'spec-approved',
    '--artifact', `spec:spec-doc:spec-doc.md:${sha}`,
    '--json', '--contract', '3',
  ]);
  assert.equal(env.ok, true);
  assert.equal(env.command, 'lifecycle transition');
  assert.equal(env.contract, 3);
  const d = env.data;
  assert.equal(d.event_id, 'demo-plan:spec-approved:r1');
  assert.equal(d.revision, 1);
  assert.equal(d.status, 'pending');
  assert.equal(d.plan_dir, null);

  const doc = JSON.parse(readFileSync(path.join(specDir, 'lifecycle.json'), 'utf8'));
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].event_id, 'demo-plan:spec-approved:r1');
  assert.equal(doc.events[0].revision, 1);
  assert.equal(doc.plan.plan_dir, null);
});

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FIXED_CLOCK = '2026-09-19T12:00:00.000Z';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Pocket Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Pocket Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-09-19T12:00:00+00:00',
  GIT_COMMITTER_DATE: '2026-09-19T12:00:00+00:00',
};

function gitIn(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ...GIT_ENV },
  });
}

test('CYCLE 2: phase REVIEW emits phase-complete with branch and plan-root evidence; REVIEW→DONE emits no duplicate', { skip: !hasGit() }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-phase-'));
  const planDir = path.join(root, 'plan-50');
  mkdirSync(planDir, { recursive: true });
  const execDir = path.join(planDir, 'execution-plan');
  mkdirSync(execDir, { recursive: true });
  writeFileSync(path.join(planDir, 'execution-plan.md'), '# Execution Plan\n\n### Task 1: First\n\nBody.\n\n### Task 2: Second\n\nBody.\n');
  writeFileSync(path.join(execDir, 'index.md'), '# Plan Index\n\n**Source Plan:** ../execution-plan.md\n');
  const phaseContent = '# Phase 1\n\n### Task 1: First\n\nWork done.\n\n### Task 2: Second\n\nWork done.\n';
  writeFileSync(path.join(execDir, 'phase-1.md'), phaseContent);
  const phaseSha = sha256Hex(phaseContent);
  const specContent = 'approved spec content\n';
  writeFileSync(path.join(planDir, 'spec-doc.md'), specContent);
  writeFileSync(path.join(planDir, 'seed-a.md'), 'seed evidence A\n');
  writeFileSync(path.join(planDir, 'seed-b.md'), 'seed evidence B\n');

  gitIn(planDir, ['init', '-q']);
  gitIn(planDir, ['config', 'user.email', 'test@example.com']);
  gitIn(planDir, ['config', 'user.name', 'Test']);
  gitIn(planDir, ['config', 'commit.gpgsign', 'false']);
  gitIn(planDir, ['add', '-A']);
  gitIn(planDir, ['commit', '-q', '-m', 'plan snapshot']);
  gitIn(planDir, ['checkout', '-q', '-b', 'feature/issue-50']);

  run(['log', 'init', planDir, '--json', '--contract', '3']);

  const log0 = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
  assert.equal(log0.phases.length, 1);
  const phaseFile = log0.phases[0].file;
  assert.equal(phaseFile, 'execution-plan/phase-1.md');

  // Seed revisions 1..3 through the real store with a deterministic clock.
  // No branch is captured yet — the `log update` emission must capture it.
  const { commitTransition } = require('../cli/lib/lifecycle-store');
  const seed = (input) => {
    const res = commitTransition({ ...input, deps: { now: () => FIXED_CLOCK } });
    assert.equal(res.ok, true, `seed commit should succeed: ${JSON.stringify(res)}`);
    return res;
  };
  seed({
    specDir: planDir, planDir: null, planId: 'plan-50', type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(specContent), revision: 1 }],
  });
  seed({
    specDir: planDir, planDir, planId: 'plan-50', type: 'phase-complete',
    artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'seed-a.md', sha256: sha256Hex('seed evidence A\n'), revision: 1 }],
  });
  seed({
    specDir: planDir, planDir, planId: 'plan-50', type: 'phase-complete',
    artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'seed-b.md', sha256: sha256Hex('seed evidence B\n'), revision: 1 }],
  });

  process.env.POCKETTO_LIFECYCLE_NOW = FIXED_CLOCK;
  try {
    const review = json(['log', 'update', planDir, phaseFile, 'REVIEW', '--json', '--contract', '3']);
    assert.equal(review.ok, true);
    const afterReview = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    assert.equal(afterReview.phases[0].status, 'REVIEW');

    const doc = JSON.parse(readFileSync(path.join(planDir, 'lifecycle.json'), 'utf8'));
    assert.equal(doc.events.length, 4);
    const fourth = doc.events[3];
    assert.equal(fourth.event_id, 'plan-50:phase-complete:r4');
    assert.equal(fourth.revision, 4);
    assert.equal(fourth.type, 'phase-complete');
    assert.equal(fourth.occurred_at, FIXED_CLOCK);
    assert.deepEqual(fourth.artifact_refs, [
      { root: 'plan', kind: 'phase-evidence', path: phaseFile, sha256: phaseSha, revision: 1 },
    ]);
    assert.equal(fourth.delivery.status, 'pending');
    assert.equal(doc.plan.branch, 'feature/issue-50');
    assert.equal(doc.plan.plan_dir, planDir);
    assert.equal(doc.plan.revision, 4);

    const done = json(['log', 'update', planDir, phaseFile, 'DONE', '--json', '--contract', '3']);
    assert.equal(done.ok, true);
    const afterDone = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    assert.equal(afterDone.phases[0].status, 'DONE');
    const doc2 = JSON.parse(readFileSync(path.join(planDir, 'lifecycle.json'), 'utf8'));
    assert.equal(doc2.events.length, 4, 'REVIEW→DONE must not emit a second phase-complete event');
    assert.equal(
      doc2.events.filter((e) => e.type === 'phase-complete' && e.artifact_refs.some((a) => a.path === phaseFile)).length,
      1,
    );
  } finally {
    delete process.env.POCKETTO_LIFECYCLE_NOW;
  }
});
