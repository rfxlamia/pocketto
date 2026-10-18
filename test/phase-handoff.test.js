'use strict';

// Integration tests (CLI + real git + lifecycle document) for
// `log handoff <plan_dir> <phase_file>` steps 1-3. Each test title carries the
// cycle pattern it belongs to, so `node --test --test-name-pattern="<pattern>"`
// selects exactly that cycle. Every fixture is a temp repository.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');
const FIXED_CLOCK = '2026-10-10T00:00:00.000Z';

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function writeFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runCli(repo, args, { envOverride, json = true } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, ...(json ? ['--json'] : []), '--contract', '3'], {
    cwd: repo,
    encoding: 'utf8',
    env: envOverride || { ...process.env, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK },
  });
  let env = null;
  try {
    env = JSON.parse(r.stdout.trim());
  } catch {
    env = null;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, env };
}

function okCli(repo, args) {
  const r = runCli(repo, args);
  assert.equal(r.status, 0, `${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
  return r.env;
}

function phaseBody(order) {
  return [
    `# Phase ${order}: Handoff fixture phase ${order}`,
    '',
    `### Task ${order}: Behavior for phase ${order}`,
    '',
    `Body for phase ${order}.`,
    '',
  ].join('\n');
}

function phaseSection(order, total) {
  return [
    `## Phase ${order} of ${total} — Fixture phase ${order}`,
    `<!-- pocket-closeout:phase-${order} -->`,
    '',
    '**Status:** Complete — `REVIEW` → `DONE`',
    '',
    '### What was completed',
    '',
    `- **T${order} — behavior ${order}:** completed only in phase ${order} (marker text P${order}X)`,
    '',
  ].join('\n');
}

const CLOSEOUT_HEADER = [
  '# Pocket Closeout — Fixture plan',
  '',
  '- **Plan:** docs/pocket/plans/p',
  '- **Type:** phased',
  '',
].join('\n');

// A stacked plan `p` with `phases` phase files, initialized on
// pocket/p/phase-1 from feature/x, with phase-1 moved REVIEW → DONE. With
// `lifecycle`, the spec dir holds a lifecycle document whose phase-1 is
// COMPLETE. closeout.md is written separately by each test.
function makeStackedPlan({ phases = 2, lifecycle = true, strategy = 'stacked', done = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-phase-handoff-'));
  created.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/feature/x');
  git(repo, 'config', 'user.email', 'phase-handoff@example.invalid');
  git(repo, 'config', 'user.name', 'phase-handoff');
  // The CLI commits without the test's -c override, so signing is pinned off locally.
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFile(path.join(repo, 'README.md'), 'root\n');
  writeFile(path.join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'root');

  const planDir = path.join(repo, 'docs', 'pocket', 'plans', 'p');
  const specDir = path.join(repo, 'docs', 'pocket', 'spec', 'p');
  const specBody = '# Approved spec\n';
  writeFile(path.join(specDir, 'approved-spec.md'), specBody);
  writeFile(path.join(planDir, 'execution-plan', 'index.md'), '# Plan Index\n\n**Spec:** ../../spec/p/approved-spec.md\n');
  for (let order = 1; order <= phases; order += 1) {
    writeFile(path.join(planDir, 'execution-plan', `phase-${order}.md`), phaseBody(order));
  }

  okCli(repo, ['log', 'init', planDir, '--phase-branches', strategy]);
  if (lifecycle) {
    okCli(repo, [
      'lifecycle', 'transition', specDir, 'spec-approved',
      '--artifact', `spec:spec-doc:approved-spec.md:${sha256(specBody)}`,
    ]);
  }
  const phaseFile = 'execution-plan/phase-1.md';
  okCli(repo, ['log', 'update', planDir, phaseFile, 'REVIEW']);
  if (done) okCli(repo, ['log', 'update', planDir, phaseFile, 'DONE']);
  return { repo, planDir, specDir, phaseFile };
}

function writeCloseout(planDir, sections) {
  writeFile(path.join(planDir, 'closeout.md'), CLOSEOUT_HEADER + '\n' + sections.join('\n'));
}

function handoff(repo, planDir, phaseFile) {
  return runCli(repo, ['log', 'handoff', planDir, phaseFile]);
}

function snapshotPath(planDir, order = 1) {
  return path.join(planDir, 'reviews', `closeout-phase-${order}.md`);
}

function readLifecycle(specDir) {
  return JSON.parse(fs.readFileSync(path.join(specDir, 'lifecycle.json'), 'utf8'));
}

function readLog(planDir) {
  return JSON.parse(fs.readFileSync(path.join(planDir, 'log.json'), 'utf8'));
}

// Repo-relative paths in HEAD's commit.
function committedFiles(repo) {
  return git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
}

// Commit SHA behind <ref>, or null when the ref does not exist.
function refSha(repo, ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: repo, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// A registered adapter (schema 1, contract 2). The CLI only checks that the
// file exists when deciding dispatch, so no adapter process ever runs here.
function writeRegistration(repo) {
  writeFile(
    path.join(repo, '.pocket', 'lifecycle-adapter.json'),
    JSON.stringify({
      schema: 1,
      adapter_contract: 2,
      argv: ['node', '-e', 'process.exit(0)'],
      events: ['spec-approved', 'phase-complete', 'plan-closed', 'phase-closed'],
      timeout_ms: 30000,
      phase_branches: 'stacked',
    }, null, 2) + '\n',
  );
}

// Replaces the fixture repo's pre-commit hook (copied from the global git
// template by git init) with <body>.
function writeHook(repo, body) {
  const file = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function headState(repo) {
  let branch = '';
  try {
    branch = git(repo, 'symbolic-ref', '--short', '-q', 'HEAD');
  } catch {
    branch = '';
  }
  return { sha: git(repo, 'rev-parse', 'HEAD'), branch };
}

function readOptional(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

// Captures everything a failed precondition must leave untouched.
function captureState({ repo, planDir, specDir }) {
  return {
    lifecycle: readOptional(path.join(specDir, 'lifecycle.json')),
    log: readOptional(path.join(planDir, 'log.json')),
    snapshot: readOptional(snapshotPath(planDir)),
    head: headState(repo),
  };
}

function assertZeroMutation(fixture, before) {
  const afterState = captureState(fixture);
  assert.equal(afterState.snapshot, null, 'no snapshot file may be written');
  assert.deepEqual(afterState.lifecycle, before.lifecycle, 'lifecycle.json must be byte-identical');
  assert.deepEqual(afterState.log, before.log, 'log.json must be byte-identical');
  assert.deepEqual(afterState.head, before.head, 'HEAD must be unchanged');
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'reviews')), false, 'reviews/ must not be created');
}

function phaseClosedEvents(specDir) {
  return readLifecycle(specDir).events.filter((e) => e.type === 'phase-closed');
}

// ─── Cycle 1: happy path snapshot and event ─────────────────────────────────
// RED cycle 1: happy path snapshot and event
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git + lifecycle doc)
// Test intent: Given a stacked two-phase plan, phase-1 DONE, closeout.md with the phase-1 section and no phase-2 marker present, HEAD on `pocket/p/phase-1`, lifecycle `phase-1` COMPLETE / When `log handoff <plan> execution-plan/phase-1.md --json --contract 3` / Then `reviews/closeout-phase-1.md` equals the phase-1 section bytes, lifecycle has one `phase-closed` event referencing it, `plan.phases["phase-2"]` and `log.json` phases[1].branch equal `pocket/p/phase-2` with base `pocket/p/phase-1`, `data.steps.event` is `committed`
// Exercise through: CLI
// Test doubles: none
// Expected RED: unknown subcommand
// Exact command: `node --test --test-name-pattern="handoff snapshot and event" test/phase-handoff.test.js`

