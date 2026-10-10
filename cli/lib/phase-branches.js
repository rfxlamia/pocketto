'use strict';

// Core phase-branch strategy for `log init`. Strategy is chosen once, on a
// fresh init: explicit flag -> valid adapter registration -> `none`. A stacked
// init creates pocket/<plan_id>/phase-1 at HEAD and records its identity; every
// failure happens before any write. Core reads only neutral registration
// fields and never consults Enterprise mode configuration.

const path = require('node:path');
const { CliError } = require('./envelope');
const { readLog } = require('./logjson');
const { currentBranch, previousBranch, branchTip, dirtyPaths, createAndSwitch } = require('./git-worktree');
const { planArtifactWarnings } = require('./artifact-ignore');
const { lifecycleSpecDirForPlan, planIdForLog } = require('./lifecycle-transition');
const { resolveProjectRoot, readRegisteredPhaseBranches, PHASE_BRANCH_MODES } = require('./lifecycle-adapter');

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

// Plan dir plus the spec dir, as repo-relative prefixes. An unresolvable spec
// dir leaves only the plan dir allowed (reported as a concern, not a warning).
function allowedPrefixes(planDir, projectRoot) {
  let specDir = null;
  try {
    specDir = lifecycleSpecDirForPlan(planDir);
  } catch {
    specDir = null;
  }
  const candidates = [planDir, specDir].filter(Boolean).map((dir) => relativeUnder(projectRoot, dir));
  return candidates.filter(Boolean);
}

function isUnder(prefix, rel) {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

function assertCleanOutsidePlan(planDir) {
  const projectRoot = resolveProjectRoot(planDir) || planDir;
  const prefixes = allowedPrefixes(planDir, projectRoot);
  const foreign = dirtyPaths(planDir).filter((p) => !prefixes.some((prefix) => isUnder(prefix, p)));
  if (foreign.length === 0) return;
  const err = new CliError(
    'DIRTY_OUTSIDE_PLAN',
    `Uncommitted changes outside the plan and spec directories: ${foreign.join(', ')}. Commit, stash, or revert them, then rerun log init.`,
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

// Creates (or adopts) pocket/<plan_id>/phase-1 and returns the identity to
// record. Throws before any write when the init cannot be done safely.
function prepareStackedInit(planDir) {
  const planId = planIdOrFail(planDir);
  const branch = `pocket/${planId}/phase-1`;
  const rootBranch = currentBranch(planDir);
  const rootSha = branchTip(planDir, 'HEAD');
  if (!rootBranch) {
    throw new CliError(
      'PHASE_BRANCHES_DETACHED',
      'HEAD is detached (or this is not a git repository). Check out a branch, then rerun log init --phase-branches stacked, or use --phase-branches none.',
    );
  }
  assertCleanOutsidePlan(planDir);

  let rootBase;
  let branchInfo;
  if (rootBranch === branch) {
    // A prior init switched here and stopped. The base is the previous checkout,
    // accepted only when it still points at HEAD (the phase branch has no commits
    // yet). Anything else cannot be recorded safely, so init fails closed.
    const base = previousBranch(planDir);
    const baseTip = base ? branchTip(planDir, base) : null;
    if (!base || baseTip !== rootSha) {
      throw new CliError(
        'PHASE_BRANCHES_ROOT_BASE_UNKNOWN',
        `HEAD is already on ${branch}, but its original base branch cannot be recovered (the previous checkout is not a branch at HEAD). Manual action: switch to the base branch you intended, recreate ${branch} from it, then rerun log init --phase-branches stacked.`,
      );
    }
    rootBase = { branch: base, sha: baseTip };
    branchInfo = { from: base, created: null, switched: false, status: 'adopted' };
  } else {
    const existingTip = branchTip(planDir, branch);
    if (existingTip) {
      throw branchExistsError(branch, existingTip, rootSha);
    }
    const created = createAndSwitch(planDir, branch);
    if (!created.ok) {
      if (created.code === 'GIT_BRANCH_EXISTS') throw branchExistsError(branch, branchTip(planDir, branch), rootSha);
      throw new CliError(created.code, created.message);
    }
    rootBase = { branch: rootBranch, sha: rootSha };
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
};
