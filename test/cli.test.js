'use strict';

// Behavior tests for the pocketto-pi CLI. Self-contained (no Python): they
// lock in the parity that was verified against the original scripts during
// the v2.0 migration — phase-file format, log.json schema, SHA tracking,
// structure thresholds, and the --json envelope.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');

// In-process modules for the extension-setup unit tests (no child process).
const extensions = require('../cli/lib/extensions');
const setupExtensions = require('../cli/commands/setup-extensions');

function run(args, { expectFail = false, env } = {}) {
  // Merge env overrides onto process.env so PATH (needed to spawn `node`) survives.
  const childEnv = env ? { ...process.env, ...env } : process.env;
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: childEnv });
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

function writeModeConfig(dir, file, body) {
  writeFileSync(path.join(dir, file), body);
}

function enterpriseBlock(lines, eol = '\n') {
  return ['# Local Agent Notes', '', '## Pocket Enterprise', '', '```', ...lines, '```', ''].join(eol);
}

test('mode defaults to local mode when no Pocket Enterprise heading exists', () => {
  const dir = tmp();
  writeModeConfig(dir, 'AGENTS.md', '# Notes\n\nNo enterprise config here.\n');

  const env = json(['mode', dir, '--json']);
  assert.equal(env.ok, true);
  assert.equal(env.command, 'mode');
  assert.deepEqual(env.data, {
    enterprise: false,
    branch_strategy: null,
    create_pr: null,
    source: null,
  });
});

test('mode uses CLAUDE.md as a whole-heading override over AGENTS.md', () => {
  const dir = tmp();
  writeModeConfig(dir, 'AGENTS.md', enterpriseBlock([
    'enterprise: true',
    'branch_strategy: branch',
    'create_pr: true',
  ]));
  writeModeConfig(dir, 'CLAUDE.md', enterpriseBlock([
    'enterprise: false',
    'branch_strategy: main-local',
    'create_pr: false',
  ]));

  const env = json(['mode', dir, '--json']);
  assert.deepEqual(env.data, {
    enterprise: false,
    branch_strategy: 'main-local',
    create_pr: false,
    source: 'CLAUDE.md',
  });
});

test('mode errors when enterprise true is missing a required field', () => {
  const dir = tmp();
  writeModeConfig(dir, 'AGENTS.md', enterpriseBlock([
    'enterprise: true',
    'branch_strategy: branch',
  ]));

  const res = run(['mode', dir, '--json'], { expectFail: true });
  const env = JSON.parse(res.stdout.trim());
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'MODE_CONFIG_INVALID');
  assert.match(env.error.message, /create_pr/);
  assert.equal(res.code, 1);
});

test('mode errors on unknown enum values in active config', () => {
  const dir = tmp();
  writeModeConfig(dir, 'AGENTS.md', enterpriseBlock([
    'enterprise: true',
    'branch_strategy: feature',
    'create_pr: true',
  ]));

  const res = run(['mode', dir, '--json'], { expectFail: true });
  const env = JSON.parse(res.stdout.trim());
  assert.equal(env.error.code, 'MODE_CONFIG_INVALID');
  assert.match(env.error.message, /branch_strategy/);
});

test('mode does not fall back to AGENTS.md when CLAUDE.md override is malformed', () => {
  const dir = tmp();
  writeModeConfig(dir, 'AGENTS.md', enterpriseBlock([
    'enterprise: true',
    'branch_strategy: branch',
    'create_pr: true',
  ]));
  writeModeConfig(dir, 'CLAUDE.md', [
    '# Local Agent Notes',
    '',
    '## Pocket Enterprise',
    '',
    '```',
    'enterprise: true',
    'branch_strategy: main-local',
  ].join('\n'));

  const res = run(['mode', dir, '--json'], { expectFail: true });
  const env = JSON.parse(res.stdout.trim());
  assert.equal(env.error.code, 'MODE_CONFIG_INVALID');
  assert.match(env.error.message, /fenced block/i);
});

