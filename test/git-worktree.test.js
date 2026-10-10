'use strict';

// Integration tests for cli/lib/git-worktree.js against real git in mkdtemp
// repositories. Every fixture is a fresh temp repo driven with `git -C <tmp>`
// and local config only; nothing touches the real repository, its hooks, or
// any global git configuration.

// Inherited repo-pointing variables would redirect fixture git calls to the
// real repository, so they are cleared before any fixture runs.
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Loaded inside each test body so a missing module fails a named test.
const load = () => require('../cli/lib/git-worktree.js');

function hasCommand(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

const hasGit = hasCommand('git', ['--version']);
const hasSh = hasCommand('sh', ['-c', 'exit 0']);

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-worktree-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture User']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', path.join(root, '.git', 'hooks')]);
  return root;
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('git-worktree read: reports branch, tip, dirty and staged paths in a mixed repo', { skip: !hasGit }, () => {
  const { currentBranch, branchTip, dirtyPaths, stagedPaths } = load();
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
    git(root, ['add', '--', 'tracked.txt']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['switch', '-q', '-c', 'feature/x']);
    const head = git(root, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'u\n');
    fs.writeFileSync(path.join(root, 'staged.txt'), 's\n');
    git(root, ['add', '--', 'staged.txt']);

    assert.equal(currentBranch(root), 'feature/x');
    assert.equal(branchTip(root, 'HEAD'), head);
    assert.equal(branchTip(root, 'feature/x'), head);
    assert.deepEqual(dirtyPaths(root).sort(), ['staged.txt', 'tracked.txt', 'untracked.txt']);
    assert.deepEqual(stagedPaths(root), ['staged.txt']);
  } finally {
    removeDir(root);
  }
});

test('git-worktree detached: currentBranch is null and branchTip(HEAD) is the HEAD sha', { skip: !hasGit }, () => {
  const { currentBranch, branchTip } = load();
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
    git(root, ['add', '--', 'tracked.txt']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['checkout', '-q', '--detach']);
    const head = git(root, ['rev-parse', 'HEAD']);

    assert.equal(currentBranch(root), null);
    assert.equal(branchTip(root, 'HEAD'), head);
  } finally {
    removeDir(root);
  }
});

test('git-worktree ignore: index-tracked files are not reported, only ignored untracked paths', { skip: !hasGit }, () => {
  const { ignoredPaths } = load();
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, '.gitignore'), 'docs/pocket/\n');
    git(root, ['add', '--', '.gitignore']);
    git(root, ['commit', '-q', '-m', 'base']);

    const logRel = 'docs/pocket/plans/p/log.json';
    const reviewRel = 'docs/pocket/plans/p/reviews/closeout-phase-1.md';
    fs.mkdirSync(path.dirname(path.join(root, logRel)), { recursive: true });
    fs.writeFileSync(path.join(root, logRel), '{}\n');
    git(root, ['add', '-f', '--', logRel]);
    git(root, ['commit', '-q', '-m', 'force-track log']);

    assert.deepEqual(ignoredPaths(root, [logRel, reviewRel]), [reviewRel]);
  } finally {
    removeDir(root);
  }
});

test('git-worktree ignore: returns [] outside a repository without throwing', { skip: !hasGit }, () => {
  const { ignoredPaths } = load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-worktree-nongit-'));
  try {
    assert.deepEqual(ignoredPaths(dir, ['docs/pocket/x.json']), []);
  } finally {
    removeDir(dir);
  }
});