test('handoff snapshot and event: records snapshot, phase-closed event, and next-phase identity', () => {
  const fx = makeStackedPlan();
  const section = phaseSection(1, 2);
  writeCloseout(fx.planDir, [section]);
  const before = headState(fx.repo);

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.env.ok, true);
  assert.equal(r.env.command, 'log handoff');

  const snapshot = fs.readFileSync(snapshotPath(fx.planDir), 'utf8');
  const expected = section.slice(section.indexOf('<!-- pocket-closeout:phase-1 -->'));
  assert.equal(snapshot, expected);

  const closed = phaseClosedEvents(fx.specDir);
  assert.equal(closed.length, 1);
  const ref = closed[0].artifact_refs.find((a) => a.kind === 'closeout-snapshot');
  assert.ok(ref, 'phase-closed must reference the closeout snapshot');
  assert.equal(ref.root, 'plan');
  assert.equal(ref.path, 'reviews/closeout-phase-1.md');
  assert.equal(ref.sha256, sha256(fs.readFileSync(snapshotPath(fx.planDir))));
  assert.ok(closed[0].artifact_refs.some((a) => a.kind === 'phase-evidence' && a.path === fx.phaseFile));

  const doc = readLifecycle(fx.specDir);
  assert.deepEqual(doc.plan.phases['phase-2'], { branch: 'pocket/p/phase-2', base_branch: 'pocket/p/phase-1' });
  const log = readLog(fx.planDir);
  assert.equal(log.phases[1].branch, 'pocket/p/phase-2');
  assert.equal(log.phases[1].base_branch, 'pocket/p/phase-1');

  assert.equal(r.env.data.steps.snapshot, 'written');
  assert.equal(r.env.data.steps.event, 'committed');
  assert.equal(r.env.data.steps.commit, 'committed');
  assert.equal(r.env.data.steps.branch, 'created');
  assert.ok(Array.isArray(r.env.data.warnings));
  assert.ok(Array.isArray(r.env.data.next_actions));
  // T8 steps 4-5: one handoff commit, then HEAD moves to the phase-2 branch at it.
  assert.notEqual(headState(fx.repo).sha, before.sha);
  assert.equal(headState(fx.repo).branch, 'pocket/p/phase-2');
});

// Every precondition cycle below asserts the same zero-mutation outcome: no
// snapshot file, lifecycle.json and log.json byte-identical, HEAD unchanged.

function assertRefused(fx, r, code, before) {
  assert.notEqual(r.status, 0, `handoff must fail closed: ${r.stdout}`);
  assert.ok(r.env, `expected a JSON envelope: ${r.stdout}${r.stderr}`);
  assert.equal(r.env.ok, false);
  assert.equal(r.env.error.code, code, r.stdout);
  assertZeroMutation(fx, before);
}

// ─── Cycle 2: phase not DONE ────────────────────────────────────────────────
// RED cycle 2: phase not DONE
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given phase-1 is REVIEW / When handoff runs / Then code `HANDOFF_PHASE_NOT_DONE` and zero mutation
// Exercise through: CLI
// Test doubles: none
// Expected RED: handoff proceeds without a status check
// Exact command: `node --test --test-name-pattern="handoff not done" test/phase-handoff.test.js`

test('handoff not done: a REVIEW phase fails with HANDOFF_PHASE_NOT_DONE and mutates nothing', () => {
  const fx = makeStackedPlan({ done: false });
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  const before = captureState(fx);
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assertRefused(fx, r, 'HANDOFF_PHASE_NOT_DONE', before);
});

// ─── Cycle 3: closeout marker missing ───────────────────────────────────────
// RED cycle 3: closeout marker missing
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given phase-1 DONE but closeout.md lacks `<!-- pocket-closeout:phase-1 -->` / When handoff runs / Then code `HANDOFF_CLOSEOUT_MISSING` and zero mutation
// Exercise through: CLI
// Test doubles: none
// Expected RED: an empty snapshot is written
// Exact command: `node --test --test-name-pattern="handoff closeout missing" test/phase-handoff.test.js`

test('handoff closeout missing: no exact phase-1 marker fails with HANDOFF_CLOSEOUT_MISSING and mutates nothing', () => {
  const fx = makeStackedPlan();
  // A heading for the phase is present, but its exact marker is not.
  writeCloseout(fx.planDir, ['## Phase 1 of 2 — Fixture phase 1\n\nNo marker here.\n']);
  const before = captureState(fx);
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assertRefused(fx, r, 'HANDOFF_CLOSEOUT_MISSING', before);
});

// ─── Cycle 4: wrong branch ──────────────────────────────────────────────────
// RED cycle 4: wrong branch
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given HEAD on `feature/x` instead of `pocket/p/phase-1` / When handoff runs / Then code `PHASE_BRANCH_MISMATCH` and zero mutation
// Exercise through: CLI
// Test doubles: none
// Expected RED: branch is not checked
// Exact command: `node --test --test-name-pattern="handoff wrong branch" test/phase-handoff.test.js`

test('handoff wrong branch: HEAD on feature/x fails with PHASE_BRANCH_MISMATCH and mutates nothing', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  git(fx.repo, 'switch', '-q', 'feature/x');
  const before = captureState(fx);
  assert.equal(before.head.branch, 'feature/x');
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assertRefused(fx, r, 'PHASE_BRANCH_MISMATCH', before);
});

// ─── Cycle 5: Handoff refuses foreign dirty paths ───────────────────────────
// RED cycle 5: Handoff refuses foreign dirty paths
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given `src/app.js` modified / When handoff runs / Then code `DIRTY_OUTSIDE_PLAN`, message names `src/app.js`, zero mutation
// Exercise through: CLI
// Test doubles: none
// Expected RED: dirty paths are not checked
// Exact command: `node --test --test-name-pattern="handoff foreign dirty" test/phase-handoff.test.js`

test('handoff foreign dirty: a modified src/app.js fails with DIRTY_OUTSIDE_PLAN naming it and mutates nothing', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeFile(path.join(fx.repo, 'src', 'app.js'), 'module.exports = 2;\n');
  const before = captureState(fx);
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assertRefused(fx, r, 'DIRTY_OUTSIDE_PLAN', before);
  assert.match(r.env.error.message, /src\/app\.js/);
});

// ─── Cycle 6: active parallel worktrees ─────────────────────────────────────
// RED cycle 6: active parallel worktrees
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given an extra worktree created with `git worktree add` / When handoff runs / Then code `HANDOFF_WORKTREES_ACTIVE` and zero mutation
// Exercise through: CLI
// Test doubles: none
// Expected RED: worktrees are not checked
// Exact command: `node --test --test-name-pattern="handoff worktrees active" test/phase-handoff.test.js`

test('handoff worktrees active: a registered extra worktree fails with HANDOFF_WORKTREES_ACTIVE and mutates nothing', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  // Same location and exclude rule the pocket-development parallel group uses.
  fs.mkdirSync(path.join(fx.repo, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(fx.repo, '.git', 'info', 'exclude'), '.worktree/\n');
  git(fx.repo, 'worktree', 'add', '-q', path.join('.worktree', 'T1'), '-b', 'task/T1');
  const before = captureState(fx);
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assertRefused(fx, r, 'HANDOFF_WORKTREES_ACTIVE', before);
});

