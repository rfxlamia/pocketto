'use strict';

// Behavior tests for the pocketto-pi CLI. Self-contained (no Python): they
// lock in the parity that was verified against the original scripts during
// the v2.0 migration — phase-file format, log.json schema, SHA tracking,
// structure thresholds, and the --json envelope.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');

function run(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
    assert.ok(!expectFail, `expected failure but command succeeded: ${args.join(' ')}`);
    return { stdout, code: 0 };
  } catch (err) {
    assert.ok(expectFail, `command failed unexpectedly: ${args.join(' ')}\n${err.stdout || ''}${err.stderr || ''}`);
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status };
  }
}

function json(args, opts) {
  return JSON.parse(run(args, opts).stdout.trim());
}

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'pocketto-'));
}

const NINE_TASK_PLAN = `# EXECUTION PLAN — Auth refactor

**Date:** 2026-05-08
**Spec:** docs/pocket/specs/auth.md

## Pocket Packets

---

### Task 1: Scaffold auth module [prereq]

Create the skeleton.

---

### Task 2: Extract token logic [depends: T1]

Move token code.

---

### Task 3: Extract session logic [parallel: T2]

Move session code.

---

### Task 4: Wire config loader [depends: T1]

Config.

---

### Task 5: Add middleware [depends: T2, T3]

Middleware.

---

### Task 6: Add guards [depends: T4]

Guards.

---

### Task 7: Refactor callers [depends: T5, T6]

Callers.

---

### Task 8: Integration tests [depends: T7]

Tests.

---

### Task 9: Docs [depends: T8]

Docs.

## Plan Summary

Done.
`;

const SMALL_PLAN = `# EXECUTION PLAN — Tiny

**Date:** 2026-06-01
**Spec:** x.md

## Pocket Packets

---

### Task 1: A [prereq]
body
---
### Task 2: B [depends: T1]
body

## Plan Summary
`;

function writePlan(dir, content) {
  const p = path.join(dir, 'execution-plan.md');
  writeFileSync(p, content);
  return p;
}

test('structure splits a 9-task plan into 3 phases (human + JSON)', () => {
  const dir = tmp();
  const plan = writePlan(dir, NINE_TASK_PLAN);

  const human = run(['structure', plan]).stdout;
  assert.match(human, /STRUCTURING COMPLETE/);

  const phaseFiles = readdirSync(dir).filter((f) => /^execution-plan-phase-\d+\.md$/.test(f)).sort();
  assert.deepEqual(phaseFiles, [
    'execution-plan-phase-1.md',
    'execution-plan-phase-2.md',
    'execution-plan-phase-3.md',
  ]);

  // Phase file format invariants.
  const p1 = readFileSync(path.join(dir, 'execution-plan-phase-1.md'), 'utf8');
  assert.match(p1, /^# Auth refactor — Scaffold auth module \(Phase 1 of 3\)$/m);
  assert.match(p1, /\*\*Contains tasks:\*\* \{T1, T2, T3, T4\}/);
  assert.match(p1, /## Phase Completion Gate/);

  const env = json(['structure', plan, '--dry-run', '--json']);
  assert.equal(env.ok, true);
  assert.equal(env.command, 'structure');
  assert.equal(env.contract, 2);
  assert.equal(env.data.action, 'split');
  assert.equal(env.data.taskCount, 9);
  assert.deepEqual(
    env.data.phases.map((p) => p.tasks),
    [['T1', 'T2', 'T3', 'T4'], ['T5', 'T6', 'T7'], ['T8', 'T9']],
  );
});

test('structure passes through plans below the threshold', () => {
  const dir = tmp();
  const plan = writePlan(dir, SMALL_PLAN);

  const env = json(['structure', plan, '--json']);
  assert.equal(env.data.action, 'passthrough');
  assert.equal(env.data.taskCount, 2);
  // No phase files written.
  assert.equal(readdirSync(dir).some((f) => /phase-\d+/.test(f)), false);
});

test('structure --dry-run surfaces an execution flow for passthrough plans (no files)', () => {
  const dir = tmp();
  const plan = writePlan(dir, SMALL_PLAN);

  const env = json(['structure', plan, '--dry-run', '--json']);
  assert.equal(env.data.action, 'passthrough');
  assert.equal(env.data.executionFlow, 'T1→T2');
  // Validation is side-effect-free — no phase files written.
  assert.equal(readdirSync(dir).some((f) => /phase-\d+/.test(f)), false);
});

test('structure exposes the depth-based execution flow for split plans', () => {
  const dir = tmp();
  const plan = writePlan(dir, NINE_TASK_PLAN);

  const env = json(['structure', plan, '--dry-run', '--json']);
  assert.equal(env.data.action, 'split');
  assert.equal(env.data.executionFlow, 'T1→T2,T3,T4(PARALLEL)→T5,T6(PARALLEL)→T7→T8→T9');
});

test('structure validates passthrough plans: a dangling dependency errors early', () => {
  const dir = tmp();
  // 2 tasks (passthrough) but T2 depends on a task that does not exist.
  const broken = `# EXECUTION PLAN — Broken

**Date:** 2026-06-01
**Spec:** x.md

## Pocket Packets

---

### Task 1: A [prereq]
body
---
### Task 2: B [depends: T9]
body

## Plan Summary
`;
  const plan = writePlan(dir, broken);
  const res = run(['structure', plan, '--json'], { expectFail: true });
  const env = JSON.parse(res.stdout.trim());
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'UNKNOWN_TASK_REF');
  assert.equal(res.code, 1);
});

test('structure errors on a plan with no tasks (envelope + exit 1)', () => {
  const dir = tmp();
  const plan = writePlan(dir, '# EXECUTION PLAN — Empty\n\n## Pocket Packets\n\n## Plan Summary\n');
  const res = run(['structure', plan, '--json'], { expectFail: true });
  const env = JSON.parse(res.stdout.trim());
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'NO_TASKS');
  assert.equal(res.code, 1);
});

