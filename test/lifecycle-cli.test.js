'use strict';

// T3 lifecycle CLI integration tests (child-process CLI + real temp layout).
// Cycle 1: CLI transition emits a valid spec-approved event.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, cpSync, rmSync } = require('node:fs');
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

test('CYCLE 3: log close commits one plan-closed event atomically with DONE; replay emits nothing', { skip: !hasGit() }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-close-'));
  const planDir = path.join(root, 'plan-60');
  mkdirSync(planDir, { recursive: true });
  const execDir = path.join(planDir, 'execution-plan');
  mkdirSync(execDir, { recursive: true });
  writeFileSync(path.join(planDir, 'execution-plan.md'), '# Execution Plan\n\n### Task 1: First\n\nBody.\n\n### Task 2: Second\n\nBody.\n');
  writeFileSync(path.join(execDir, 'index.md'), '# Plan Index\n\n**Source Plan:** ../execution-plan.md\n');
  const phase1 = '# Phase 1\n\n### Task 1: First\n\nWork done.\n';
  const phase2 = '# Phase 2\n\n### Task 2: Second\n\nWork done.\n';
  writeFileSync(path.join(execDir, 'phase-1.md'), phase1);
  writeFileSync(path.join(execDir, 'phase-2.md'), phase2);
  const phase1Sha = sha256Hex(phase1);
  const phase2Sha = sha256Hex(phase2);
  const specContent = 'approved spec content\n';
  writeFileSync(path.join(planDir, 'spec-doc.md'), specContent);

  gitIn(planDir, ['init', '-q']);
  gitIn(planDir, ['config', 'user.email', 'test@example.com']);
  gitIn(planDir, ['config', 'user.name', 'Test']);
  gitIn(planDir, ['config', 'commit.gpgsign', 'false']);
  gitIn(planDir, ['add', '-A']);
  gitIn(planDir, ['commit', '-q', '-m', 'plan snapshot']);
  gitIn(planDir, ['checkout', '-q', '-b', 'feature/issue-60']);

  run(['log', 'init', planDir, '--json', '--contract', '3']);

  const log0 = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
  assert.equal(log0.phases.length, 2);
  const files = log0.phases.map((p) => p.file);
  assert.deepEqual(files, ['execution-plan/phase-1.md', 'execution-plan/phase-2.md']);

  // Seed the authoritative document with a matching plan identity (real store,
  // deterministic clock only).
  const { commitTransition } = require('../cli/lib/lifecycle-store');
  const seeded = commitTransition({
    specDir: planDir, planDir: null, planId: 'plan-60', type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(specContent), revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(seeded.ok, true, `seed commit should succeed: ${JSON.stringify(seeded)}`);

  process.env.POCKETTO_LIFECYCLE_NOW = FIXED_CLOCK;
  try {
    // Every phase eligible for closure: REVIEW then DONE through the public CLI.
    for (const f of files) {
      const r = json(['log', 'update', planDir, f, 'REVIEW', '--json', '--contract', '3']);
      assert.equal(r.ok, true);
      const d = json(['log', 'update', planDir, f, 'DONE', '--json', '--contract', '3']);
      assert.equal(d.ok, true);
    }

    // One close operation commits the closure event AND the DONE projection.
    const closed = json(['log', 'close', planDir, '--json', '--contract', '3']);
    assert.equal(closed.ok, true);

    const afterClose = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    assert.equal(afterClose.header.status, 'DONE');
    assert.ok(afterClose.header.date_completed);

    const doc = JSON.parse(readFileSync(path.join(planDir, 'lifecycle.json'), 'utf8'));
    const closures = doc.events.filter((e) => e.type === 'plan-closed');
    assert.equal(closures.length, 1, 'close must record exactly one plan-closed event');
    const closure = closures[0];
    assert.equal(closure.event_id, `plan-60:plan-closed:r${closure.revision}`);
    assert.equal(closure.revision, doc.plan.revision);
    assert.equal(closure.occurred_at, FIXED_CLOCK);
    assert.deepEqual(closure.artifact_refs, [
      { root: 'plan', kind: 'phase-evidence', path: 'execution-plan/phase-1.md', sha256: phase1Sha, revision: 1 },
      { root: 'plan', kind: 'phase-evidence', path: 'execution-plan/phase-2.md', sha256: phase2Sha, revision: 1 },
    ]);
    assert.equal(closure.delivery.status, 'pending');
    assert.equal(doc.plan.state.status, 'DONE');
    assert.equal(doc.plan.branch, 'feature/issue-60');
    assert.equal(doc.plan.plan_dir, planDir);
    const eventCount = doc.events.length;

    // Replay: closing again emits nothing new.
    const replay = json(['log', 'close', planDir, '--json', '--contract', '3']);
    assert.equal(replay.ok, true);
    const doc2 = JSON.parse(readFileSync(path.join(planDir, 'lifecycle.json'), 'utf8'));
    assert.equal(doc2.events.length, eventCount, 'replay must not emit a second closure event');
    assert.equal(doc2.events.filter((e) => e.type === 'plan-closed').length, 1);
    assert.equal(doc2.plan.state.status, 'DONE');
    const afterReplay = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    assert.equal(afterReplay.header.status, 'DONE');
  } finally {
    delete process.env.POCKETTO_LIFECYCLE_NOW;
  }

  // v3 preservation: a plan without a lifecycle document closes exactly as before.
  const v3Dir = path.join(root, 'legacy-plan');
  mkdirSync(v3Dir, { recursive: true });
  writeFileSync(path.join(v3Dir, 'execution-plan.md'), '# Execution Plan\n\n### Task 1: Only\n\nBody.\n');
  run(['log', 'init', v3Dir, '--json', '--contract', '3']);
  const v3log = JSON.parse(readFileSync(path.join(v3Dir, 'log.json'), 'utf8'));
  run(['log', 'update', v3Dir, v3log.phases[0].file, 'REVIEW', '--json', '--contract', '3']);
  run(['log', 'update', v3Dir, v3log.phases[0].file, 'DONE', '--json', '--contract', '3']);
  const v3close = json(['log', 'close', v3Dir, '--json', '--contract', '3']);
  assert.equal(v3close.ok, true);
  assert.equal(existsSync(path.join(v3Dir, 'lifecycle.json')), false, 'v3 close must not create a lifecycle document');
  const v3after = JSON.parse(readFileSync(path.join(v3Dir, 'log.json'), 'utf8'));
  assert.equal(v3after.header.status, 'DONE');
});

test('CYCLE 4: Core CLI starts without Enterprise-only modules', () => {
  // Local fixture: Enterprise-only command modules staged OUT of the Core
  // role. Final module ownership follows the T5 manifest — this list is a
  // test-local statement of the Core surface, not a reclassification.
  const ENTERPRISE_ONLY = ['mode.js', 'meta.js', 'format.js'];
  const repoRoot = path.join(__dirname, '..');
  const roleDir = mkdtempSync(path.join(tmpdir(), 'core-role-'));
  const stagedCli = path.join(roleDir, 'cli');
  cpSync(path.join(repoRoot, 'cli'), stagedCli, { recursive: true });
  for (const name of ENTERPRISE_ONLY) {
    rmSync(path.join(stagedCli, 'commands', name));
  }
  assert.ok(!existsSync(path.join(stagedCli, 'commands', 'mode.js')));
  assert.ok(!existsSync(path.join(stagedCli, 'commands', 'meta.js')));
  assert.ok(!existsSync(path.join(stagedCli, 'commands', 'format.js')));

  // Module-load recorder: records every module load in the child without
  // stubbing anything; the staged CLI under test is unmodified.
  const recorderPath = path.join(roleDir, 'load-recorder.js');
  writeFileSync(recorderPath, `'use strict';
const Module = require('node:module');
const loads = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  loads.push(request);
  return origLoad.call(this, request, parent, isMain);
};
process.on('exit', () => {
  try { require('node:fs').writeFileSync(process.env.CORE_ROLE_LOADS, JSON.stringify(loads)); } catch {}
});
`);
  const loadsPath = path.join(roleDir, 'loads.json');
  writeFileSync(loadsPath, '[]');

  const stagedEntry = path.join(stagedCli, 'index.js');
  const runStaged = (args) => execFileSync('node', ['-r', recorderPath, stagedEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CORE_ROLE_LOADS: loadsPath },
  });

  // Core CLI starts successfully: --version needs no Enterprise module.
  const versionOut = runStaged(['--version']);
  assert.match(versionOut, /pocketto-pi/);

  // Neutral lifecycle dispatch needs no Enterprise policy or GitHub metadata.
  const specDir = path.join(roleDir, 'demo-plan');
  mkdirSync(specDir, { recursive: true });
  const content = 'approved spec content\n';
  writeFileSync(path.join(specDir, 'spec-doc.md'), content);
  const sha = sha256Hex(content);
  const envOut = runStaged([
    'lifecycle', 'transition', specDir, 'spec-approved',
    '--artifact', `spec:spec-doc:spec-doc.md:${sha}`,
    '--json', '--contract', '3',
  ]);
  const env = JSON.parse(envOut.trim());
  assert.equal(env.ok, true);
  assert.equal(env.command, 'lifecycle transition');
  assert.equal(env.data.event_id, 'demo-plan:spec-approved:r1');
  assert.ok(existsSync(path.join(specDir, 'lifecycle.json')));

  // Only the neutral command registry loaded; Enterprise policy / GitHub
  // metadata modules were never required.
  const loads = JSON.parse(readFileSync(loadsPath, 'utf8'));
  const required = (mod) => loads.some((r) => r === mod || r.endsWith(`/${mod}`) || r.endsWith(`\\${mod}`));
  for (const name of ENTERPRISE_ONLY) {
    assert.ok(!required(`commands/${name}`), `Enterprise-only module must not load: ${name}`);
    assert.ok(!required(name), `Enterprise-only module must not load: ${name}`);
  }
  assert.ok(!loads.some((r) => r.includes('enterprise')), 'Enterprise policy modules must not load');
  assert.ok(required('./commands/lifecycle') || required('lifecycle'), 'neutral lifecycle registry must load');
});