// Issue #78: worktree ownership, not the total count, controls handoff.
// These tests catch broad refusals, AND instead of OR matching, path-prefix
// collisions, lost branch/path metadata, and warning replacement.
function extraWorktree(fx, { relativePath = null, branch = null } = {}) {
  const location = relativePath
    ? path.join(fx.repo, relativePath)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-handoff-extra-'));
  if (relativePath) {
    fs.mkdirSync(path.join(fx.repo, '.git', 'info'), { recursive: true });
    fs.appendFileSync(path.join(fx.repo, '.git', 'info', 'exclude'), `${relativePath.split(path.sep)[0]}/\n`);
  } else {
    created.push(location);
  }
  const args = branch ? ['-b', branch] : ['--detach'];
  git(fx.repo, 'worktree', 'add', '-q', location, ...args);
  return fs.realpathSync(location);
}

for (const entry of [
  { name: 'foreign branch', branch: 'unrelated/session', relativePath: null },
  { name: 'detached HEAD', branch: null, relativePath: null },
  { name: 'near-prefix directory', branch: 'feature/near', relativePath: '.worktree-other/T1' },
  { name: 'DEL and C1 metadata', branch: 'feature/\u009b31m', relativePath: 'foreign worktrees/T1\u007f\u0085\u009b\u2028\u2029' },
  { name: 'path with spaces and newline', branch: 'feature/path', relativePath: 'foreign worktrees/T1\nbranch refs/heads/task/fake' },
]) {
  test(`handoff worktree ownership: ${entry.name} succeeds with a warning and leaves the worktree unchanged`, () => {
    const fx = makeStackedPlan();
    writeCloseout(fx.planDir, [phaseSection(1, 2)]);
    const location = extraWorktree(fx, entry);
    const before = headState(location);
    const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.env.data.warnings.filter((w) => w.code === 'HANDOFF_FOREIGN_WORKTREE'), [
      { code: 'HANDOFF_FOREIGN_WORKTREE', path: location, branch: entry.branch },
    ]);
    assert.deepEqual(headState(location), before);
    assert.equal(git(location, 'status', '--porcelain'), '');
    assert.equal(phaseClosedEvents(fx.specDir).length, 1);
    assert.equal(headState(fx.repo).branch, 'pocket/p/phase-2');
  });
}

for (const scenario of [
  { name: 'foreign branch and detached HEAD', entries: [{ branch: 'feature/human' }, { branch: null }] },
  { name: 'escaped newline and terminal control', entries: [{ branch: 'feature/path', relativePath: 'foreign worktrees/T1\nunsafe\x1b[31m' }] },
  {
    name: 'escaped DEL C1 and Unicode separators',
    entries: [{
      branch: 'feature/\u009b31m', relativePath: 'foreign worktrees/T1\u007f\u0085\u009b\u2028\u2029',
      branchText: 'feature/\\u009b31m', pathText: 'foreign worktrees/T1\\u007f\\u0085\\u009b\\u2028\\u2029',
    }],
  },
  { name: 'no foreign worktrees', entries: [] },
]) {
  test(`handoff human warnings: ${scenario.name}`, () => {
    const fx = makeStackedPlan();
    writeCloseout(fx.planDir, [phaseSection(1, 2)]);
    const extras = scenario.entries.map((entry) => {
      const location = extraWorktree(fx, entry);
      return { ...entry, location, before: headState(location) };
    });
    const r = runCli(fx.repo, ['log', 'handoff', fx.planDir, fx.phaseFile], { json: false });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'Handed off execution-plan/phase-1.md (phase-1)');
    assert.match(lines[1], /^  snapshot : reviews\/closeout-phase-1\.md \(written\)$/);
    assert.equal(lines[2], '  event    : committed');
    assert.equal(lines[3], '  commit   : committed');
    assert.equal(lines[4], '  branch   : created');
    const warnings = lines.slice(5);
    assert.equal(warnings.length, extras.length, 'each foreign worktree must have one human warning');
    extras.forEach(({ location, branch, branchText, pathText, before }) => {
      const expectedBranch = branch === null ? 'detached HEAD' : (branchText || branch);
      const matches = warnings.filter((line) => line.includes(expectedBranch));
      assert.equal(matches.length, 1, 'each branch must appear in exactly one warning');
      const warning = matches[0];
      assert.match(warning, /warning/i);
      assert.match(warning, /registered/i);
      if (pathText) {
        assert.ok(warning.includes(pathText), warning);
        assert.doesNotMatch(r.stdout, /[\u007f-\u009f\u2028\u2029]/, 'human output must escape DEL/C1 and line separators');
      } else if (location.includes('\n')) {
        assert.ok(warning.includes('foreign worktrees/T1\\nunsafe\\u001b[31m'), warning);
        assert.ok(!r.stdout.includes(location), 'path must not contain a raw newline');
        assert.ok(!r.stdout.includes('\x1b'), 'path must not inject a terminal escape');
      } else {
        assert.ok(warning.includes(location), warning);
      }
      assert.ok(warning.includes(expectedBranch), warning);
      assert.deepEqual(headState(location), before);
    });
    assert.equal(headState(fx.repo).branch, 'pocket/p/phase-2');
  });
}

for (const entry of [
  { name: 'path-only blocker', branch: 'feature/inside', relativePath: '.worktree/T9' },
  { name: 'branch-only blocker', branch: 'task/T9', relativePath: null },
]) {
  test(`handoff worktree ownership: ${entry.name} refuses with zero mutation`, () => {
    const fx = makeStackedPlan();
    writeCloseout(fx.planDir, [phaseSection(1, 2)]);
    const location = extraWorktree(fx, entry);
    const before = captureState(fx);
    const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
    assertRefused(fx, r, 'HANDOFF_WORKTREES_ACTIVE', before);
    assert.deepEqual(r.env.error.details.worktrees, [location]);
  });
}

test('handoff worktree ownership: mixed worktrees report only the blocking worktree', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  extraWorktree(fx, { branch: 'feature/foreign' });
  const blocker = extraWorktree(fx, { branch: 'task/T9' });
  const before = captureState(fx);
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assertRefused(fx, r, 'HANDOFF_WORKTREES_ACTIVE', before);
  assert.deepEqual(r.env.error.details.worktrees, [blocker]);
});

test('handoff worktree ownership: warnings compose with ignored artifact warnings', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeFile(path.join(fx.repo, '.gitignore'), 'docs/pocket/\n');
  git(fx.repo, 'add', '--', '.gitignore');
  git(fx.repo, 'add', '-f', '--', 'docs/pocket/plans/p/log.json', 'docs/pocket/plans/p/closeout.md');
  git(fx.repo, 'commit', '-q', '-m', 'track forced artifacts');
  const location = extraWorktree(fx, { branch: 'feature/foreign' });
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.env.data.warnings.find((w) => w.code === 'HANDOFF_FOREIGN_WORKTREE'), {
    code: 'HANDOFF_FOREIGN_WORKTREE', path: location, branch: 'feature/foreign',
  });
  const artifactWarning = r.env.data.warnings.find((w) => w.code === 'POCKET_ARTIFACTS_IGNORED');
  assert.ok(artifactWarning && artifactWarning.paths.some((p) => p.endsWith('reviews/closeout-phase-1.md')));
});