test('mode parses CRLF config the same as LF config', () => {
  const lfDir = tmp();
  const crlfDir = tmp();
  const lines = [
    'enterprise: true',
    'branch_strategy: branch # inline comments are ignored',
    'create_pr: false',
  ];
  writeModeConfig(lfDir, 'AGENTS.md', enterpriseBlock(lines, '\n'));
  writeModeConfig(crlfDir, 'AGENTS.md', enterpriseBlock(lines, '\r\n'));

  const lf = json(['mode', lfDir, '--json']);
  const crlf = json(['mode', crlfDir, '--json']);
  assert.deepEqual(lf.data, {
    enterprise: true,
    branch_strategy: 'branch',
    create_pr: false,
    source: 'AGENTS.md',
  });
  assert.deepEqual(crlf.data, lf.data);
});

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

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function gitInitRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['commit', '--allow-empty', '-q', '-m', 'init']);
}

// Issue #28: when a parallel group is merged in a batch and logged afterwards,
// every `log update --task` captures the same HEAD (one merge commit), so the
// 2nd+ task reuses a sibling's done_sha. The CLI must surface that collision.
test('log update warns when a task reuses a sibling done_sha (collapsed parallel merge)', { skip: !hasGit() }, () => {
  const dir = tmp();
  writePlan(dir, NINE_TASK_PLAN);
  run(['structure', path.join(dir, 'execution-plan.md')]);
  gitInitRepo(dir); // done_sha is only captured inside a real repo
  run(['log', 'init', dir]);

  const phase = 'execution-plan-phase-1.md'; // contains T1..T4

  // T2 DONE → captures the current commit; first writer, so no collision.
  const t2 = json(['log', 'update', dir, phase, 'DONE', '--task', 'T2', '--json']);
  assert.ok(t2.data.doneSha, 'expected a real done_sha inside a git repo');
  assert.equal(t2.data.shaCollision, null);

  // T3 DONE with NO new commit → same HEAD → same done_sha → collision on T2.
  const t3 = json(['log', 'update', dir, phase, 'DONE', '--task', 'T3', '--json']);
  assert.equal(t3.data.doneSha, t2.data.doneSha);
  assert.deepEqual(t3.data.shaCollision, ['T2']);

  // Advance HEAD, then T4 DONE → distinct done_sha → no collision.
  git(dir, ['commit', '--allow-empty', '-q', '-m', 'advance']);
  const t4 = json(['log', 'update', dir, phase, 'DONE', '--task', 'T4', '--json']);
  assert.notEqual(t4.data.doneSha, t2.data.doneSha);
  assert.equal(t4.data.shaCollision, null);

  // The human (non-JSON) path surfaces the warning too.
  const human = run(['log', 'update', dir, phase, 'DONE', '--task', 'T3']).stdout;
  assert.match(human, /done_sha .* is already recorded for/);
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

test('meta set creates .pocket-meta.json with stable direct-write serialization', () => {
  const dir = tmp();

  const env = json(['meta', 'set', dir, 'github_issue.number', '42', '--json']);
  assert.equal(env.ok, true);
  assert.equal(env.command, 'meta set');
  assert.equal(env.data.field, 'github_issue.number');
  assert.equal(env.data.value, 42);

  const metaPath = path.join(dir, '.pocket-meta.json');
  const content = readFileSync(metaPath, 'utf8');
  assert.match(content, /\n$/);
  assert.match(content, /^  "github_issue":/m);

  const parsed = JSON.parse(content);
  assert.equal(parsed.github_issue.number, 42);
  assert.equal(content, JSON.stringify(parsed, null, 2) + '\n');
});

test('meta get round-trips values from .pocket-meta.json', () => {
  const dir = tmp();
  json(['meta', 'set', dir, 'github_issue.url', 'https://github.com/acme/project/issues/42', '--json']);

  const env = json(['meta', 'get', dir, 'github_issue.url', '--json']);
  assert.equal(env.ok, true);
  assert.equal(env.command, 'meta get');
  assert.equal(env.data.field, 'github_issue.url');
  assert.equal(env.data.value, 'https://github.com/acme/project/issues/42');
});

test('meta successive writes preserve earlier values and nested phase data', () => {
  const dir = tmp();
  json(['meta', 'set', dir, 'github_issue.number', '42', '--json']);
  json(['meta', 'set', dir, 'github_issue.created_at', '2026-06-09T00:00:00Z', '--json']);
  json(['meta', 'set', dir, 'phases.phase-1.github_pr.number', '7', '--json']);
  json(['meta', 'set', dir, 'phases.phase-1.fingerprints', '["a","b"]', '--json']);
  json(['meta', 'set', dir, 'external_tracker', 'JIRA-123', '--json']);

  const meta = JSON.parse(readFileSync(path.join(dir, '.pocket-meta.json'), 'utf8'));
  assert.equal(meta.github_issue.number, 42);
  assert.equal(meta.github_issue.created_at, '2026-06-09T00:00:00Z');
  assert.equal(meta.phases['phase-1'].github_pr.number, 7);
  assert.deepEqual(meta.phases['phase-1'].fingerprints, ['a', 'b']);
  assert.equal(meta.external_tracker, 'JIRA-123');
});

test('meta read normalizes CRLF before JSON parse', () => {
  const dir = tmp();
  const metaPath = path.join(dir, '.pocket-meta.json');
  writeFileSync(metaPath, '{\r\n  "github_issue": {\r\n    "number": 42\r\n  }\r\n}\r\n');

  const env = json(['meta', 'get', dir, 'github_issue.number', '--json']);
  assert.equal(env.ok, true);
  assert.equal(env.data.value, 42);
});

test('meta direct-write content equals JSON.stringify(parsed, null, 2) plus newline', () => {
  const dir = tmp();
  json(['meta', 'set', dir, 'phases.phase-2.github_pr.url', 'https://github.com/acme/project/pull/8', '--json']);

  const content = readFileSync(path.join(dir, '.pocket-meta.json'), 'utf8');
  const parsed = JSON.parse(content);
  assert.equal(content, JSON.stringify(parsed, null, 2) + '\n');
});

// ─── extensions: registry + spec normalization (in-process unit) ──────────────

test('normalizeSpec maps every Pi packages[] spec shape to a bare package name', () => {
  const { normalizeSpec } = extensions;
  assert.equal(normalizeSpec('pi-mcp-adapter'), 'pi-mcp-adapter');
  assert.equal(normalizeSpec('npm:pi-mcp-adapter'), 'pi-mcp-adapter');
  assert.equal(normalizeSpec('pi-mcp-adapter@2.9.0'), 'pi-mcp-adapter');
  assert.equal(normalizeSpec('npm:@gotgenes/pi-subagents'), '@gotgenes/pi-subagents');
  assert.equal(normalizeSpec('npm:@gotgenes/pi-subagents@14'), '@gotgenes/pi-subagents');
  assert.equal(normalizeSpec('@juicesharp/rpiv-advisor@1.18.2'), '@juicesharp/rpiv-advisor');
  // Alias form: resolve to the real package on the RHS of the first @npm:/@git:.
  assert.equal(normalizeSpec('foo@npm:@scope/bar@1.2.3'), '@scope/bar');
  // git/url specs carry no npm name → out of scope (null).
  assert.equal(normalizeSpec('git:github.com/org/repo'), null);
  assert.equal(normalizeSpec('https://github.com/org/repo'), null);
  assert.equal(normalizeSpec(''), null);
  assert.equal(normalizeSpec(undefined), null);
});

test('parseInstalledSpecs dedupes to a name set and ignores unmappable specs', () => {
  const set = extensions.parseInstalledSpecs([
    'npm:pi-mcp-adapter@2.9.0',
    'npm:@gotgenes/pi-subagents',
    'git:github.com/org/fork', // unmappable → ignored
    'not-an-array-friend',
  ]);
  assert.equal(set.has('pi-mcp-adapter'), true);
  assert.equal(set.has('@gotgenes/pi-subagents'), true);
  assert.equal(set.has('not-an-array-friend'), true);
  assert.equal(set.size, 3);
  assert.equal(extensions.parseInstalledSpecs(null).size, 0);
});

// ─── setup-extensions (in-process, injected runner — real `pi` never spawned) ─

// A fake runner recording its calls. `--version` reports pi present unless
// piMissing; installs succeed unless the spec matches a failPkgs substring.
function fakeRunner({ piMissing = false, failPkgs = [] } = {}) {
  const calls = [];
  const runner = (...args) => {
    calls.push(args);
    if (args[0] === '--version') return { status: piMissing ? 127 : 0, stdout: 'pi', stderr: '' };
    const spec = args[1] || '';
    const fail = failPkgs.some((f) => spec.includes(f));
    return { status: fail ? 1 : 0, stdout: '', stderr: fail ? 'install failed' : '' };
  };
  runner.calls = calls;
  return runner;
}

// A tmp HOME with an optional Pi settings.json (packages[] = given specs).
function piHome(packages) {
  const home = tmp();
  if (packages !== undefined) {
    mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages }, null, 2));
  }
  return home;
}

