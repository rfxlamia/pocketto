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

module.exports = { getGitSha };