test('CYCLE 5: log update projection failure returns PROJECTION_REPAIR_REQUIRED with commit durable and dispatch deferred', { skip: !hasGit() }, () => {
  const logCmd = require('../cli/commands/log');
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-projection-'));
  const planDir = path.join(root, 'plan-70');
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
  gitIn(planDir, ['checkout', '-q', '-b', 'feature/issue-70']);

  run(['log', 'init', planDir, '--json', '--contract', '3']);

  const log0 = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
  const phaseFile = log0.phases[0].file;

  // Seed revisions 1..3 through the real store with a deterministic clock.
  const { commitTransition } = require('../cli/lib/lifecycle-store');
  const seed = (input) => {
    const res = commitTransition({ ...input, deps: { now: () => FIXED_CLOCK } });
    assert.equal(res.ok, true, `seed commit should succeed: ${JSON.stringify(res)}`);
    return res;
  };
  seed({
    specDir: planDir, planDir: null, planId: 'plan-70', type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(specContent), revision: 1 }],
  });
  seed({
    specDir: planDir, planDir, planId: 'plan-70', type: 'phase-complete',
    artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'seed-a.md', sha256: sha256Hex('seed evidence A\n'), revision: 1 }],
  });
  seed({
    specDir: planDir, planDir, planId: 'plan-70', type: 'phase-complete',
    artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'seed-b.md', sha256: sha256Hex('seed evidence B\n'), revision: 1 }],
  });

  // Doubles: fake ONLY the projection writer (fails) and the adapter runner
  // (records). Lifecycle persistence stays real.
  const adapterCalls = [];
  const adapterRunner = (invocation) => {
    adapterCalls.push(invocation);
    return { attempted: true, deferred: false, reason: 'fake-adapter-recorded' };
  };
  const failingProjection = () => {
    throw new Error('injected projection failure');
  };

  process.env.POCKETTO_LIFECYCLE_NOW = FIXED_CLOCK;
  try {
    let thrown = null;
    try {
      logCmd.run({
        sub: 'update',
        positionals: [planDir, phaseFile, 'REVIEW'],
        projectionWriter: failingProjection,
        adapterRunner,
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'projection failure must raise instead of reporting success');
    assert.equal(thrown.code, 'PROJECTION_REPAIR_REQUIRED');
    assert.deepEqual(thrown.details, {
      event_id: 'plan-70:phase-complete:r4',
      revision: 4,
      lifecycle_committed: true,
      dispatch_deferred: true,
    });
    assert.match(thrown.message, /plan-70:phase-complete:r4/);

    // Authoritative side durable: revision 4 committed and still pending.
    const doc = JSON.parse(readFileSync(path.join(planDir, 'lifecycle.json'), 'utf8'));
    assert.equal(doc.events.length, 4);
    const fourth = doc.events[3];
    assert.equal(fourth.event_id, 'plan-70:phase-complete:r4');
    assert.equal(fourth.revision, 4);
    assert.equal(fourth.type, 'phase-complete');
    assert.deepEqual(fourth.artifact_refs, [
      { root: 'plan', kind: 'phase-evidence', path: phaseFile, sha256: phaseSha, revision: 1 },
    ]);
    assert.equal(fourth.delivery.status, 'pending');
    assert.equal(doc.plan.revision, 4);
    assert.equal(doc.plan.branch, 'feature/issue-70');

    // Projection side untouched: log.json still shows the pre-update status.
    const projected = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    assert.equal(projected.phases[0].status, 'WAITING');

    // Dispatch deferred: the adapter runner never fired.
    assert.equal(adapterCalls.length, 0);

    // Repair rebuilds the projection without emitting a new event.
    const repaired = logCmd.run({ sub: 'update', positionals: [planDir, phaseFile, 'REVIEW'], adapterRunner });
    assert.equal(repaired.command, 'log update');
    const doc2 = JSON.parse(readFileSync(path.join(planDir, 'lifecycle.json'), 'utf8'));
    assert.equal(doc2.events.length, 4, 'repair must not emit a second event');
    const projected2 = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    assert.equal(projected2.phases[0].status, 'REVIEW');
    assert.equal(adapterCalls.length, 1, 'adapter runs only once the projection succeeds');
    assert.equal(adapterCalls[0].event.event_id, 'plan-70:phase-complete:r4');
  } finally {
    delete process.env.POCKETTO_LIFECYCLE_NOW;
  }
});

