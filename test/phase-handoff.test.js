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

function runCli(repo, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json', '--contract', '3'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK },
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
  assert.equal(r.env.data.steps.commit, 'pending');
  assert.equal(r.env.data.steps.branch, 'pending');
  assert.ok(Array.isArray(r.env.data.warnings));
  assert.ok(Array.isArray(r.env.data.next_actions));
  // Steps 4-5 belong to T8: no commit and no branch switch here.
  assert.deepEqual(headState(fx.repo), before);
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
