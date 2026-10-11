'use strict';

const { spawnSync } = require('node:child_process');

// Git operations that stacked phase branches need. Read helpers never throw
// (they return null or []), matching cli/lib/git.js. Mutating helpers return
// { ok, code, message, stdout, stderr } and never throw. Every call uses an
// explicit argv array (never a shell string) and places `--` before paths.
// Nothing here pushes, rebases, force-updates, or bypasses hooks.

const DEFAULT_COMMIT_TIMEOUT_MS = 30000;

// Runs git with an argv array. Never throws: a failed spawn or a timeout is
// reported through `error`, so callers decide what the outcome means.
function runGit(cwd, args, { input, timeout } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout,
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
  };
}

function succeeded(r) {
  return r.status === 0 && !r.error;
}

function splitNul(out) {
  return out.split('\0').filter(Boolean);
}

// Branch names must not be empty or look like an option to git.
function isBranchName(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-');
}

// Outcome shapes shared by the mutating helpers.
function success(r) {
  return { ok: true, code: null, message: '', stdout: r.stdout, stderr: r.stderr };
}

function failure(code, message, r = { stdout: '', stderr: '' }) {
  return { ok: false, code, message, stdout: r.stdout, stderr: r.stderr };
}

function outcome(r, failureCode, message) {
  return succeeded(r) ? success(r) : failure(failureCode, message, r);
}

// Runs a mutating helper body and turns any unexpected throw into a failure.
function guardMutation(fn) {
  try {
    return fn();
  } catch (err) {
    return failure('GIT_ERROR', `git helper error: ${err.message}`);
  }
}

