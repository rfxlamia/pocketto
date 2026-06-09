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

module.exports = { getGitSha, getRemoteUrl };