test('log init creates a phased log.json with tasks + SHA tracking field', () => {
  const dir = tmp();
  writePlan(dir, NINE_TASK_PLAN);
  run(['structure', path.join(dir, 'execution-plan.md')]);

  run(['log', 'init', dir]);
  const log = JSON.parse(readFileSync(path.join(dir, 'log.json'), 'utf8'));
  assert.equal(log.header.plan_type, 'phased');
  assert.equal(log.header.status, 'IN_PROGRESS');
  assert.ok('baseline_sha' in log.header);
  assert.equal(log.phases.length, 3);
  assert.deepEqual(log.phases[0].tasks.map((t) => t.id), ['T1', 'T2', 'T3', 'T4']);
  assert.equal(log.phases[0].tasks[0].status, 'WAITING');
});

test('log init migrates tasks into an existing task-less log.json, preserving status', () => {
  const dir = tmp();
  writePlan(dir, NINE_TASK_PLAN);
  run(['structure', path.join(dir, 'execution-plan.md')]);

  // Hand-craft an old-style log.json: phases without tasks, phase 1 already DONE.
  const legacy = {
    header: { plan_dir: dir, plan_type: 'phased', status: 'IN_PROGRESS', date_started: '2026-01-01', date_completed: null },
    phases: [
      { order: 1, file: 'execution-plan-phase-1.md', status: 'DONE' },
      { order: 2, file: 'execution-plan-phase-2.md', status: 'WAITING' },
      { order: 3, file: 'execution-plan-phase-3.md', status: 'WAITING' },
    ],
  };
  writeFileSync(path.join(dir, 'log.json'), JSON.stringify(legacy, null, 2) + '\n');

  run(['log', 'init', dir]);
  const log = JSON.parse(readFileSync(path.join(dir, 'log.json'), 'utf8'));
  // DONE phase -> its injected tasks inherit DONE; WAITING phase -> WAITING.
  assert.equal(log.phases[0].status, 'DONE');
  assert.equal(log.phases[0].tasks.every((t) => t.status === 'DONE'), true);
  assert.equal(log.phases[1].tasks.every((t) => t.status === 'WAITING'), true);
});

test('log update changes phase + task status and reports via --json', () => {
  const dir = tmp();
  writePlan(dir, NINE_TASK_PLAN);
  run(['structure', path.join(dir, 'execution-plan.md')]);
  run(['log', 'init', dir]);

  const env = json(['log', 'update', dir, 'execution-plan-phase-1.md', 'DONE', '--task', 'T1', '--json']);
  assert.equal(env.ok, true);
  assert.equal(env.command, 'log update');
  assert.equal(env.data.level, 'task');
  assert.equal(env.data.newStatus, 'DONE');

  const log = JSON.parse(readFileSync(path.join(dir, 'log.json'), 'utf8'));
  assert.equal(log.phases[0].tasks.find((t) => t.id === 'T1').status, 'DONE');
});