test('setup-extensions installs the 3 required extensions when none are present', () => {
  const home = piHome([]); // settings exist but no packages
  const runner = fakeRunner();
  const res = setupExtensions.run({ env: { HOME: home }, runner });

  assert.equal(res.command, 'setup-extensions');
  assert.equal(res.exit, 0);
  assert.deepEqual(res.data.installed, ['pi-mcp-adapter', '@gotgenes/pi-subagents', '@juicesharp/rpiv-advisor']);
  assert.deepEqual(res.data.skipped, []);
  // Precheck + 3 installs, with the npm: scheme on each spec.
  assert.deepEqual(runner.calls[0], ['--version']);
  assert.deepEqual(runner.calls.slice(1), [
    ['install', 'npm:pi-mcp-adapter'],
    ['install', 'npm:@gotgenes/pi-subagents'],
    ['install', 'npm:@juicesharp/rpiv-advisor'],
  ]);
  // Fake runner never writes settings, so the re-read can't confirm — non-fatal.
  assert.deepEqual(res.data.unconfirmed, res.data.installed);
});

test('setup-extensions --all also installs the recommended extensions', () => {
  const home = piHome([]);
  const runner = fakeRunner();
  const res = setupExtensions.run({ env: { HOME: home }, runner, all: true });
  assert.equal(res.data.installed.length, 6);
  assert.equal(res.data.installed.includes('@tintinweb/pi-tasks'), true);
});

