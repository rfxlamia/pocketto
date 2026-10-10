'use strict';

// Integration tests (CLI + real git) for `log init --phase-branches`.
// Each test title carries the cycle pattern it belongs to, so
// `node --test --test-name-pattern="<pattern>"` selects exactly that cycle.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'phase-branches', 'none-parity');
const { PIPELINE } = require('../cli/lib/version');
const { readAdapterRegistration } = require('../cli/lib/lifecycle-adapter');
const { lifecycleSpecDirForPlan } = require('../cli/lib/lifecycle-transition');

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const PHASE_BODY = [
  '# Phase 1: Phase branch fixture',
  '',
  '### Task 1: Add the first behavior',
  '',
  'Body for the first task.',
  '',
  '### Task 2: Add the second behavior [depends: T1]',
  '',
  'Body for the second task.',
  '',
].join('\n');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function writeFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// Creates a repo on `branch` with one root commit. `committed` files are part
// of that root commit; anything written later stays untracked.
function makeRepo({ branch = 'feature/x', committed = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-phase-branches-'));
  created.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  git(dir, 'config', 'user.email', 'phase-branches@example.invalid');
  git(dir, 'config', 'user.name', 'phase-branches');
  writeFile(path.join(dir, 'README.md'), 'root\n');
  for (const [rel, body] of Object.entries(committed)) writeFile(path.join(dir, rel), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'root');
  return dir;
}

// Structured plan under docs/pocket/plans/<name> plus its spec under
// docs/pocket/spec/<name>. Nothing is committed here.
function writePlan(repo, name) {
  const planDir = path.join(repo, 'docs', 'pocket', 'plans', name);
  const specDir = path.join(repo, 'docs', 'pocket', 'spec', name);
  writeFile(path.join(specDir, 'approved-spec.md'), '# Approved spec\n');
  writeFile(
    path.join(planDir, 'execution-plan', 'index.md'),
    `# Plan Index\n\n**Spec:** ../../spec/${name}/approved-spec.md\n`,
  );
  writeFile(path.join(planDir, 'execution-plan', 'phase-1.md'), PHASE_BODY);
  return { planDir, specDir };
}

function registrationBody(extra = {}) {
  return {
    schema: 1,
    adapter_contract: 2,
    argv: ['node', 'adapter.js'],
    events: ['phase-complete'],
    timeout_ms: 5000,
    ...extra,
  };
}

function runCli(repo, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json', '--contract', '3'], { cwd: repo, encoding: 'utf8' });
  let env = null;
  try {
    env = JSON.parse(r.stdout.trim());
  } catch {
    env = null;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, env };
}

function logInit(repo, planDir, extra = []) {
  return runCli(repo, ['log', 'init', planDir, ...extra]);
}

function readLogBytes(planDir) {
  return fs.readFileSync(path.join(planDir, 'log.json'), 'utf8');
}

function readLog(planDir) {
  return JSON.parse(readLogBytes(planDir));
}

function head(repo) {
  return git(repo, 'rev-parse', 'HEAD');
}

function currentBranch(repo) {
  try {
    return git(repo, 'symbolic-ref', '--short', '-q', 'HEAD');
  } catch {
    return '';
  }
}

function branchList(repo, pattern) {
  return git(repo, 'branch', '--list', pattern).split('\n').map((l) => l.trim()).filter(Boolean);
}

// The same placeholders the none-parity snapshot was captured with.
function normalizeText(text, planDir) {
  return text
    .split(planDir).join('<PLAN_DIR>')
    .replace(/"date_started": "[^"]*"/, '"date_started": "<DATE>"')
    .replace(/"baseline_sha": "[^"]*"/, '"baseline_sha": "<SHA>"');
}

// ─── Cycle 1: stacked init via flag ─────────────────────────────────────────

test('stacked init flag: fixture resolves the spec dir for the plan', () => {
  const repo = makeRepo();
  const { planDir, specDir } = writePlan(repo, 'p');
  assert.equal(lifecycleSpecDirForPlan(planDir), specDir);
});

test('stacked init flag: creates phase-1 at HEAD and records identity', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  const sha = head(repo);

  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.env.ok, true);
  assert.equal(currentBranch(repo), 'pocket/p/phase-1');
  assert.equal(head(repo), sha);

  const log = readLog(planDir);
  assert.deepEqual(log.header.phase_branches, { mode: 'stacked', root_base: { branch: 'feature/x', sha } });
  assert.equal(log.phases[0].branch, 'pocket/p/phase-1');
  assert.equal(log.phases[0].base_branch, 'feature/x');
  assert.deepEqual(res.env.data.phase_branches, { mode: 'stacked', source: 'flag' });
  assert.deepEqual(res.env.data.branch, { from: 'feature/x', created: 'pocket/p/phase-1', switched: true, status: 'created' });
});