test('CYCLE 5: log close projection failure returns PROJECTION_REPAIR_REQUIRED with closure durable and dispatch deferred', { skip: !hasGit() }, () => {
  const logCmd = require('../cli/commands/log');
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-projection-close-'));
  const planDir = path.join(root, 'plan-71');
  mkdirSync(planDir, { recursive: true });
  const execDir = path.join(planDir, 'execution-plan');
  mkdirSync(execDir, { recursive: true });
  writeFileSync(path.join(planDir, 'execution-plan.md'), '# Execution Plan\n\n### Task 1: First\n\nBody.\n\n### Task 2: Second\n\nBody.\n');
  writeFileSync(path.join(execDir, 'index.md'), '# Plan Index\n\n**Source Plan:** ../execution-plan.md\n');
  const phase1 = '# Phase 1\n\n### Task 1: First\n\nWork done.\n';
  const phase2 = '# Phase 2\n\n### Task 2: Second\n\nWork done.\n';
  writeFileSync(path.join(execDir, 'phase-1.md'), phase1);
  writeFileSync(path.join(execDir, 'phase-2.md'), phase2);
  const specContent = 'approved spec content\n';
  writeFileSync(path.join(planDir, 'spec-doc.md'), specContent);

  gitIn(planDir, ['init', '-q']);
  gitIn(planDir, ['config', 'user.email', 'test@example.com']);
  gitIn(planDir, ['config', 'user.name', 'Test']);
  gitIn(planDir, ['config', 'commit.gpgsign', 'false']);
  gitIn(planDir, ['add', '-A']);
  gitIn(planDir, ['commit', '-q', '-m', 'plan snapshot']);
  gitIn(planDir, ['checkout', '-q', '-b', 'feature/issue-71']);

  run(['log', 'init', planDir, '--json', '--contract', '3']);

  const log0 = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
  const files = log0.phases.map((p) => p.file);
  assert.deepEqual(files, ['execution-plan/phase-1.md', 'execution-plan/phase-2.md']);

  // Seed revision 1 through the real store with a deterministic clock.
  const { commitTransition } = require('../cli/lib/lifecycle-store');
  const seeded = commitTransition({
    specDir: planDir, planDir: null, planId: 'plan-71', type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(specContent), revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(seeded.ok, true, `seed commit should succeed: ${JSON.stringify(seeded)}`);

  // Doubles: fake ONLY the projection writer (fails) and the adapter runner
  // (records). Lifecycle persistence stays real.
  const adapterCalls = [];
  const adapterRunner = (invocation) => {
    adapterCalls.push(invocation);
    return { attempted: true, deferred: false, reason: 'fake-adapter-recorded' };
  };
  const failingProjection = () => {
    throw new Error('injected projection failure');
  };

  process.env.POCKETTO_LIFECYCLE_NOW = FIXED_CLOCK;
  try {
    // Every phase eligible for closure (revisions 2..3 through the real CLI).
    for (const f of files) {
      const r = json(['log', 'update', planDir, f, 'REVIEW', '--json', '--contract', '3']);
      assert.equal(r.ok, true);
      const d = json(['log', 'update', planDir, f, 'DONE', '--json', '--contract', '3']);
      assert.equal(d.ok, true);
    }

    let thrown = null;
    try {
      logCmd.run({ sub: 'close', positionals: [planDir], projectionWriter: failingProjection, adapterRunner });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'projection failure must raise instead of reporting success');
    assert.equal(thrown.code, 'PROJECTION_REPAIR_REQUIRED');
    assert.deepEqual(thrown.details, {
      event_id: 'plan-71:plan-closed:r4',
      revision: 4,
      lifecycle_committed: true,
      dispatch_deferred: true,
    });
    assert.match(thrown.message, /plan-71:plan-closed:r4/);

    // Authoritative side durable: the closure event is committed and pending
    // even though the projection never wrote.
    const doc = JSON.parse(readFileSync(path.join(planDir, 'lifecycle.json'), 'utf8'));
    const closures = doc.events.filter((e) => e.type === 'plan-closed');
    assert.equal(closures.length, 1, 'close must record exactly one plan-closed event');
    assert.equal(closures[0].event_id, 'plan-71:plan-closed:r4');
    assert.equal(closures[0].revision, 4);
    assert.equal(closures[0].delivery.status, 'pending');
    assert.equal(doc.plan.revision, 4);
    assert.equal(doc.plan.state.status, 'DONE');

    // Projection side untouched: log.json still shows the pre-close status.
    const projected = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    assert.notEqual(projected.header.status, 'DONE');

    // Dispatch deferred: the adapter runner never fired.
    assert.equal(adapterCalls.length, 0);

    // Repair rebuilds the projection without emitting a new event.
    const repaired = logCmd.run({ sub: 'close', positionals: [planDir], adapterRunner });
    assert.equal(repaired.command, 'log close');
    const doc2 = JSON.parse(readFileSync(path.join(planDir, 'lifecycle.json'), 'utf8'));
    assert.equal(doc2.events.filter((e) => e.type === 'plan-closed').length, 1, 'repair must not emit a second closure event');
    const projected2 = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    assert.equal(projected2.header.status, 'DONE');
    assert.equal(adapterCalls.length, 1, 'adapter runs only once the projection succeeds');
    assert.equal(adapterCalls[0].event.event_id, 'plan-71:plan-closed:r4');
  } finally {
    delete process.env.POCKETTO_LIFECYCLE_NOW;
  }
});

test('CYCLE 6: Core-only transition performs zero Enterprise work', { skip: !hasGit() }, () => {
  const transition = require('../cli/lib/lifecycle-transition');

  // Boundary (static): Core files never require/import Enterprise modules,
  // shell to `gh`, or read credentials. (Prose comments may name the
  // boundary; code invocations and imports must not appear.)
  const enterpriseImport = /require\s*\(\s*['"][^'"]*enterprise|from\s+['"][^'"]*enterprise|import\s*\(\s*['"][^'"]*enterprise/;
  for (const rel of ['cli/lib/lifecycle-transition.js', 'cli/commands/log.js', 'cli/commands/lifecycle.js']) {
    const src = readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(!enterpriseImport.test(src), `${rel} must not import enterprise modules`);
    assert.ok(!src.includes("'gh'") && !src.includes('"gh"'), `${rel} must never shell to gh`);
    assert.ok(!src.includes('GITHUB_TOKEN') && !src.includes('GH_TOKEN'), `${rel} must not read credentials`);
  }

  // Recording child-process double for CLI subprocesses: wraps (never stubs)
  // every child_process entry point and appends {cmd, args} per invocation so
  // the test proves zero remote operations from real persistence.
  const roleDir = mkdtempSync(path.join(tmpdir(), 'core-only-'));
  const recorderPath = path.join(roleDir, 'spawn-recorder.js');
  writeFileSync(recorderPath, `'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const out = process.env.CORE6_SPAWN_LOG;
const NL = String.fromCharCode(10);
function record(cmd, args) {
  try {
    fs.appendFileSync(out, JSON.stringify({ cmd: String(cmd), args: Array.isArray(args) ? args.map(String) : [] }) + NL);
  } catch (e) {}
}
const methods = ['execFileSync', 'spawnSync', 'execFile', 'spawn', 'execSync', 'exec'];
for (const m of methods) {
  const orig = cp[m];
  if (typeof orig !== 'function') continue;
  cp[m] = function (cmd) {
    const args = Array.prototype.slice.call(arguments, 1);
    record(cmd, args[0]);
    return orig.apply(this, arguments);
  };
}
`);
  let spawnSeq = 0;
  const runRecorded = (args) => {
    const logPath = path.join(roleDir, `spawns-${spawnSeq++}.ndjson`);
    writeFileSync(logPath, '');
    const stdout = execFileSync('node', ['-r', recorderPath, CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CORE6_SPAWN_LOG: logPath },
    });
    const calls = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { stdout, calls };
  };
  const basename = (cmd) => String(cmd).split(/[\\/]/).pop();
  const assertNoRemoteWork = (calls) => {
    for (const c of calls) {
      assert.ok(basename(c.cmd) !== 'gh', 'Core must never invoke gh');
      const blob = `${c.cmd} ${(c.args || []).join(' ')}`;
      assert.ok(!/github/i.test(blob), `Core must not touch GitHub remotes: ${blob}`);
      assert.ok(!/token|credential|passwd/i.test(blob), `Core must not touch credentials: ${blob}`);
    }
  };

  // ── Path 1: CLI `lifecycle transition` with no adapter registration ──
  const rootA = mkdtempSync(path.join(tmpdir(), 'core-only-transition-'));
  const specDir = path.join(rootA, 'demo-plan');
  mkdirSync(specDir, { recursive: true });
  const specContent = 'approved spec content\n';
  writeFileSync(path.join(specDir, 'spec-doc.md'), specContent);
  const specSha = sha256Hex(specContent);
  assert.equal(existsSync(path.join(specDir, '.pocket', 'lifecycle-adapter.json')), false);
  assert.equal(transition.hasAdapterRegistration(specDir), false);

  const t1 = runRecorded([
    'lifecycle', 'transition', specDir, 'spec-approved',
    '--artifact', `spec:spec-doc:spec-doc.md:${specSha}`,
    '--json', '--contract', '3',
  ]);
  const envA = JSON.parse(t1.stdout.trim());
  assert.equal(envA.ok, true);
  assert.equal(envA.data.status, 'pending');
  assert.deepEqual(envA.data.dispatch, { attempted: false, deferred: true, reason: 'no-adapter-registration' });
  assert.deepEqual(
    [envA.data.event_id, envA.data.plan_id, envA.data.type, envA.data.revision],
    ['demo-plan:spec-approved:r1', 'demo-plan', 'spec-approved', 1],
  );
  assert.equal(t1.calls.length, 0, 'Core-only transition must spawn zero child processes');
  const docA = JSON.parse(readFileSync(path.join(specDir, 'lifecycle.json'), 'utf8'));
  assert.equal(docA.events.length, 1);
  assert.equal(docA.events[0].delivery.status, 'pending');

  // ── Path 2: CLI `log update` phase→REVIEW with no adapter registration ──
  const rootB = mkdtempSync(path.join(tmpdir(), 'core-only-update-'));
  const planDir = path.join(rootB, 'plan-80');
  mkdirSync(planDir, { recursive: true });
  const execDir = path.join(planDir, 'execution-plan');
  mkdirSync(execDir, { recursive: true });
  writeFileSync(path.join(planDir, 'execution-plan.md'), '# Execution Plan\n\n### Task 1: First\n\nBody.\n');
  writeFileSync(path.join(execDir, 'index.md'), '# Plan Index\n\n**Source Plan:** ../execution-plan.md\n');
  const phaseContent = '# Phase 1\n\n### Task 1: First\n\nWork done.\n';
  writeFileSync(path.join(execDir, 'phase-1.md'), phaseContent);
  const phaseSha = sha256Hex(phaseContent);
  const seedContent = 'approved spec content\n';
  writeFileSync(path.join(planDir, 'spec-doc.md'), seedContent);

  gitIn(planDir, ['init', '-q']);
  gitIn(planDir, ['config', 'user.email', 'test@example.com']);
  gitIn(planDir, ['config', 'user.name', 'Test']);
  gitIn(planDir, ['config', 'commit.gpgsign', 'false']);
  gitIn(planDir, ['add', '-A']);
  gitIn(planDir, ['commit', '-q', '-m', 'plan snapshot']);
  gitIn(planDir, ['checkout', '-q', '-b', 'feature/issue-80']);

  assert.equal(existsSync(path.join(planDir, '.pocket', 'lifecycle-adapter.json')), false);
  assert.equal(transition.hasAdapterRegistration(planDir), false);

  run(['log', 'init', planDir, '--json', '--contract', '3']);
  const log0 = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
  const phaseFile = log0.phases[0].file;

  // Seed revision 1 through the real store with a deterministic clock.
  const { commitTransition } = require('../cli/lib/lifecycle-store');
  const seeded = commitTransition({
    specDir: planDir, planDir: null, planId: 'plan-80', type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha256Hex(seedContent), revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(seeded.ok, true, `seed commit should succeed: ${JSON.stringify(seeded)}`);

  process.env.POCKETTO_LIFECYCLE_NOW = FIXED_CLOCK;
  try {
    const up = runRecorded(['log', 'update', planDir, phaseFile, 'REVIEW', '--json', '--contract', '3']);
    const envB = JSON.parse(up.stdout.trim());
    assert.equal(envB.ok, true);
    assert.deepEqual(envB.data.dispatch, { attempted: false, deferred: true, reason: 'no-adapter-registration' });
    assert.equal(envB.data.event.event_id, 'plan-80:phase-complete:r2');
    assert.equal(envB.data.event.revision, 2);
    assert.equal(envB.data.event.status, 'pending');
    assertNoRemoteWork(up.calls);
    for (const c of up.calls) {
      assert.equal(basename(c.cmd), 'git', 'only local git may run on the Core-only path');
    }

    // Authoritative side durable and pending; projection side projected.
    const docB = JSON.parse(readFileSync(path.join(planDir, 'lifecycle.json'), 'utf8'));
    assert.equal(docB.events.length, 2);
    const second = docB.events[1];
    assert.equal(second.event_id, 'plan-80:phase-complete:r2');
    assert.equal(second.revision, 2);
    assert.equal(second.type, 'phase-complete');
    assert.deepEqual(second.artifact_refs, [
      { root: 'plan', kind: 'phase-evidence', path: phaseFile, sha256: phaseSha, revision: 1 },
    ]);
    assert.equal(second.delivery.status, 'pending');
    const projected = JSON.parse(readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    assert.equal(projected.phases[0].status, 'REVIEW');
  } finally {
    delete process.env.POCKETTO_LIFECYCLE_NOW;
  }
});