test('handoff worktree ownership: linked checkout uses the main worktree directory for path blockers', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  git(fx.repo, 'add', '-A');
  git(fx.repo, 'commit', '-q', '-m', 'persist plan for linked checkout');
  git(fx.repo, 'switch', '-q', 'feature/x');
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-handoff-linked-'));
  created.push(linked);
  git(fx.repo, 'worktree', 'add', '-q', linked, 'pocket/p/phase-1');
  const blocker = extraWorktree(fx, { branch: 'feature/inside', relativePath: '.worktree/T9' });
  const linkedFx = {
    repo: linked,
    planDir: path.join(linked, 'docs/pocket/plans/p'),
    specDir: path.join(linked, 'docs/pocket/spec/p'),
    phaseFile: fx.phaseFile,
  };
  const before = captureState(linkedFx);
  const r = handoff(linkedFx.repo, linkedFx.planDir, linkedFx.phaseFile);
  assertRefused(linkedFx, r, 'HANDOFF_WORKTREES_ACTIVE', before);
  assert.deepEqual(r.env.error.details.worktrees, [blocker]);
});

test('handoff worktree ownership: listing failure refuses before mutation', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  const before = captureState(fx);
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-handoff-git-shim-'));
  created.push(shimDir);
  // Only listing fails: branch and other preconditions still use real git.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shim = path.join(shimDir, 'git');
  writeFile(shim, '#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = list ]; then exit 1; fi\nexec "$POCKET_TEST_REAL_GIT" "$@"\n');
  fs.chmodSync(shim, 0o755);
  const r = runCli(fx.repo, ['log', 'handoff', fx.planDir, fx.phaseFile], {
    envOverride: {
      ...process.env, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK,
      POCKET_TEST_REAL_GIT: realGit, PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
    },
  });
  assertRefused(fx, r, 'HANDOFF_WORKTREES_ACTIVE', before);
  assert.match(r.env.error.message, /Could not list git worktrees/);
});

// ─── Cycle 7: non-stacked plan ──────────────────────────────────────────────
// RED cycle 7: non-stacked plan
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given a plan initialized with strategy none / When handoff runs / Then code `HANDOFF_NOT_STACKED` and zero mutation
// Exercise through: CLI
// Test doubles: none
// Expected RED: handoff runs for none plans
// Exact command: `node --test --test-name-pattern="handoff not stacked" test/phase-handoff.test.js`

test('handoff not stacked: a plan initialized with none fails with HANDOFF_NOT_STACKED and mutates nothing', () => {
  const fx = makeStackedPlan({ strategy: 'none' });
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  const before = captureState(fx);
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assertRefused(fx, r, 'HANDOFF_NOT_STACKED', before);
});

// ─── Cycle 8: Closeout snapshot survives later appends ──────────────────────
// RED cycle 8: Closeout snapshot survives later appends
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given phase-1 handed off / When phase-2's section is appended to closeout.md and handoff for phase-1 is rerun / Then the snapshot bytes are unchanged, no second event is appended, and `validateArtifactOnDisk` accepts the phase-1 event's snapshot ref
// Exercise through: CLI + `cli/lib/lifecycle-artifact-validation.js:validateArtifactOnDisk`
// Test doubles: none
// Expected RED: rerun rewrites the snapshot from the grown closeout.md, so the ref hash goes stale
// Exact command: `node --test --test-name-pattern="handoff snapshot survives appends" test/phase-handoff.test.js`

test('handoff snapshot survives appends: a rerun after phase-2 is appended keeps the snapshot and event valid', () => {
  const { validateArtifactOnDisk } = require('../cli/lib/lifecycle-artifact-validation');
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  const first = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const snapshotBytes = fs.readFileSync(snapshotPath(fx.planDir));

  fs.appendFileSync(path.join(fx.planDir, 'closeout.md'), '\n' + phaseSection(2, 2));
  // A completed handoff leaves HEAD on phase-2; the rerun is the resumable
  // state (HEAD on phase-1 at the handoff commit), so return to phase-1 first.
  git(fx.repo, 'switch', '-q', 'pocket/p/phase-1');
  const rerun = handoff(fx.repo, fx.planDir, fx.phaseFile);

  assert.deepEqual(fs.readFileSync(snapshotPath(fx.planDir)), snapshotBytes, 'snapshot must not be rewritten');
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.equal(rerun.env.data.steps.snapshot, 'verified');
  assert.equal(rerun.env.data.steps.event, 'replayed');
  const closed = phaseClosedEvents(fx.specDir);
  assert.equal(closed.length, 1, 'no second phase-closed event');
  const ref = closed[0].artifact_refs.find((a) => a.kind === 'closeout-snapshot');
  assert.deepEqual(validateArtifactOnDisk(ref, fx.planDir), { ok: true, code: null, message: null });
});

// ─── Cycle 9: hand-edited snapshot ──────────────────────────────────────────
// RED cycle 9: hand-edited snapshot
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given phase-1 handed off and its snapshot edited by hand / When handoff reruns / Then code `HANDOFF_SNAPSHOT_CONFLICT`, snapshot left as edited, no event appended
// Exercise through: CLI
// Test doubles: none
// Expected RED: the snapshot is silently overwritten
// Exact command: `node --test --test-name-pattern="handoff snapshot conflict" test/phase-handoff.test.js`

test('handoff snapshot conflict: a hand-edited snapshot fails with HANDOFF_SNAPSHOT_CONFLICT and is left as edited', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  const first = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  // Rerun from the phase-1 branch, the resumable state (see the snapshot-survives test).
  git(fx.repo, 'switch', '-q', 'pocket/p/phase-1');

  const edited = fs.readFileSync(snapshotPath(fx.planDir), 'utf8') + 'Hand-written note.\n';
  fs.writeFileSync(snapshotPath(fx.planDir), edited);
  const lifecycleBefore = fs.readFileSync(path.join(fx.specDir, 'lifecycle.json'));
  const logBefore = fs.readFileSync(path.join(fx.planDir, 'log.json'));
  const headBefore = headState(fx.repo);

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.env.error.code, 'HANDOFF_SNAPSHOT_CONFLICT', r.stdout);
  assert.equal(fs.readFileSync(snapshotPath(fx.planDir), 'utf8'), edited, 'snapshot must stay as edited');
  assert.deepEqual(fs.readFileSync(path.join(fx.specDir, 'lifecycle.json')), lifecycleBefore, 'no event appended');
  assert.deepEqual(fs.readFileSync(path.join(fx.planDir, 'log.json')), logBefore);
  assert.deepEqual(headState(fx.repo), headBefore);
  assert.equal(phaseClosedEvents(fx.specDir).length, 1);
});

// ─── Cycle 10: exact marker extraction (phase 1 vs phase 10) ────────────────
// RED cycle 10: exact marker extraction (phase 1 vs phase 10)
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given a ten-phase stacked plan whose closeout.md holds `phase-1` and `phase-10` sections / When handoff for phase 1 runs / Then the snapshot contains the phase-1 section only and none of the phase-10 text
// Exercise through: CLI
// Test doubles: none
// Expected RED: extraction by substring match includes phase-10 content
// Exact command: `node --test --test-name-pattern="handoff exact marker" test/phase-handoff.test.js`

