'use strict';

// Core phase-branch strategy for `log init`. Strategy is chosen once, on a
// fresh init: explicit flag -> valid adapter registration -> `none`. A stacked
// init creates pocket/<plan_id>/phase-1 at HEAD, records the root base in
// git config (branch.<phase-1>.pocketRootBase) before the create, and records
// the identity in log.json. Adopt reads only that config record; it never
// guesses the base. Core reads only neutral registration fields and never
// consults Enterprise mode configuration.

const path = require('node:path');
const { CliError } = require('./envelope');
const { readLog } = require('./logjson');
const {
  currentBranch,
  branchTip,
  mergeBase,
  repoPathPrefix,
  dirtyPaths,
  createAndSwitch,
  localConfigGet,
  localConfigSet,
  localConfigUnset,
} = require('./git-worktree');
const { planArtifactWarnings } = require('./artifact-ignore');
const { lifecycleSpecDirForPlan, planIdForLog } = require('./lifecycle-transition');
const { resolveProjectRoot, readRegisteredPhaseBranches, PHASE_BRANCH_MODES, REGISTRATION_PATH } = require('./lifecycle-adapter');

// Value of the explicit flag, or null when none was passed. Anything else is
// a usage error, reported before the plan or git is touched.
function assertRequested(requested) {
  if (requested === null || requested === undefined) return null;
  if (!PHASE_BRANCH_MODES.includes(requested)) {
    throw new CliError('USAGE', `--phase-branches must be one of: ${PHASE_BRANCH_MODES.join(', ')}.`);
  }
  return requested;
}

// An existing log fixes its strategy. Only an explicit flag that differs from
// the recorded mode is refused; a missing or no-flag call leaves migrate
// behavior unchanged. An unreadable log is left for migrateExisting to report.
function assertUnlocked({ logPath, requested }) {
  if (!requested) return;
  let recorded;
  try {
    const log = readLog(logPath);
    recorded = (log && log.header && log.header.phase_branches && log.header.phase_branches.mode) || 'none';
  } catch {
    return;
  }
  if (recorded !== requested) {
    throw new CliError(
      'PHASE_BRANCHES_LOCKED',
      `${logPath} already records phase_branches '${recorded}'; a strategy is fixed at init and cannot change to '${requested}'.`,
    );
  }
}

// Precedence: explicit flag -> valid registration -> none. The registration is
// read only when no flag was given, so it never affects an explicit choice.
function selectInitStrategy({ planDir, requested }) {
  if (requested) return { mode: requested, source: 'flag', warnings: [] };
  const projectRoot = resolveProjectRoot(planDir) || planDir;
  const { value, warning } = readRegisteredPhaseBranches(projectRoot);
  if (value) return { mode: value, source: 'registration', warnings: [] };
  return { mode: 'none', source: 'default', warnings: warning ? [warning] : [] };
}

