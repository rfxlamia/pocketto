'use strict';

// Core ignored-artifact probe. Warnings are display-only: they never block,
// never change an exit code, and never edit .gitignore. Git is consulted through
// the T1 seam (`ignoredPaths`), which never throws and reports nothing outside
// a repository, so a non-repo directory yields no warning.

const path = require('node:path');
const { ignoredPaths } = require('./git-worktree');
const { LIFECYCLE_FILE } = require('./lifecycle-store');
const { lifecycleSpecDirForPlan } = require('./lifecycle-transition');
const { resolveProjectRoot } = require('./lifecycle-adapter');
const { META_FILE } = require('./meta');

const CODE = 'POCKET_ARTIFACTS_IGNORED';

const CONSEQUENCES = {
  core: 'Plan artifacts matched by these ignore rules are omitted from the phase commits and PR diffs, so reviews and closeout records do not travel with the branch.',
  enterprise: 'The review audit trail (closeout, reviews, log) is not in the PR or repository history, and lifecycle and PR-identity state exists only on this machine, so another clone, teammate, or CI cannot replay or verify it.',
};

// Pocket artifacts whose ignore status matters for stacked delivery. The
// machine-local adapter registration is excluded on purpose. `specDir` is
// optional; without it only the plan-side artifacts are probed.
function pocketArtifactProbePaths({ planDir, specDir = null, phaseOrder = 1 } = {}) {
  const planSide = [
    path.join(planDir, 'log.json'),
    path.join(planDir, 'closeout.md'),
    path.join(planDir, 'reviews', `closeout-phase-${phaseOrder}.md`),
  ];
  const specSide = specDir ? [path.join(specDir, LIFECYCLE_FILE), path.join(specDir, META_FILE)] : [];
  return [...planSide, ...specSide];
}

// Repo-relative, forward-slash form of <p> from <base>, or null when <p> is not
// inside <base>. Relative names go to git, so the caller's path spelling (for
// example a macOS /var vs /private/var prefix) never has to match git's view.
function relativeInside(base, p) {
  const rel = path.relative(base, path.resolve(base, p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Deepest directory shared by every <rel> path, or '' when they share none.
function commonParent(rels) {
  const dirs = rels.map((rel) => rel.split('/').slice(0, -1));
  let shared = dirs[0] || [];
  for (const segments of dirs.slice(1)) {
    let i = 0;
    while (i < shared.length && i < segments.length && shared[i] === segments[i]) i += 1;
    shared = shared.slice(0, i);
  }
  return shared.join('/');
}

function buildFix(rels) {
  const lines = rels.map((rel) => `git add -f ${rel}`);
  const parent = commonParent(rels);
  const target = parent ? `${parent}/` : 'the matching ignore rule';
  lines.push(
    `Or un-ignore ${target} by removing its rule from .gitignore, or add a negation such as "!${target}" after it. Pocket never edits .gitignore.`,
  );
  return lines.join('\n');
}

// Returns null when nothing in <paths> is ignored (or no repository applies);
// otherwise { code, paths, consequence, fix } for the ignored subset, in the
// caller's order and spelling.
function ignoredArtifactWarning(cwd, paths, { audience = 'core' } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const base = path.resolve(cwd);
  const entries = [];
  for (const p of paths) {
    const rel = relativeInside(base, p);
    if (rel !== null) entries.push({ original: p, rel });
  }
  if (entries.length === 0) return null;

  const ignored = new Set(ignoredPaths(base, entries.map((e) => e.rel)));
  const hits = entries.filter((e) => ignored.has(e.rel));
  if (hits.length === 0) return null;

  return {
    code: CODE,
    paths: hits.map((e) => e.original),
    consequence: CONSEQUENCES[audience] || CONSEQUENCES.core,
    fix: buildFix(hits.map((e) => e.rel)),
  };
}

// Warnings for one plan's Pocket artifacts, probed from the project root. A
// spec dir that cannot be resolved only drops the spec-side paths; warnings
// never throw and never block.
function planArtifactWarnings(planDir) {
  const dir = path.resolve(planDir);
  let specDir = null;
  try {
    specDir = lifecycleSpecDirForPlan(dir);
  } catch {
    specDir = null;
  }
  const root = resolveProjectRoot(dir) || dir;
  const warning = ignoredArtifactWarning(root, pocketArtifactProbePaths({ planDir: dir, specDir }), { audience: 'core' });
  return warning ? [warning] : [];
}

module.exports = { CODE, pocketArtifactProbePaths, ignoredArtifactWarning, planArtifactWarnings };