test('handoff exact marker: phase-1 extraction never picks up the phase-10 section', () => {
  const fx = makeStackedPlan({ phases: 10 });
  // The phase-10 section comes first, so a prefix match on
  // "pocket-closeout:phase-1" would land on the phase-10 marker.
  writeCloseout(fx.planDir, [phaseSection(10, 10), phaseSection(1, 10)]);
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const snapshot = fs.readFileSync(snapshotPath(fx.planDir), 'utf8');
  assert.ok(snapshot.startsWith('<!-- pocket-closeout:phase-1 -->\n'), snapshot);
  assert.match(snapshot, /P1X/);
  assert.doesNotMatch(snapshot, /phase-10|P10X|Phase 10/);
});

// ─── Cycle 11: handoff without a lifecycle document ─────────────────────────
// RED cycle 11: handoff without a lifecycle document
// Test file: `test/phase-handoff.test.js`
// Level: integration
// Test intent: Given a stacked plan with no `lifecycle.json` / When handoff runs for phase-1 / Then exit 0, `data.steps.event` is `skipped`, no lifecycle file is created, the snapshot exists, and `log.json` phases[1] has branch `pocket/p/phase-2` and base `pocket/p/phase-1`
// Exercise through: CLI
// Test doubles: none
// Expected RED: the event step throws LIFECYCLE_NOT_FOUND
// Exact command: `node --test --test-name-pattern="handoff without lifecycle" test/phase-handoff.test.js`

test('handoff without lifecycle: skips the event, creates no lifecycle file, and still mirrors the next identity', () => {
  const fx = makeStackedPlan({ lifecycle: false });
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.env.data.steps.event, 'skipped');
  assert.equal(fs.existsSync(path.join(fx.specDir, 'lifecycle.json')), false, 'no lifecycle file is created');
  assert.ok(fs.existsSync(snapshotPath(fx.planDir)), 'snapshot exists');
  const log = readLog(fx.planDir);
  assert.equal(log.phases[1].branch, 'pocket/p/phase-2');
  assert.equal(log.phases[1].base_branch, 'pocket/p/phase-1');
});

// ─── T8 Cycle 1: commit then branch ─────────────────────────────────────────
// RED cycle 1 (T8): commit then branch
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git + lifecycle doc)
// Test intent: Given T7's happy-path state with plan artifacts tracked / When handoff runs / Then HEAD^ … HEAD has one new commit with subject `chore(pocket): close p phase-1` and trailer `Pocket-Handoff: p/phase-1` containing only plan/spec paths, HEAD is now `pocket/p/phase-2` at that commit, `data.branch.created` is `pocket/p/phase-2`, `data.next_actions` contains the drain when a registration exists
// Exercise through: CLI
// Test doubles: none
// Expected RED: steps 4–5 pending
// Exact command: `node --test --test-name-pattern="handoff commit and branch" test/phase-handoff.test.js`

test('handoff commit and branch: commits plan artifacts with the trailer, then creates and switches to phase-2', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeRegistration(fx.repo);
  const before = headState(fx.repo);

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const head = headState(fx.repo).sha;
  assert.notEqual(head, before.sha, 'the handoff must add one commit');
  assert.equal(git(fx.repo, 'rev-list', '--count', `${before.sha}..HEAD`), '1');
  assert.equal(git(fx.repo, 'log', '-1', '--format=%s'), 'chore(pocket): close p phase-1');
  assert.equal(git(fx.repo, 'log', '-1', '--format=%(trailers:key=Pocket-Handoff,valueonly)'), 'p/phase-1');

  const files = committedFiles(fx.repo);
  assert.ok(files.includes('docs/pocket/plans/p/log.json'), files.join('\n'));
  assert.ok(files.includes('docs/pocket/spec/p/lifecycle.json'), files.join('\n'));
  assert.ok(files.every((f) => f.startsWith('docs/pocket/plans/p/') || f.startsWith('docs/pocket/spec/p/')), files.join('\n'));
  assert.equal(git(fx.repo, 'ls-files', '.pocket'), '', 'the machine-local registration must never be tracked');

  assert.deepEqual(headState(fx.repo), { sha: head, branch: 'pocket/p/phase-2' });
  assert.equal(refSha(fx.repo, 'refs/heads/pocket/p/phase-2'), head);
  assert.equal(r.env.data.branch.created, 'pocket/p/phase-2');
  assert.equal(r.env.data.steps.commit, 'committed');
  assert.equal(r.env.data.steps.branch, 'created');
  assert.ok(
    r.env.data.next_actions.some((a) => a.required === true && a.command.includes('lifecycle drain')),
    JSON.stringify(r.env.data.next_actions),
  );
});

// ─── T8 Cycle 2: handoff staged work ────────────────────────────────────────
// RED cycle 2 (T8): handoff refuses user-staged work
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git)
// Test intent: Given T7's happy-path state plus `src/app.js` staged / When handoff reaches the commit step / Then code `STAGED_OUTSIDE_PLAN` naming `src/app.js`, no new commit, HEAD still on `pocket/p/phase-1`, `src/app.js` still staged
// Exercise through: CLI
// Test doubles: none
// Expected RED (packet): the staged file is committed with the plan artifacts
// Exact command: `node --test --test-name-pattern="handoff staged work" test/phase-handoff.test.js`

test('handoff staged work: user-staged src/app.js fails with STAGED_OUTSIDE_PLAN and nothing is committed', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeFile(path.join(fx.repo, 'src', 'app.js'), 'module.exports = 2;\n');
  git(fx.repo, 'add', '--', 'src/app.js');
  const before = captureState(fx);

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assertRefused(fx, r, 'STAGED_OUTSIDE_PLAN', before);
  assert.match(r.env.error.message, /src\/app\.js/);
  assert.equal(headState(fx.repo).branch, 'pocket/p/phase-1');
  assert.deepEqual(git(fx.repo, 'diff', '--cached', '--name-only').split('\n'), ['src/app.js']);
});

// ─── T8 Cycle 3: pre-commit hook fails ──────────────────────────────────────
// RED cycle 3 (T8): pre-commit hook fails
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git hook)
// Test intent: Given a pre-commit hook that prints `blocked` and exits 1 / When handoff runs / Then code `HANDOFF_COMMIT_FAILED`, message includes `blocked` and a rerun instruction, no new commit, no branch switch
// Exercise through: CLI
// Test doubles: none (real hook script)
// Expected RED: hook failure is not surfaced and the branch step still runs
// Exact command: `node --test --test-name-pattern="handoff hook fails" test/phase-handoff.test.js`

test('handoff hook fails: a rejecting pre-commit hook fails with HANDOFF_COMMIT_FAILED and no commit or switch', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeHook(fx.repo, '#!/bin/sh\necho blocked\nexit 1\n');
  const before = headState(fx.repo);

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.env.ok, false);
  assert.equal(r.env.error.code, 'HANDOFF_COMMIT_FAILED', r.stdout);
  assert.match(r.env.error.message, /blocked/);
  assert.match(r.env.error.message, /rerun/i);
  assert.deepEqual(headState(fx.repo), before, 'no commit and no branch switch');
});