test('git-worktree commit trailer: creates a branch, commits with a handoff trailer', { skip: !hasGit }, () => {
  const { createAndSwitch, addPaths, commitWithTrailer, headTrailer, currentBranch } = load();
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, ['add', '--', 'README.md']);
    git(root, ['commit', '-q', '-m', 'base']);

    const created = createAndSwitch(root, 'pocket/p/phase-1');
    assert.equal(created.ok, true, created.message);

    fs.mkdirSync(path.join(root, 'notes'));
    fs.writeFileSync(path.join(root, 'notes', 'handoff.txt'), 'handoff\n');
    assert.equal(addPaths(root, ['notes/handoff.txt']).ok, true);

    const committed = commitWithTrailer(root, {
      subject: 'chore(pocket): close p phase-1',
      trailer: 'Pocket-Handoff: p/phase-1',
    });
    assert.equal(committed.ok, true, committed.message);

    assert.equal(currentBranch(root), 'pocket/p/phase-1');
    const message = git(root, ['log', '-1', '--format=%B']);
    assert.ok(message.endsWith('Pocket-Handoff: p/phase-1'), message);
    assert.equal(headTrailer(root, 'Pocket-Handoff'), 'p/phase-1');
  } finally {
    removeDir(root);
  }
});

test('git-worktree branch exists: createAndSwitch reports GIT_BRANCH_EXISTS and leaves HEAD unchanged', { skip: !hasGit }, () => {
  const { createAndSwitch, currentBranch } = load();
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, ['add', '--', 'README.md']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['branch', 'pocket/p/phase-1']);
    const headBefore = git(root, ['rev-parse', 'HEAD']);

    const result = createAndSwitch(root, 'pocket/p/phase-1');

    assert.equal(result.ok, false);
    assert.equal(result.code, 'GIT_BRANCH_EXISTS');
    assert.equal(currentBranch(root), 'main');
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
  } finally {
    removeDir(root);
  }
});

test('git-worktree hook failure: commitWithTrailer reports GIT_HOOK_FAILED with hook output and leaves HEAD unchanged', { skip: !hasGit || !hasSh }, () => {
  const { addPaths, commitWithTrailer } = load();
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, ['add', '--', 'README.md']);
    git(root, ['commit', '-q', '-m', 'base']);

    // Hook lives only inside this temporary repository.
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    fs.writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
    assert.equal(addPaths(root, ['feature.txt']).ok, true);
    const headBefore = git(root, ['rev-parse', 'HEAD']);

    const result = commitWithTrailer(root, {
      subject: 'chore(pocket): close p phase-1',
      trailer: 'Pocket-Handoff: p/phase-1',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'GIT_HOOK_FAILED');
    assert.match(result.stderr, /lint failed/);
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
  } finally {
    removeDir(root);
  }
});

test('git-worktree commit timeout: commitWithTrailer is bounded and reports GIT_COMMIT_TIMEOUT', { skip: !hasGit || !hasSh }, () => {
  const { addPaths, commitWithTrailer } = load();
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, ['add', '--', 'README.md']);
    git(root, ['commit', '-q', '-m', 'base']);

    // Slow hook lives only inside this temporary repository.
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 5\n');
    fs.chmodSync(hook, 0o755);

    fs.writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
    assert.equal(addPaths(root, ['feature.txt']).ok, true);
    const headBefore = git(root, ['rev-parse', 'HEAD']);

    const started = Date.now();
    const result = commitWithTrailer(root, {
      subject: 'chore(pocket): close p phase-1',
      trailer: 'Pocket-Handoff: p/phase-1',
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false, `expected a timeout; commit returned ok after ${elapsed}ms`);
    assert.equal(result.code, 'GIT_COMMIT_TIMEOUT');
    assert.ok(elapsed < 2500, `commit returned after ${elapsed}ms, expected a bound near 200ms`);
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
  } finally {
    removeDir(root);
  }
});

test('git-worktree read: returns null or [] outside a repository without throwing', { skip: !hasGit }, () => {
  const { currentBranch, branchTip, dirtyPaths, stagedPaths } = load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-worktree-nongit-'));
  try {
    assert.equal(currentBranch(dir), null);
    assert.equal(branchTip(dir, 'HEAD'), null);
    assert.deepEqual(dirtyPaths(dir), []);
    assert.deepEqual(stagedPaths(dir), []);
  } finally {
    removeDir(dir);
  }
});