// Name of the checked-out branch, or null on detached HEAD or outside a repo.
// Reads the symbolic ref so the literal string "HEAD" is never returned.
function currentBranch(cwd) {
  try {
    const r = runGit(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
    if (!succeeded(r)) return null;
    const ref = r.stdout.trim();
    const prefix = 'refs/heads/';
    return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

// Commit SHA for <branch>. 'HEAD' resolves even when detached. Null if unknown.
function branchTip(cwd, branch) {
  try {
    if (!isBranchName(branch)) return null;
    const r = runGit(cwd, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
    return succeeded(r) ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

// Best common ancestor of <a> and <b>, or null when there is none or git fails.
// Refs are passed as given, so callers pass fully qualified names when a branch
// name could collide with a path.
function mergeBase(cwd, a, b) {
  try {
    if (!isBranchName(a) || !isBranchName(b)) return null;
    const r = runGit(cwd, ['merge-base', a, b]);
    return succeeded(r) ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

// Location of <cwd> relative to the repository root, with a trailing slash
// ('app/'), or '' at the root. Null outside a repository. Paths that git reports
// in status output are root-relative, so this is the base they are compared to.
function repoPathPrefix(cwd) {
  try {
    const r = runGit(cwd, ['rev-parse', '--show-prefix']);
    return succeeded(r) ? r.stdout.replace(/\r?\n$/, '') : null;
  } catch {
    return null;
  }
}

// Porcelain v1 entries are "XY <path>" NUL-terminated. A rename or copy entry
// is followed by one extra NUL field holding the source path; both are kept.
function parsePorcelainPaths(out) {
  const fields = out.split('\0');
  const paths = new Set();
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (!entry) continue;
    const x = entry[0];
    const y = entry[1];
    paths.add(entry.slice(3));
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1;
      if (fields[i]) paths.add(fields[i]);
    }
  }
  return [...paths];
}

// Modified, staged and untracked paths. Untracked files are listed one by one.
function dirtyPaths(cwd) {
  try {
    const r = runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return succeeded(r) ? parsePorcelainPaths(r.stdout) : [];
  } catch {
    return [];
  }
}

// Paths staged in the index relative to HEAD.
function stagedPaths(cwd) {
  try {
    const r = runGit(cwd, ['diff', '--cached', '--name-only', '-z']);
    return succeeded(r) ? splitNul(r.stdout) : [];
  } catch {
    return [];
  }
}

// Subset of <paths> that git ignores. The index is consulted, so a tracked
// file is never reported even when an ignore rule matches it. Paths travel on
// stdin, NUL-delimited, which keeps arbitrary names out of argv.
function ignoredPaths(cwd, paths) {
  try {
    if (!Array.isArray(paths) || paths.length === 0) return [];
    const r = runGit(cwd, ['check-ignore', '-z', '--stdin'], { input: `${paths.join('\0')}\0` });
    // Exit 1 means nothing matched; any other failure also reports nothing ignored.
    return succeeded(r) ? splitNul(r.stdout) : [];
  } catch {
    return [];
  }
}

function branchExists(cwd, branch) {
  return succeeded(runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]));
}

// Creates <branch> and switches to it. A refused create that is explained by an
// existing branch is GIT_BRANCH_EXISTS; HEAD never moves on failure.
function createAndSwitch(cwd, branch) {
  return guardMutation(() => {
    if (!isBranchName(branch)) return failure('GIT_INVALID_BRANCH', 'invalid branch name');
    const r = runGit(cwd, ['switch', '-c', branch]);
    if (succeeded(r)) return success(r);
    if (branchExists(cwd, branch)) {
      return failure('GIT_BRANCH_EXISTS', `branch ${branch} already exists`, r);
    }
    return failure('GIT_BRANCH_CREATE_FAILED', `could not create branch ${branch}`, r);
  });
}

// Repo-local config value for <key>, or null when unset or unreadable. Read-only.
function localConfigGet(cwd, key) {
  try {
    const r = runGit(cwd, ['config', '--local', '--get', key]);
    return succeeded(r) ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

// Sets repo-local <key> to <value>, replacing any earlier value.
function localConfigSet(cwd, key, value) {
  return guardMutation(() => outcome(runGit(cwd, ['config', '--local', key, value]), 'GIT_CONFIG_FAILED', `could not set ${key}`));
}

// Removes repo-local <key>. Exit 5 (key absent) already is the wanted state.
function localConfigUnset(cwd, key) {
  return guardMutation(() => {
    const r = runGit(cwd, ['config', '--local', '--unset', key]);
    if (r.status === 5) return success(r);
    return outcome(r, 'GIT_CONFIG_FAILED', `could not unset ${key}`);
  });
}

// Switches the working tree to an existing <branch>.
function switchBranch(cwd, branch) {
  return guardMutation(() => {
    if (!isBranchName(branch)) return failure('GIT_INVALID_BRANCH', 'invalid branch name');
    return outcome(runGit(cwd, ['switch', branch]), 'GIT_SWITCH_FAILED', `could not switch to ${branch}`);
  });
}

// Stages exactly <paths>. Never uses -A or '.'; `--` precedes the paths.
function addPaths(cwd, paths) {
  return guardMutation(() => {
    if (!Array.isArray(paths) || paths.length === 0) return failure('GIT_NO_PATHS', 'no paths given');
    return outcome(runGit(cwd, ['add', '--', ...paths]), 'GIT_ADD_FAILED', 'could not stage paths');
  });
}

// `git var` exits 128 when neither config nor auto-detection yields an identity.
// The exit code is checked rather than git's localized error text.
function identityAvailable(cwd) {
  return ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].every((name) => succeeded(runGit(cwd, ['var', name])));
}

// Commits the staged index with `subject` and `trailer` as separate paragraphs.
// Hooks run normally; --no-verify is never passed. The commit is bounded by
// `timeoutMs` so an interactive hook or signing prompt cannot hang the caller.
// Once the prechecks pass, `git commit` exits 1 only when a hook rejects the
// commit; fatal errors exit 128.
function commitWithTrailer(cwd, options) {
  return guardMutation(() => {
    const { subject, trailer, timeoutMs = DEFAULT_COMMIT_TIMEOUT_MS } = options || {};
    if (typeof subject !== 'string' || subject.trim() === '' || typeof trailer !== 'string' || trailer.trim() === '') {
      return failure('GIT_INVALID_MESSAGE', 'subject and trailer are required');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return failure('GIT_INVALID_TIMEOUT', 'timeoutMs must be a positive number');
    }
    if (stagedPaths(cwd).length === 0) {
      return failure('GIT_NOTHING_STAGED', 'nothing staged to commit');
    }
    if (!identityAvailable(cwd)) {
      return failure('GIT_IDENTITY_MISSING', 'git has no author identity; set user.name and user.email');
    }
    const r = runGit(cwd, ['commit', '-m', subject, '-m', trailer], { timeout: timeoutMs });
    if (succeeded(r)) return success(r);
    if (r.error && r.error.code === 'ETIMEDOUT') {
      return failure('GIT_COMMIT_TIMEOUT', `commit did not finish within ${timeoutMs}ms`, r);
    }
    if (r.status === 1) return failure('GIT_HOOK_FAILED', 'a commit hook rejected the commit', r);
    return failure('GIT_COMMIT_FAILED', 'commit failed', r);
  });
}

// Value of trailer <key> on the HEAD commit message, or null.
function headTrailer(cwd, key) {
  try {
    if (typeof key !== 'string' || !/^[A-Za-z0-9-]+$/.test(key)) return null;
    const r = runGit(cwd, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`]);
    if (!succeeded(r)) return null;
    const value = r.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return value ? value.trim() : null;
  } catch {
    return null;
  }
}

module.exports = {
  currentBranch,
  branchTip,
  mergeBase,
  repoPathPrefix,
  dirtyPaths,
  stagedPaths,
  ignoredPaths,
  createAndSwitch,
  switchBranch,
  localConfigGet,
  localConfigSet,
  localConfigUnset,
  addPaths,
  commitWithTrailer,
  headTrailer,
};