// ─── T8 Cycle 4: handoff commit is not duplicated ───────────────────────────
// RED cycle 4 (T8): handoff no duplicate commit
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git)
// Test intent: Given a completed handoff commit carrying `Pocket-Handoff: p/phase-1`, then HEAD on `pocket/p/phase-1` and branch `pocket/p/phase-2` absent / When handoff reruns / Then the commit count on `pocket/p/phase-1` is unchanged and `pocket/p/phase-2` is created at that commit
// Exercise through: CLI
// Test doubles: none
// Expected RED: a second commit is attempted (or fails as empty) instead of recognizing the trailer
// Exact command: `node --test --test-name-pattern="handoff no duplicate commit" test/phase-handoff.test.js`

test('handoff no duplicate commit: a HEAD commit carrying the trailer is recognized and phase-2 is created at it', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  // The state a completed handoff commit leaves behind: HEAD on phase-1 with the
  // trailer, and no phase-2 branch yet.
  git(fx.repo, 'add', '--', 'docs/pocket/plans/p', 'docs/pocket/spec/p');
  git(fx.repo, 'commit', '-q', '-m', 'chore(pocket): close p phase-1', '-m', 'Pocket-Handoff: p/phase-1');
  const handoffSha = git(fx.repo, 'rev-parse', 'HEAD');
  const commitsBefore = git(fx.repo, 'rev-list', '--count', 'HEAD');

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.env.data.steps.commit, 'already');
  assert.equal(git(fx.repo, 'rev-list', '--count', 'pocket/p/phase-1'), commitsBefore, 'no second handoff commit');
  assert.equal(refSha(fx.repo, 'refs/heads/pocket/p/phase-2'), handoffSha);
  assert.deepEqual(headState(fx.repo), { sha: handoffSha, branch: 'pocket/p/phase-2' });
});

// ─── T8 Cycle 5: partially force-tracked plan ───────────────────────────────
// RED cycle 5 (T8): Partially force-tracked plan
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git)
// Test intent: Given `docs/pocket/` ignored with only `log.json` and `closeout.md` force-tracked / When handoff runs / Then the commit contains exactly those two files (plus `lifecycle.json` if force-tracked), `data.warnings` lists `reviews/closeout-phase-1.md` as ignored and skipped
// Exercise through: CLI
// Test doubles: none
// Expected RED (packet): `git add` of the ignored snapshot fails or the warning is missing. Observed on T7 code: the warning is already present (T4); the missing piece is the commit-level `skipped` report.
// Exact command: `node --test --test-name-pattern="handoff partially tracked" test/phase-handoff.test.js`

test('handoff partially tracked: ignored artifacts are skipped and reported, force-tracked ones are committed', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeFile(path.join(fx.repo, '.gitignore'), 'docs/pocket/\n');
  git(fx.repo, 'add', '--', '.gitignore');
  git(fx.repo, 'add', '-f', '--', 'docs/pocket/plans/p/log.json', 'docs/pocket/plans/p/closeout.md');
  git(fx.repo, 'commit', '-q', '-m', 'track forced artifacts');

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const files = committedFiles(fx.repo);
  const allowed = [
    'docs/pocket/plans/p/log.json',
    'docs/pocket/plans/p/closeout.md',
    'docs/pocket/spec/p/lifecycle.json',
  ];
  assert.ok(files.includes('docs/pocket/plans/p/log.json'), files.join('\n'));
  assert.ok(files.every((f) => allowed.includes(f)), files.join('\n'));

  const warning = r.env.data.warnings.find((w) => w.code === 'POCKET_ARTIFACTS_IGNORED');
  assert.ok(warning && warning.paths.some((p) => p.endsWith('reviews/closeout-phase-1.md')), JSON.stringify(r.env.data.warnings));
  assert.ok(
    r.env.data.commit.skipped.includes('docs/pocket/plans/p/reviews/closeout-phase-1.md'),
    JSON.stringify(r.env.data.commit),
  );
});

// ─── T8 Cycle 6: nothing committable ────────────────────────────────────────
// RED cycle 6 (T8): handoff nothing committable
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git)
// Test intent: Given every plan artifact ignored and untracked / When handoff runs / Then `data.steps.commit` is `skipped`, no commit is created, and `pocket/p/phase-2` is still created and checked out
// Exercise through: CLI
// Test doubles: none
// Expected RED: an empty commit is attempted and fails
// Exact command: `node --test --test-name-pattern="handoff nothing committable" test/phase-handoff.test.js`

test('handoff nothing committable: all plan artifacts ignored, commit skipped and phase-2 still created', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeFile(path.join(fx.repo, '.gitignore'), 'docs/pocket/\n');
  git(fx.repo, 'add', '--', '.gitignore');
  git(fx.repo, 'commit', '-q', '-m', 'ignore plan artifacts');
  const headSha = git(fx.repo, 'rev-parse', 'HEAD');
  const commitsBefore = git(fx.repo, 'rev-list', '--count', 'HEAD');

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.env.data.steps.commit, 'skipped');
  assert.equal(git(fx.repo, 'rev-list', '--count', 'pocket/p/phase-1'), commitsBefore, 'no commit is created');
  assert.deepEqual(headState(fx.repo), { sha: headSha, branch: 'pocket/p/phase-2' });
  assert.equal(refSha(fx.repo, 'refs/heads/pocket/p/phase-2'), headSha);
});

// ─── T8 Cycle 7: last phase ─────────────────────────────────────────────────
// RED cycle 7 (T8): handoff last phase
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git + lifecycle doc)
// Test intent: Given the final phase DONE with its closeout section / When handoff runs / Then `data.branch.status` is `none`, no new branch exists, and the phase-closed event revision is lower than any later `plan-closed` revision after `log close`
// Exercise through: CLI
// Test doubles: none
// Expected RED: handoff tries to create `phase-<count+1>`
// Exact command: `node --test --test-name-pattern="handoff last phase" test/phase-handoff.test.js`

test('handoff last phase: the final phase creates no branch and its phase-closed event precedes plan-closed', () => {
  const fx = makeStackedPlan({ phases: 1 });
  writeCloseout(fx.planDir, [phaseSection(1, 1)]);

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.env.data.branch.status, 'none');
  assert.equal(r.env.data.steps.branch, 'none');
  assert.equal(git(fx.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/pocket/'), 'refs/heads/pocket/p/phase-1');
  assert.equal(headState(fx.repo).branch, 'pocket/p/phase-1');

  okCli(fx.repo, ['log', 'close', fx.planDir]);
  const events = readLifecycle(fx.specDir).events;
  const phaseClosed = events.find((e) => e.type === 'phase-closed');
  const planClosed = events.find((e) => e.type === 'plan-closed');
  assert.ok(phaseClosed, 'phase-closed recorded');
  assert.ok(planClosed, 'plan-closed recorded after log close');
  assert.ok(phaseClosed.revision < planClosed.revision, `${phaseClosed.revision} must precede ${planClosed.revision}`);
});

// ─── T8 Cycle 8: branch name collision ──────────────────────────────────────
// RED cycle 8 (T8): handoff branch collision
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git + lifecycle doc)
// Test intent: Given `pocket/p/phase-2` already exists at a different SHA / When handoff reaches the branch step / Then code `HANDOFF_BRANCH_CONFLICT` with the manual action, the phase-closed event remains recorded, HEAD stays on `pocket/p/phase-1`
// Exercise through: CLI
// Test doubles: none
// Expected RED: `GIT_BRANCH_EXISTS` leaks unclassified or the existing branch is adopted
// Exact command: `node --test --test-name-pattern="handoff branch collision" test/phase-handoff.test.js`