// ─── Cycle 2: invalid plan id ───────────────────────────────────────────────

test('stacked init plan id invalid: none init still accepts the same dir', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'My Plan');
  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(currentBranch(repo), 'feature/x');
});

test('stacked init plan id invalid: a non-slug plan dir fails closed with no branch and no log.json', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'My Plan');
  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.notEqual(res.status, 0);
  assert.equal(res.env.error.code, 'PHASE_BRANCHES_PLAN_ID_INVALID');
  assert.equal(currentBranch(repo), 'feature/x');
  assert.deepEqual(branchList(repo, 'pocket/*'), []);
  assert.equal(fs.existsSync(path.join(planDir, 'log.json')), false);
});

// ─── Cycle 3: foreign dirty paths refused ───────────────────────────────────

test('stacked init foreign dirty: none init ignores dirty paths and keeps the branch', () => {
  const repo = makeRepo({ committed: { 'src/app.js': 'one\n' } });
  const { planDir } = writePlan(repo, 'p');
  writeFile(path.join(repo, 'src', 'app.js'), 'two\n');
  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(currentBranch(repo), 'feature/x');
});

test('stacked init foreign dirty: a modified path outside the plan fails closed and writes nothing', () => {
  const repo = makeRepo({ committed: { 'src/app.js': 'one\n' } });
  const { planDir } = writePlan(repo, 'p');
  writeFile(path.join(repo, 'src', 'app.js'), 'two\n');
  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.notEqual(res.status, 0);
  assert.equal(res.env.error.code, 'DIRTY_OUTSIDE_PLAN');
  assert.match(res.env.error.message, /src\/app\.js/);
  assert.equal(currentBranch(repo), 'feature/x');
  assert.deepEqual(branchList(repo, 'pocket/*'), []);
  assert.equal(fs.existsSync(path.join(planDir, 'log.json')), false);
});

// ─── Cycle 4: tolerates freshly planned artifacts (guard) ───────────────────

test('stacked init tolerates plan artifacts: tracked then modified plan and spec files do not block init', () => {
  const repo = makeRepo();
  const { planDir, specDir } = writePlan(repo, 'p');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'plan and spec');
  writeFile(path.join(planDir, 'execution-plan', 'index.md'), `# Plan Index\n\n**Spec:** ../../spec/p/approved-spec.md\n\nEdited.\n`);
  writeFile(path.join(specDir, 'lifecycle.json'), '{"rewritten":true}\n');

  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(currentBranch(repo), 'pocket/p/phase-1');
  assert.equal(fs.existsSync(path.join(planDir, 'log.json')), true);
});

// ─── Cycle 5: detached HEAD ─────────────────────────────────────────────────

test('stacked init detached: none init on a detached HEAD still succeeds', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  git(repo, 'checkout', '-q', '--detach');
  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(currentBranch(repo), '');
});

test('stacked init detached: fails closed with PHASE_BRANCHES_DETACHED and writes nothing', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  git(repo, 'checkout', '-q', '--detach');
  const sha = head(repo);
  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.notEqual(res.status, 0);
  assert.equal(res.env.error.code, 'PHASE_BRANCHES_DETACHED');
  assert.equal(head(repo), sha);
  assert.deepEqual(branchList(repo, 'pocket/*'), []);
  assert.equal(fs.existsSync(path.join(planDir, 'log.json')), false);
});

// ─── Cycle 6: strategy from the adapter registration ────────────────────────

test('registration default: the hand-written stacked registration is accepted by the adapter reader', () => {
  const repo = makeRepo({ committed: { '.pocket/lifecycle-adapter.json': `${JSON.stringify(registrationBody({ phase_branches: 'stacked' }), null, 2)}\n` } });
  const { registration, error } = readAdapterRegistration(repo);
  assert.equal(error, null);
  assert.equal(registration.phase_branches, 'stacked');
});