test('setup-extensions skips already-installed extensions (idempotent)', () => {
  const home = piHome(['npm:pi-mcp-adapter@2.9.0']);
  const runner = fakeRunner();
  const res = setupExtensions.run({ env: { HOME: home }, runner });
  assert.deepEqual(res.data.skipped, ['pi-mcp-adapter']);
  assert.deepEqual(res.data.installed, ['@gotgenes/pi-subagents', '@juicesharp/rpiv-advisor']);
  // No install call for the already-present package.
  assert.equal(runner.calls.some((c) => c[1] === 'npm:pi-mcp-adapter'), false);
});

test('setup-extensions errors cleanly when `pi` is not on PATH', () => {
  const home = piHome([]);
  const runner = fakeRunner({ piMissing: true });
  assert.throws(
    () => setupExtensions.run({ env: { HOME: home }, runner }),
    (err) => err.code === 'PI_NOT_FOUND',
  );
});

test('setup-extensions reports a failed install and exits nonzero, finishing the rest', () => {
  const home = piHome([]);
  const runner = fakeRunner({ failPkgs: ['pi-subagents'] });
  const res = setupExtensions.run({ env: { HOME: home }, runner });
  assert.equal(res.exit, 1);
  assert.equal(res.data.ok, false);
  assert.deepEqual(res.data.failed, ['@gotgenes/pi-subagents']);
  // The failure did not abort the remaining install.
  assert.equal(res.data.installed.includes('@juicesharp/rpiv-advisor'), true);
});

