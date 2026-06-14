'use strict';

const { execFileSync } = require('node:child_process');

// Returns the current HEAD SHA, or null if git is unavailable / not a repo.
// Mirrors the Python get_git_sha(): never throws.
function getGitSha(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Returns the origin remote URL, or the first configured remote, or null.
// Mirrors getGitSha(): never throws.
function getRemoteUrl(cwd) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const url = out.trim();
    if (url) return url;
  } catch {
    // fall through to first remote
  }

  try {
    const list = execFileSync('git', ['remote'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!list) return null;
    const first = list.split(/\r?\n/)[0];
    const out = execFileSync('git', ['remote', 'get-url', first], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Files changed by a single commit, relative to its parent. `diff-tree -r`
// handles a root commit (no parent) without empty-tree special-casing.
// Mirrors getGitSha(): never throws — returns [] when git is unavailable.
function getCommitFiles(cwd, sha) {
  try {
    const out = execFileSync('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

// Files changed across base..head. Never throws — returns [] on failure.
function getRangeFiles(cwd, base, head) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}..${head}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

// Returns true if <sha> resolves to a commit object in the given repo, false
// otherwise (invalid sha, not a commit, or git unavailable). Never throws.
function commitExists(cwd, sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { getGitSha, getRemoteUrl, getCommitFiles, getRangeFiles, commitExists };