test('registration default: a valid stacked registration selects stacked with source registration', () => {
  const repo = makeRepo({ committed: { '.pocket/lifecycle-adapter.json': `${JSON.stringify(registrationBody({ phase_branches: 'stacked' }), null, 2)}\n` } });
  const { planDir } = writePlan(repo, 'p');
  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(currentBranch(repo), 'pocket/p/phase-1');
  assert.deepEqual(res.env.data.phase_branches, { mode: 'stacked', source: 'registration' });
});

test('registration default: an explicit none flag overrides a stacked registration', () => {
  const repo = makeRepo({ committed: { '.pocket/lifecycle-adapter.json': `${JSON.stringify(registrationBody({ phase_branches: 'stacked' }), null, 2)}\n` } });
  const { planDir } = writePlan(repo, 'p');
  const res = logInit(repo, planDir, ['--phase-branches', 'none']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(currentBranch(repo), 'feature/x');
  assert.deepEqual(res.env.data.phase_branches, { mode: 'none', source: 'flag' });
});

// ─── Cycle 7: invalid registration never blocks init ────────────────────────

test('registration fallback: init succeeds with no flag under a malformed registration', () => {
  const repo = makeRepo({ committed: { '.pocket/lifecycle-adapter.json': '{ this is not json\n' } });
  const { planDir } = writePlan(repo, 'p');
  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(fs.existsSync(path.join(planDir, 'log.json')), true);
});

test('registration fallback: malformed and adapter_contract 1 registrations degrade to none with a warning', () => {
  const malformed = makeRepo({ committed: { '.pocket/lifecycle-adapter.json': '{ this is not json\n' } });
  const mPlan = writePlan(malformed, 'p').planDir;
  const mRes = logInit(malformed, mPlan);
  assert.equal(mRes.status, 0, mRes.stdout + mRes.stderr);
  assert.deepEqual(mRes.env.data.phase_branches, { mode: 'none', source: 'default' });
  assert.equal(currentBranch(malformed), 'feature/x');
  assert.ok(mRes.env.data.warnings.some((w) => /registration/i.test(`${w.code} ${w.message}`)));

  const contract1 = makeRepo({
    committed: { '.pocket/lifecycle-adapter.json': `${JSON.stringify(registrationBody({ adapter_contract: 1, phase_branches: 'stacked' }), null, 2)}\n` },
  });
  const cPlan = writePlan(contract1, 'p').planDir;
  const cRes = logInit(contract1, cPlan);
  assert.equal(cRes.status, 0, cRes.stdout + cRes.stderr);
  assert.deepEqual(cRes.env.data.phase_branches, { mode: 'none', source: 'default' });
  assert.equal(currentBranch(contract1), 'feature/x');
  assert.ok(cRes.env.data.warnings.some((w) => /registration/i.test(`${w.code} ${w.message}`)));
});

// ─── Cycle 8: strategy locked after init ────────────────────────────────────

test('strategy locked: a rerun without a flag leaves an existing none log byte-identical', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  assert.equal(logInit(repo, planDir).status, 0);
  const before = readLogBytes(planDir);
  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(readLogBytes(planDir), before);
});

test('strategy locked: stacked flag on an existing none log fails with PHASE_BRANCHES_LOCKED and changes nothing', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  assert.equal(logInit(repo, planDir).status, 0);
  const before = readLogBytes(planDir);
  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.notEqual(res.status, 0);
  assert.equal(res.env.error.code, 'PHASE_BRANCHES_LOCKED');
  assert.equal(readLogBytes(planDir), before);
  assert.equal(currentBranch(repo), 'feature/x');
  assert.deepEqual(branchList(repo, 'pocket/*'), []);
});

// ─── Cycle 9: default strategy unchanged (parity) ───────────────────────────