// Repo-relative, forward-slash path of <p> under <root>, or null when outside.
function relativeUnder(root, p) {
  const rel = path.relative(root, path.resolve(root, p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Plan dir, the spec dir, and the machine-local adapter registration file, as
// repo-root-relative prefixes: project-relative paths rebased onto gitBase (the
// project root's location in the repo). The registration is one exact file,
// never a directory. An unresolvable spec dir leaves only the others allowed
// (reported as a concern).
function allowedPrefixes(planDir, projectRoot, gitBase) {
  let specDir = null;
  try {
    specDir = lifecycleSpecDirForPlan(planDir);
  } catch {
    specDir = null;
  }
  const registration = path.join(projectRoot, REGISTRATION_PATH);
  const candidates = [planDir, specDir, registration].filter(Boolean).map((p) => relativeUnder(projectRoot, p));
  return candidates.filter(Boolean).map((rel) => `${gitBase}${rel}`);
}

function isUnder(prefix, rel) {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

// Shared dirty-set guard for `log init` and `log handoff`. <command> names the
// rerun command shown in the hint (for example 'log init' or 'log handoff').
function assertCleanOutsidePlan(planDir, command) {
  const projectRoot = resolveProjectRoot(planDir) || planDir;
  // dirtyPaths reports paths relative to the git toplevel, so the allowed set is
  // rebased onto the same base. An unknown base allows nothing (fail closed).
  const gitBase = repoPathPrefix(projectRoot);
  const prefixes = gitBase === null ? [] : allowedPrefixes(planDir, projectRoot, gitBase);
  const foreign = dirtyPaths(planDir).filter((p) => !prefixes.some((prefix) => isUnder(prefix, p)));
  if (foreign.length === 0) return;
  const err = new CliError(
    'DIRTY_OUTSIDE_PLAN',
    `Uncommitted changes outside the plan and spec directories: ${foreign.join(', ')}. Commit, stash, or revert them, then rerun ${command}.`,
  );
  err.details = { paths: foreign };
  throw err;
}

// Plan-dir basename, validated with the lifecycle slug rule. Null when invalid.
function planIdOrFail(planDir) {
  const planId = planIdForLog(planDir);
  if (!planId) {
    throw new CliError(
      'PHASE_BRANCHES_PLAN_ID_INVALID',
      `Plan directory name '${path.basename(path.resolve(planDir))}' is not a kebab-case slug (lowercase letters, digits, single hyphens). Rename the plan directory, then rerun log init --phase-branches stacked.`,
    );
  }
  return planId;
}

// Repo-local config key that records the root base of a stacked phase-1 branch.
function rootBaseKey(branch) {
  return `branch.${branch}.pocketRootBase`;
}

// Root base recorded at create time. Adopt uses it only when the named base
// branch still exists; anything else throws before any write.
function recordedRootBase(planDir, branch) {
  const key = rootBaseKey(branch);
  const base = localConfigGet(planDir, key);
  if (base && branchTip(planDir, `refs/heads/${base}`)) return base;
  const reason = base ? `the recorded base branch '${base}' no longer exists` : `${key} is not set`;
  throw new CliError(
    'PHASE_BRANCHES_ROOT_BASE_UNKNOWN',
    `HEAD is already on ${branch}, but ${reason}, so the root base cannot be recovered. Manual action: run git config --local ${key} <base-branch> with the branch this stack was created from, then rerun log init --phase-branches stacked. HEAD and log.json were not changed.`,
  );
}

// Records the root base first, then creates the branch, so an adopted branch
// always has its record. A refused create removes the record again. Returns a
// createAndSwitch-shaped result; a record that cannot be written is
// PHASE_BRANCHES_ROOT_BASE_UNKNOWN, because no base can be recorded for adopt.
function recordAndCreate(planDir, branch, rootBranch) {
  const key = rootBaseKey(branch);
  const recorded = localConfigSet(planDir, key, rootBranch);
  if (!recorded.ok) {
    return {
      ok: false,
      code: 'PHASE_BRANCHES_ROOT_BASE_UNKNOWN',
      message: `Could not record root base '${rootBranch}' for ${branch} in git config (${key}), so the stack was not created. HEAD and log.json were not changed. Manual action: check that the repository config is writable, then rerun log init --phase-branches stacked.`,
    };
  }
  const created = createAndSwitch(planDir, branch);
  if (created.ok) return created;
  const unset = localConfigUnset(planDir, key);
  const note = unset.ok ? '' : ` The root base record ${key} could not be removed; remove it with git config --local --unset ${key} before retrying.`;
  return { ...created, message: `${created.message}${note}` };
}

// Fork point of the phase branch from its root base: the merge base of the base
// branch and HEAD. On adopt, HEAD may already carry phase-1 commits, so HEAD is
// not the fork point. There is no safe substitute for a missing merge base, so
// it throws before any write.
function forkPointOrFail(planDir, branch, base) {
  const sha = mergeBase(planDir, `refs/heads/${base}`, 'HEAD');
  if (sha) return sha;
  throw new CliError(
    'PHASE_BRANCHES_ROOT_BASE_UNKNOWN',
    `Cannot find the fork point of ${branch} from base '${base}' (git merge-base found no common ancestor with HEAD). Manual action: check that ${base} and HEAD share history (git merge-base refs/heads/${base} HEAD), then rerun log init --phase-branches stacked. HEAD and log.json were not changed.`,
  );
}

// Creates (or adopts) pocket/<plan_id>/phase-1 and returns the identity to
// record. Throws before any write when the init cannot be done safely.
function prepareStackedInit(planDir) {
  const planId = planIdOrFail(planDir);
  const branch = `pocket/${planId}/phase-1`;
  const rootBranch = currentBranch(planDir);
  const headSha = branchTip(planDir, 'HEAD');
  if (!rootBranch) {
    throw new CliError(
      'PHASE_BRANCHES_DETACHED',
      'HEAD is detached (or this is not a git repository). Check out a branch, then rerun log init --phase-branches stacked, or use --phase-branches none.',
    );
  }
  assertCleanOutsidePlan(planDir, 'log init');

  let rootBase;
  let branchInfo;
  if (rootBranch === branch) {
    // A prior init created this branch and recorded its base. Adopt reads only
    // that record; a missing or dangling record fails closed without a guess.
    const base = recordedRootBase(planDir, branch);
    rootBase = { branch: base, sha: forkPointOrFail(planDir, branch, base) };
    branchInfo = { from: rootBase.branch, created: null, switched: false, status: 'adopted' };
  } else {
    const existingTip = branchTip(planDir, branch);
    if (existingTip) {
      throw branchExistsError(branch, existingTip, headSha);
    }
    // Checked before recordAndCreate, so a missing fork point writes nothing.
    const forkSha = forkPointOrFail(planDir, branch, rootBranch);
    const created = recordAndCreate(planDir, branch, rootBranch);
    if (!created.ok) {
      if (created.code === 'GIT_BRANCH_EXISTS') throw branchExistsError(branch, branchTip(planDir, branch), headSha);
      throw new CliError(created.code, created.message);
    }
    rootBase = { branch: rootBranch, sha: forkSha };
    branchInfo = { from: rootBranch, created: branch, switched: true, status: 'created' };
  }

  return {
    header: { mode: 'stacked', root_base: rootBase },
    branch,
    rootBaseBranch: rootBase.branch,
    branchInfo,
    warnings: planArtifactWarnings(planDir),
  };
}

function branchExistsError(branch, existingTip, rootSha) {
  return new CliError(
    'PHASE_BRANCHES_BRANCH_EXISTS',
    `Branch ${branch} already exists at ${existingTip || 'an unknown commit'} and is not the current HEAD (${rootSha || 'unknown'}). Manual action: rename or delete that branch (for example \`git branch -m ${branch} ${branch}.old\`), then rerun log init --phase-branches stacked. HEAD was not changed.`,
  );
}

// Additive envelope fields for `log init`. `stacked` is null for `none`.
function initEnvelope({ strategy, stacked }) {
  return {
    phase_branches: { mode: strategy.mode, source: strategy.source },
    branch: stacked ? stacked.branchInfo : null,
    warnings: [...strategy.warnings, ...(stacked ? stacked.warnings : [])],
    next_actions: [],
  };
}

module.exports = {
  assertRequested,
  assertUnlocked,
  selectInitStrategy,
  prepareStackedInit,
  initEnvelope,
  // Shared with phase-handoff-preconditions.js (same dirty-set guard).
  assertCleanOutsidePlan,
  allowedPrefixes,
  isUnder,
};