// ─── doctor (child process, env-overridden HOME — read-only, no `pi`) ─────────

const ALL_SIX = [
  'npm:pi-mcp-adapter',
  'npm:@gotgenes/pi-subagents',
  'npm:@juicesharp/rpiv-advisor',
  'npm:@juicesharp/rpiv-ask-user-question',
  'npm:@tintinweb/pi-tasks',
  'npm:@aliou/pi-processes',
];

test('doctor reports all-installed (exit 0, --json data.ok true)', () => {
  const home = piHome(ALL_SIX);
  const env = json(['doctor', '--json'], { env: { HOME: home, USERPROFILE: home } });
  assert.equal(env.ok, true);
  assert.equal(env.command, 'doctor');
  assert.equal(env.contract, 2);
  assert.equal(env.data.ok, true);
  assert.deepEqual(env.data.missingRequired, []);
  assert.deepEqual(env.data.missingRecommended, []);
});

test('doctor flags missing extensions but stays exit 0 by default', () => {
  const home = piHome(['npm:pi-mcp-adapter']); // 2 required + all recommended missing
  const res = run(['doctor', '--json'], { env: { HOME: home, USERPROFILE: home } });
  assert.equal(res.code, 0);
  const env = JSON.parse(res.stdout.trim());
  assert.equal(env.data.ok, false);
  assert.deepEqual(env.data.missingRequired, ['@gotgenes/pi-subagents', '@juicesharp/rpiv-advisor']);
});

test('doctor --strict exits nonzero when a required extension is missing', () => {
  const home = piHome(['npm:pi-mcp-adapter']);
  const res = run(['doctor', '--strict', '--json'], { env: { HOME: home, USERPROFILE: home }, expectFail: true });
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout.trim()).data.ok, false);
  // --strict with everything present exits 0.
  const okHome = piHome(ALL_SIX);
  assert.equal(run(['doctor', '--strict', '--json'], { env: { HOME: okHome, USERPROFILE: okHome } }).code, 0);
});

test('doctor treats absent or malformed settings.json as none-installed (no crash)', () => {
  // Absent: tmp HOME with no .pi/ at all.
  const empty = tmp();
  const a = JSON.parse(run(['doctor', '--json'], { env: { HOME: empty, USERPROFILE: empty } }).stdout.trim());
  assert.equal(a.data.ok, false);
  assert.equal(a.data.missingRequired.length, 3);

  // Malformed JSON.
  const home = tmp();
  mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), '{ not valid json');
  const m = run(['doctor', '--json'], { env: { HOME: home, USERPROFILE: home } });
  assert.equal(m.code, 0);
  assert.equal(JSON.parse(m.stdout.trim()).data.missingRequired.length, 3);
});

test('the new --strict/--all flags are accepted; unknown flags still rejected', () => {
  const home = piHome(ALL_SIX);
  // --all is a known flag (no UNKNOWN_FLAG even though doctor ignores it).
  assert.equal(run(['doctor', '--all', '--json'], { env: { HOME: home, USERPROFILE: home } }).code, 0);
  // A genuinely unknown flag still throws.
  const bad = run(['doctor', '--nope', '--json'], { expectFail: true });
  assert.equal(JSON.parse(bad.stdout.trim()).error.code, 'UNKNOWN_FLAG');
});