test('log update rejects an invalid status', () => {
  const dir = tmp();
  writePlan(dir, NINE_TASK_PLAN);
  run(['structure', path.join(dir, 'execution-plan.md')]);
  run(['log', 'init', dir]);
  const res = run(['log', 'update', dir, 'execution-plan-phase-1.md', 'NOPE', '--json'], { expectFail: true });
  assert.equal(JSON.parse(res.stdout.trim()).error.code, 'BAD_STATUS');
});

test('log close refuses while phases are not DONE, then finalizes when all DONE', () => {
  const dir = tmp();
  writePlan(dir, NINE_TASK_PLAN);
  run(['structure', path.join(dir, 'execution-plan.md')]);
  run(['log', 'init', dir]);

  // Premature close fails.
  const early = run(['log', 'close', dir, '--json'], { expectFail: true });
  assert.equal(JSON.parse(early.stdout.trim()).error.code, 'PHASES_NOT_DONE');

  // Mark all phases DONE.
  for (const f of ['execution-plan-phase-1.md', 'execution-plan-phase-2.md', 'execution-plan-phase-3.md']) {
    run(['log', 'update', dir, f, 'DONE']);
  }
  const env = json(['log', 'close', dir, '--json']);
  assert.equal(env.ok, true);
  const log = JSON.parse(readFileSync(path.join(dir, 'log.json'), 'utf8'));
  assert.equal(log.header.status, 'DONE');
  assert.ok(log.header.date_completed);
});

test('contract handshake fails loudly on mismatch', () => {
  const dir = tmp();
  const plan = writePlan(dir, SMALL_PLAN);
  const res = run(['structure', plan, '--contract', '99', '--json'], { expectFail: true });
  const env = JSON.parse(res.stdout.trim());
  assert.equal(env.error.code, 'CONTRACT_MISMATCH');
  // Matching contract passes.
  assert.equal(json(['structure', plan, '--contract', '2', '--json']).ok, true);
});

test('a value-taking flag as the last arg fails instead of being silently dropped', () => {
  const dir = tmp();
  const plan = writePlan(dir, SMALL_PLAN);
  // --contract with no value must NOT silently skip the handshake.
  const c = run(['structure', plan, '--json', '--contract'], { expectFail: true });
  assert.equal(JSON.parse(c.stdout.trim()).error.code, 'MISSING_VALUE');

  // --task with no value must NOT silently fall back to a phase-level update.
  writePlan(dir, NINE_TASK_PLAN);
  run(['structure', path.join(dir, 'execution-plan.md')]);
  run(['log', 'init', dir]);
  const t = run(['log', 'update', dir, 'execution-plan-phase-1.md', 'DONE', '--json', '--task'], { expectFail: true });
  assert.equal(JSON.parse(t.stdout.trim()).error.code, 'MISSING_VALUE');
});

test('structure reports a clean error on circular dependencies (no stack overflow)', () => {
  const dir = tmp();
  // Needs >= 7 tasks so the splitter (and computeDepths) actually runs;
  // T6 <-> T7 form the cycle.
  const cyclic = `# EXECUTION PLAN — Cyclic

**Date:** 2026-06-01
**Spec:** x.md

## Pocket Packets

---

### Task 1: A [prereq]
body
---
### Task 2: B [depends: T1]
body
---
### Task 3: C [depends: T1]
body
---
### Task 4: D [depends: T2]
body
---
### Task 5: E [depends: T3]
body
---
### Task 6: F [depends: T7]
body
---
### Task 7: G [depends: T6]
body

## Plan Summary
`;
  const plan = writePlan(dir, cyclic);
  const res = run(['structure', plan, '--json'], { expectFail: true });
  assert.equal(JSON.parse(res.stdout.trim()).error.code, 'CYCLE_DETECTED');
});

test('log update/close accept a plan file argument, not just the directory', () => {
  const dir = tmp();
  const planFile = writePlan(dir, NINE_TASK_PLAN);
  run(['structure', planFile]);
  run(['log', 'init', dir]);

  // Pass the plan FILE (not the dir) — should resolve to the directory's log.json.
  const upd = json(['log', 'update', planFile, 'execution-plan-phase-1.md', 'DONE', '--task', 'T1', '--json']);
  assert.equal(upd.ok, true);
  assert.equal(upd.data.newStatus, 'DONE');

  for (const f of ['execution-plan-phase-1.md', 'execution-plan-phase-2.md', 'execution-plan-phase-3.md']) {
    run(['log', 'update', planFile, f, 'DONE']);
  }
  assert.equal(json(['log', 'close', planFile, '--json']).ok, true);
});