test('none parity: log.json bytes equal the committed snapshot and no branch is created', () => {
  const repo = makeRepo();
  const planDir = path.join(repo, 'docs', 'pocket', 'plans', 'none-parity');
  writeFile(path.join(planDir, 'execution-plan', 'index.md'), fs.readFileSync(path.join(FIXTURE, 'plan', 'execution-plan', 'index.md'), 'utf8'));
  writeFile(path.join(planDir, 'execution-plan', 'phase-1.md'), fs.readFileSync(path.join(FIXTURE, 'plan', 'execution-plan', 'phase-1.md'), 'utf8'));

  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.env.data.phaseCount, 1);
  assert.equal(readLog(planDir).header.baseline_sha, head(repo), 'baseline_sha must be the real HEAD before normalizing');

  const normalized = normalizeText(readLogBytes(planDir), planDir);
  assert.equal(normalized, fs.readFileSync(path.join(FIXTURE, 'log.snapshot.json'), 'utf8'));
  assert.equal(currentBranch(repo), 'feature/x');
  assert.deepEqual(branchList(repo, 'pocket/*'), []);
});

test('none parity: envelope gains only phase_branches, branch, warnings and next_actions', () => {
  const repo = makeRepo();
  const planDir = path.join(repo, 'docs', 'pocket', 'plans', 'none-parity');
  writeFile(path.join(planDir, 'execution-plan', 'index.md'), fs.readFileSync(path.join(FIXTURE, 'plan', 'execution-plan', 'index.md'), 'utf8'));
  writeFile(path.join(planDir, 'execution-plan', 'phase-1.md'), fs.readFileSync(path.join(FIXTURE, 'plan', 'execution-plan', 'phase-1.md'), 'utf8'));

  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'envelope.json'), 'utf8'));
  const { phase_branches: phaseBranches, branch, warnings, next_actions: nextActions, ...rest } = res.env.data;
  const normalizedRest = JSON.parse(normalizeText(JSON.stringify(rest), planDir));
  assert.deepEqual(normalizedRest, fixture.data);
  assert.deepEqual(phaseBranches, { mode: 'none', source: 'default' });
  assert.equal(branch, null);
  assert.deepEqual(warnings, []);
  assert.deepEqual(nextActions, []);
});

// ─── Cycle 10: Core warns at stacked init ───────────────────────────────────

test('stacked init ignored warning: none init succeeds when docs/pocket is gitignored', () => {
  const repo = makeRepo({ committed: { '.gitignore': 'docs/pocket/\n' } });
  const { planDir } = writePlan(repo, 'p');
  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(currentBranch(repo), 'feature/x');
});

test('stacked init ignored warning: stacked init exits 0 and reports POCKET_ARTIFACTS_IGNORED with the probe paths', () => {
  const repo = makeRepo({ committed: { '.gitignore': 'docs/pocket/\n' } });
  const { planDir } = writePlan(repo, 'p');
  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const warning = res.env.data.warnings.find((w) => w.code === 'POCKET_ARTIFACTS_IGNORED');
  assert.ok(warning, 'expected POCKET_ARTIFACTS_IGNORED');
  assert.ok(warning.paths.some((p) => p.endsWith(path.join('plans', 'p', 'log.json')) || p.endsWith('plans/p/log.json')));
  assert.equal(currentBranch(repo), 'pocket/p/phase-1');
});

// ─── Cycle 11: rerun adopts the current phase-1 branch ──────────────────────

test('stacked init adopts: fixture leaves the phase branch checked out with no log.json', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  git(repo, 'switch', '-q', '-c', 'pocket/p/phase-1');
  assert.equal(currentBranch(repo), 'pocket/p/phase-1');
  assert.equal(fs.existsSync(path.join(planDir, 'log.json')), false);
});

test('stacked init adopts: reruns on the current phase-1 branch without creating one and records identity', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  git(repo, 'switch', '-q', '-c', 'pocket/p/phase-1');
  const sha = head(repo);

  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(currentBranch(repo), 'pocket/p/phase-1');
  assert.equal(head(repo), sha);
  assert.equal(res.env.data.branch.created, null);
  assert.equal(res.env.data.branch.switched, false);

  const log = readLog(planDir);
  assert.equal(log.phases[0].branch, 'pocket/p/phase-1');
  // The base is recovered from the previous checkout, which must still be at HEAD.
  assert.deepEqual(log.header.phase_branches, { mode: 'stacked', root_base: { branch: 'feature/x', sha } });
  assert.equal(log.phases[0].base_branch, 'feature/x');
  assert.equal(res.env.data.branch.from, 'feature/x');
  // The adopted identity must pass the same planPatch rules the lifecycle code applies.
  const { validatePlanPatch } = require('../cli/lib/lifecycle-plan-patch');
  const patch = {
    phase_branches: { mode: 'stacked', root_base: log.header.phase_branches.root_base },
    phases: { 'phase-1': { branch: log.phases[0].branch, base_branch: log.phases[0].base_branch } },
  };
  assert.equal(validatePlanPatch(patch).ok, true);
});