test('handoff branch collision: an existing pocket/p/phase-2 at another SHA fails with HANDOFF_BRANCH_CONFLICT after the event', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  // pocket/p/phase-2 already exists, pointing at a commit that is not the handoff commit.
  git(fx.repo, 'switch', '-q', '-c', 'side');
  writeFile(path.join(fx.repo, 'src', 'side.js'), 'module.exports = 3;\n');
  git(fx.repo, 'add', '--', 'src/side.js');
  git(fx.repo, 'commit', '-q', '-m', 'side');
  const sideSha = git(fx.repo, 'rev-parse', 'HEAD');
  git(fx.repo, 'branch', 'pocket/p/phase-2', sideSha);
  git(fx.repo, 'switch', '-q', 'pocket/p/phase-1');

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.env.error.code, 'HANDOFF_BRANCH_CONFLICT', r.stdout);
  assert.match(r.env.error.message, /git branch -m pocket\/p\/phase-2/);
  assert.equal(headState(fx.repo).branch, 'pocket/p/phase-1');
  assert.equal(refSha(fx.repo, 'refs/heads/pocket/p/phase-2'), sideSha, 'the existing branch is neither adopted nor moved');
  assert.equal(phaseClosedEvents(fx.specDir).length, 1, 'the phase-closed event stays recorded');
});

// ─── T8 Cycle 9: commit timeout ─────────────────────────────────────────────
// RED cycle 9 (T8): handoff commit timeout
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git hook)
// Test intent: Given a pre-commit hook that sleeps longer than the handoff timeout (timeout lowered with `POCKETTO_HANDOFF_COMMIT_TIMEOUT_MS=300`) / When handoff runs / Then code `HANDOFF_COMMIT_TIMEOUT`, the message contains the exact manual `git commit` command with the trailer, no commit, no branch switch
// Exercise through: CLI
// Test doubles: none
// Expected RED: the T1 `GIT_COMMIT_TIMEOUT` leaks unmapped and without manual instructions
// Exact command: `node --test --test-name-pattern="handoff commit timeout" test/phase-handoff.test.js`

test('handoff commit timeout: a hook slower than the timeout fails with HANDOFF_COMMIT_TIMEOUT and the manual commit command', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeHook(fx.repo, '#!/bin/sh\nexec sleep 3\n');
  const before = headState(fx.repo);

  const r = runCli(fx.repo, ['log', 'handoff', fx.planDir, fx.phaseFile], {
    envOverride: { ...process.env, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, POCKETTO_HANDOFF_COMMIT_TIMEOUT_MS: '300' },
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.env.error.code, 'HANDOFF_COMMIT_TIMEOUT', r.stdout);
  assert.ok(
    r.env.error.message.includes('git commit -m "chore(pocket): close p phase-1" -m "Pocket-Handoff: p/phase-1"'),
    r.env.error.message,
  );
  assert.deepEqual(headState(fx.repo), before, 'no commit and no branch switch');
  assert.equal(fs.existsSync(path.join(fx.repo, '.git', 'index.lock')), false, 'a killed commit must not leave index.lock behind');
});

// ─── T8 Cycle 10: missing git identity ──────────────────────────────────────
// RED cycle 10 (T8): handoff git identity
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git, isolated config)
// Test intent: Given the temp repo with `user.email` unset (isolated `HOME`/`GIT_CONFIG_GLOBAL`, local config cleared) / When handoff runs / Then code `HANDOFF_GIT_IDENTITY` with the `git config user.email` remedy, no commit, no branch switch
// Exercise through: CLI
// Test doubles: none (isolated git config via environment)
// Expected RED: git's identity error surfaces as a generic commit failure
// Exact command: `node --test --test-name-pattern="handoff git identity" test/phase-handoff.test.js`

test('handoff git identity: no user.email fails with HANDOFF_GIT_IDENTITY and the git config remedy', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  git(fx.repo, 'config', '--unset', 'user.email');
  git(fx.repo, 'config', '--unset', 'user.name');
  // An isolated global config that refuses to invent an identity, and no
  // system or env-provided identity.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-phase-handoff-home-'));
  created.push(home);
  const globalConfig = path.join(home, 'gitconfig');
  writeFile(globalConfig, '[user]\n\tuseConfigOnly = true\n');
  const env = { ...process.env, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['EMAIL', 'NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) delete env[key];
  const before = headState(fx.repo);

  const r = runCli(fx.repo, ['log', 'handoff', fx.planDir, fx.phaseFile], { envOverride: env });
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.env.error.code, 'HANDOFF_GIT_IDENTITY', r.stdout);
  assert.match(r.env.error.message, /git config user\.email/);
  assert.deepEqual(headState(fx.repo), before, 'no commit and no branch switch');
});

// ─── T8 Cycle 11: hook leaves files dirty ───────────────────────────────────
// RED cycle 11 (T8): handoff dirty after commit
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git hook)
// Test intent: Given a pre-commit hook that exits 0 but writes `src/generated.txt` / When handoff runs / Then the commit exists, code `HANDOFF_DIRTY_AFTER_COMMIT` names `src/generated.txt`, and no branch switch happens; When rerun after the user removes the file / Then no second commit and the branch is created
// Exercise through: CLI
// Test doubles: none
// Expected RED: the branch step runs and carries the dirty file into the next phase
// Exact command: `node --test --test-name-pattern="handoff dirty after commit" test/phase-handoff.test.js`

test('handoff dirty after commit: a hook that leaves a file dirty fails with HANDOFF_DIRTY_AFTER_COMMIT, and a rerun after cleanup branches', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeHook(fx.repo, '#!/bin/sh\necho generated > src/generated.txt\nexit 0\n');
  const before = headState(fx.repo);

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.env.error.code, 'HANDOFF_DIRTY_AFTER_COMMIT', r.stdout);
  assert.match(r.env.error.message, /src\/generated\.txt/);
  const committed = refSha(fx.repo, 'HEAD');
  assert.notEqual(committed, before.sha, 'the handoff commit exists');
  assert.equal(git(fx.repo, 'log', '-1', '--format=%(trailers:key=Pocket-Handoff,valueonly)'), 'p/phase-1');
  assert.deepEqual(headState(fx.repo), { sha: committed, branch: 'pocket/p/phase-1' }, 'no branch switch');
  assert.equal(refSha(fx.repo, 'refs/heads/pocket/p/phase-2'), null, 'phase-2 is not created');

  // The user removes the stray file and the hook, then reruns.
  fs.rmSync(path.join(fx.repo, 'src', 'generated.txt'));
  fs.rmSync(path.join(fx.repo, '.git', 'hooks', 'pre-commit'));
  const rerun = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.equal(rerun.env.data.steps.commit, 'already');
  assert.deepEqual(headState(fx.repo), { sha: committed, branch: 'pocket/p/phase-2' });
  assert.equal(refSha(fx.repo, 'refs/heads/pocket/p/phase-2'), committed);
});

// ─── Extra RED (review): phase-aware ignored-artifact warning ───────────────
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git)
// Test intent: The POCKET_ARTIFACTS_IGNORED warning on a later phase's handoff
// must name that phase's snapshot (`reviews/closeout-phase-2.md`), not phase 1's.
// Observed on the step 4 code before the fix: the warning always probed
// `closeout-phase-1.md`, while `data.commit.skipped` named the right path.
// Exact command: `node --test --test-name-pattern="handoff phase warnings" test/phase-handoff.test.js`