test('stacked init adopts: refuses when the original base cannot be recovered and writes nothing', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  git(repo, 'switch', '-q', '-c', 'pocket/p/phase-1');
  git(repo, '-c', 'user.name=phase-branches', '-c', 'user.email=phase-branches@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'work on phase 1');
  const sha = head(repo);

  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.notEqual(res.status, 0);
  assert.equal(res.env.error.code, 'PHASE_BRANCHES_ROOT_BASE_UNKNOWN');
  assert.equal(currentBranch(repo), 'pocket/p/phase-1');
  assert.equal(head(repo), sha);
  assert.equal(fs.existsSync(path.join(planDir, 'log.json')), false);
});

// ─── Cycle 12: phase-1 branch exists elsewhere ──────────────────────────────

test('stacked init branch exists: fixture has the phase branch at another commit', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  git(repo, 'branch', 'pocket/p/phase-1', 'HEAD');
  git(repo, '-c', 'user.name=phase-branches', '-c', 'user.email=phase-branches@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'later');
  assert.notEqual(head(repo), git(repo, 'rev-parse', 'pocket/p/phase-1'));
  assert.equal(currentBranch(repo), 'feature/x');
  assert.equal(fs.existsSync(path.join(planDir, 'log.json')), false);
});

test('stacked init branch exists: fails with PHASE_BRANCHES_BRANCH_EXISTS and leaves HEAD and log.json alone', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  git(repo, 'branch', 'pocket/p/phase-1', 'HEAD');
  git(repo, '-c', 'user.name=phase-branches', '-c', 'user.email=phase-branches@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'later');
  const sha = head(repo);

  const res = logInit(repo, planDir, ['--phase-branches', 'stacked']);
  assert.notEqual(res.status, 0);
  assert.equal(res.env.error.code, 'PHASE_BRANCHES_BRANCH_EXISTS');
  assert.match(res.env.error.message, /git switch|manual|rename|delete/i);
  assert.equal(currentBranch(repo), 'feature/x');
  assert.equal(head(repo), sha);
  assert.equal(fs.existsSync(path.join(planDir, 'log.json')), false);
});

// ─── Cycle 13: lock works in reverse; no-flag rerun keeps migration ─────────

function writeStackedLog(planDir) {
  const log = {
    header: {
      plan_dir: planDir,
      plan_type: 'phased',
      status: 'IN_PROGRESS',
      date_started: '2026-10-10',
      date_completed: null,
      baseline_sha: 'a'.repeat(40),
      pipeline: PIPELINE,
      phase_branches: { mode: 'stacked', root_base: { branch: 'feature/x', sha: 'a'.repeat(40) } },
    },
    phases: [{
      order: 1,
      file: 'execution-plan/phase-1.md',
      status: 'WAITING',
      branch: 'pocket/p/phase-1',
      base_branch: 'feature/x',
      tasks: [{ id: 'T1', name: 'Add the first behavior', status: 'WAITING' }],
    }],
  };
  writeFile(path.join(planDir, 'log.json'), `${JSON.stringify(log, null, 2)}\n`);
}

test('strategy locked reverse: a no-flag rerun on a stacked log keeps migrate behavior with no rewrite', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  writeStackedLog(planDir);
  const before = readLogBytes(planDir);
  const res = logInit(repo, planDir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.env.data.migrated, false);
  assert.equal(readLogBytes(planDir), before);
});

test('strategy locked reverse: --phase-branches none on a stacked log fails closed with PHASE_BRANCHES_LOCKED', () => {
  const repo = makeRepo();
  const { planDir } = writePlan(repo, 'p');
  writeStackedLog(planDir);
  const before = readLogBytes(planDir);
  const res = logInit(repo, planDir, ['--phase-branches', 'none']);
  assert.notEqual(res.status, 0);
  assert.equal(res.env.error.code, 'PHASE_BRANCHES_LOCKED');
  assert.equal(readLogBytes(planDir), before);
});