test('handoff phase warnings: a later phase reports its own snapshot, not phase-1', () => {
  const fx = makeStackedPlan({ phases: 2 });
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeFile(path.join(fx.repo, '.gitignore'), 'docs/pocket/\n');
  git(fx.repo, 'add', '--', '.gitignore');
  git(fx.repo, 'commit', '-q', '-m', 'ignore plan artifacts');
  const first = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(first.status, 0, first.stdout + first.stderr);

  // Phase 2 runs on its own branch and is closed out.
  okCli(fx.repo, ['log', 'update', fx.planDir, 'execution-plan/phase-2.md', 'REVIEW']);
  okCli(fx.repo, ['log', 'update', fx.planDir, 'execution-plan/phase-2.md', 'DONE']);
  writeCloseout(fx.planDir, [phaseSection(1, 2), phaseSection(2, 2)]);
  const second = handoff(fx.repo, fx.planDir, 'execution-plan/phase-2.md');
  assert.equal(second.status, 0, second.stdout + second.stderr);

  const warning = second.env.data.warnings.find((w) => w.code === 'POCKET_ARTIFACTS_IGNORED');
  assert.ok(warning, JSON.stringify(second.env.data.warnings));
  assert.ok(warning.paths.some((p) => p.endsWith('reviews/closeout-phase-2.md')), JSON.stringify(warning.paths));
  assert.ok(!warning.paths.some((p) => p.endsWith('reviews/closeout-phase-1.md')), JSON.stringify(warning.paths));
});

// ─── Extra RED (review): user-staged adapter registration ───────────────────
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git)
// Test intent: The step-1 guard allows the machine-local registration, but
// `git commit` takes the whole index. A registration the user staged must
// fail closed at the commit step: STAGED_OUTSIDE_PLAN, HEAD unchanged, no
// `.pocket/` in the commit, and the registration still staged.
// Observed on the step 4 code before the fix: the registration was committed.
// Exact command: `node --test --test-name-pattern="handoff staged registration" test/phase-handoff.test.js`

test('handoff staged registration: a user-staged adapter registration fails with STAGED_OUTSIDE_PLAN and is never committed', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  writeRegistration(fx.repo);
  git(fx.repo, 'add', '--', '.pocket/lifecycle-adapter.json');
  const before = headState(fx.repo);

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.env.error.code, 'STAGED_OUTSIDE_PLAN', r.stdout);
  assert.match(r.env.error.message, /\.pocket\/lifecycle-adapter\.json/);
  assert.deepEqual(headState(fx.repo), before, 'no commit and no branch switch');
  assert.ok(!git(fx.repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').some((f) => f.startsWith('.pocket/')));
  assert.deepEqual(git(fx.repo, 'diff', '--cached', '--name-only').split('\n'), ['.pocket/lifecycle-adapter.json']);
});

// ─── Extra RED (found during cycle 8/11 work): projection lock guard ────────
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git)
// Test intent: `log handoff` runs inside the log.json projection lock, which
// writes `log.json.projection-lock.guard` into the plan dir for the whole run
// and deletes it when the command returns. That transient lock record must
// never be committed, and the tree must be clean after the handoff.
// Observed on the step 4 code before the fix: the guard was committed, then
// deleted after the commit, leaving a tracked file deleted in the worktree.
// Exact command: `node --test --test-name-pattern="handoff projection lock guard" test/phase-handoff.test.js`

test('handoff projection lock guard: the transient lock record is never committed and leaves the tree clean', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);

  const r = handoff(fx.repo, fx.planDir, fx.phaseFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.env.data.steps.commit, 'committed');
  assert.ok(!committedFiles(fx.repo).some((f) => f.endsWith('.projection-lock.guard')), committedFiles(fx.repo).join('\n'));
  assert.equal(git(fx.repo, 'status', '--porcelain'), '', 'the handoff must leave no dirty or deleted file');
});

// ─── Carry-forward: null plan id ────────────────────────────────────────────
// RED carry-forward (T8): handoff null plan id
// Test file: `test/phase-handoff.test.js`
// Level: integration (CLI + real git + lifecycle doc)
// Test intent: Given a stacked plan whose plan dir was renamed to a non-slug name / When handoff runs / Then code `PHASE_BRANCHES_PLAN_ID_INVALID` and zero mutation (no snapshot, no event, no commit, no branch, log.json and lifecycle.json byte-identical)
// Exercise through: CLI
// Test doubles: none
// Expected RED (on the code as it stood): handoff succeeds and records the next branch as `pocket/null/phase-2`
// Exact command: `node --test --test-name-pattern="handoff null plan id" test/phase-handoff.test.js`

test('handoff null plan id: a non-slug plan dir fails with PHASE_BRANCHES_PLAN_ID_INVALID and mutates nothing', () => {
  const fx = makeStackedPlan();
  writeCloseout(fx.planDir, [phaseSection(1, 2)]);
  const renamed = path.join(path.dirname(fx.planDir), 'P_Not_A_Slug');
  fs.renameSync(fx.planDir, renamed);
  const moved = { ...fx, planDir: renamed };
  const before = captureState(moved);

  const r = handoff(fx.repo, renamed, fx.phaseFile);
  assertRefused(moved, r, 'PHASE_BRANCHES_PLAN_ID_INVALID', before);
  assert.match(r.env.error.message, /slug/);
  assert.equal(refSha(fx.repo, 'refs/heads/pocket/null/phase-2'), null);
});

// Issue #84: closing a stacked plan whose spec dir has no lifecycle.json records no
// plan-closed event, so `log close` names the gap instead of a clean success.
test('missing lifecycle: log close on a stacked plan without lifecycle.json warns LIFECYCLE_DOCUMENT_MISSING', () => {
  const { repo, planDir, specDir } = makeStackedPlan({ phases: 1, lifecycle: false });
  const env = okCli(repo, ['log', 'close', planDir]);
  assert.equal(env.data.event, null);
  const warning = env.data.warnings.find((w) => w.code === 'LIFECYCLE_DOCUMENT_MISSING');
  assert.ok(warning, JSON.stringify(env.data.warnings));
  assert.equal(warning.path, path.join(specDir, 'lifecycle.json'));
  assert.deepEqual(env.data.next_actions, []);
  const human = runCli(repo, ['log', 'update', planDir, 'execution-plan/phase-1.md', 'REVIEW'], { json: false });
  assert.match(human.stdout, /LIFECYCLE_DOCUMENT_MISSING: .*lifecycle\.json not found/);
});

test('missing lifecycle: a none-strategy plan with no adapter registration gets no lifecycle warning', () => {
  const { repo, planDir } = makeStackedPlan({ phases: 1, lifecycle: false, strategy: 'none', done: false });
  const env = okCli(repo, ['log', 'update', planDir, 'execution-plan/phase-1.md', 'DONE']);
  assert.deepEqual(env.data.warnings, []);
});

test('missing lifecycle: an adapter-registered none-strategy plan warns on phase updates', () => {
  const { repo, planDir } = makeStackedPlan({ phases: 1, lifecycle: false, strategy: 'none', done: false });
  writeRegistration(repo);
  const env = okCli(repo, ['log', 'update', planDir, 'execution-plan/phase-1.md', 'DONE']);
  assert.deepEqual(env.data.warnings.map((w) => w.code), ['LIFECYCLE_DOCUMENT_MISSING']);
});
