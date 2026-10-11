'use strict';

// Steps 4-5 of `log handoff` (stacked plans): the handoff commit and the next
// phase branch. Both run only after steps 1-3 have succeeded.
//
// Boundary: local only. No push, no `gh`, no enterprise/** imports.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CliError } = require('./envelope');
const {
  addPaths,
  branchTip,
  commitWithTrailer,
  createAndSwitch,
  dirtyPaths,
  headTrailer,
  ignoredPaths,
  repoPathPrefix,
  stagedPaths,
  switchBranch,
} = require('./git-worktree');
const { resolveProjectRoot, REGISTRATION_PATH } = require('./lifecycle-adapter');
const { isUnder } = require('./phase-branches');
const { pocketArtifactProbePaths, ignoredArtifactWarning } = require('./artifact-ignore');

const TRAILER_KEY = 'Pocket-Handoff';
const DEFAULT_COMMIT_TIMEOUT_MS = 120000;
// The machine-local adapter registration is never committed, so it never
// counts as dirt left behind by a commit.
const REGISTRATION_REL = REGISTRATION_PATH.split(path.sep).join('/');
// Transient lock records. `log handoff` runs under the log.json projection lock,
// so its guard file exists while the commit runs and is removed when the command
// returns. Never committed, and never counted as dirt left behind.
const LOCK_RECORD_NAMES = new Set(['log.json.projection-lock.guard', '.lifecycle.lock.guard']);

function isMachineLocal(rel) {
  if (rel === null) return false;
  return rel === REGISTRATION_REL || LOCK_RECORD_NAMES.has(path.posix.basename(rel));
}

// Bound on the handoff commit (signing or a slow hook must not hang the CLI).
// POCKETTO_HANDOFF_COMMIT_TIMEOUT_MS overrides it; tests use it to force timeouts.
function commitTimeoutMs() {
  const raw = Number(process.env.POCKETTO_HANDOFF_COMMIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMMIT_TIMEOUT_MS;
}

// Project-root-relative POSIX path of <p>, or null when <p> is outside <root>.
function relToRoot(root, p) {
  const rel = path.relative(root, path.resolve(p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// git reports paths from the repository top level. <gitBase> is the project
// root's location inside that top level ('' at the top, otherwise 'app/').
function toProjectRel(gitRel, gitBase) {
  if (!gitBase) return gitRel;
  return gitRel.startsWith(gitBase) ? gitRel.slice(gitBase.length) : null;
}

// Step 4: commit the committable plan artifacts (dirty paths under the plan dir
// or spec dir, minus ignored ones) with the Pocket-Handoff trailer. Returns
// 'committed', 'already' (HEAD carries the trailer) or 'skipped' (nothing to
// commit). Explicit pathspecs only; hooks run; nothing is pushed.
function commitPlanArtifacts({ planDir, phase, specDir, planId }) {
  const projectRoot = resolveProjectRoot(planDir) || planDir;
  // A HEAD commit already carrying this phase's trailer means the step is done.
  if (headTrailer(projectRoot, TRAILER_KEY) === `${planId}/phase-${phase.order}`) {
    return { status: 'already', sha: branchTip(projectRoot, 'HEAD'), paths: [], skipped: [] };
  }
  const gitBase = repoPathPrefix(projectRoot);
  const roots = [planDir, specDir]
    .filter(Boolean)
    .map((p) => relToRoot(projectRoot, p))
    .filter(Boolean);
  // `git commit` takes the whole index, so anything staged outside the plan and
  // spec dirs would be swept in. A staged registration counts as foreign here.
  const sweptIn = stagedPaths(projectRoot).filter((gitRel) => {
    const rel = toProjectRel(gitRel, gitBase);
    return rel === null || isMachineLocal(rel) || !roots.some((root) => isUnder(root, rel));
  });
  if (sweptIn.length > 0) {
    throw new CliError(
      'STAGED_OUTSIDE_PLAN',
      `Staged changes outside the plan and spec directories: ${sweptIn.join(', ')}. Nothing was committed. ` +
        `Unstage them with git restore --staged <path>, then rerun log handoff for ${phase.file}.`,
    );
  }
  const committable = dirtyPaths(projectRoot)
    .map((gitRel) => toProjectRel(gitRel, gitBase))
    .filter((rel) => rel !== null && roots.some((root) => isUnder(root, rel)) && !isMachineLocal(rel));

  const ignored = new Set(ignoredPaths(projectRoot, committable));
  const toStage = committable.filter((rel) => !ignored.has(rel));
  if (toStage.length === 0) {
    return { status: 'skipped', sha: null, paths: [], skipped: skippedArtifacts({ projectRoot, planDir, specDir, phaseOrder: phase.order }) };
  }
  const added = stagePaths(projectRoot, toStage);
  if (!added.ok) throw new CliError(added.code, added.message);
  const subject = `chore(pocket): close ${planId} phase-${phase.order}`;
  const trailer = `${TRAILER_KEY}: ${planId}/phase-${phase.order}`;
  const committed = commitWithTrailer(projectRoot, { subject, trailer, timeoutMs: commitTimeoutMs() });
  if (!committed.ok) throw commitRefusal(committed, phase, { subject, trailer });
  const sha = branchTip(projectRoot, 'HEAD');
  // Only this run's commit is checked. Anything a hook left dirty stays out of
  // the next phase branch, which is not created until the tree is clean.
  const left = dirtyPaths(projectRoot).filter((gitRel) => !isMachineLocal(toProjectRel(gitRel, gitBase)));
  if (left.length > 0) {
    throw new CliError(
      'HANDOFF_DIRTY_AFTER_COMMIT',
      `The handoff commit was made (${sha}), but these files are left dirty: ${left.join(', ')}. A pre-commit hook may have written them. ` +
        `Remove or commit them, then rerun log handoff for ${phase.file}; the existing commit is not repeated. HEAD is still on ${phase.branch}.`,
    );
  }
  return {
    status: 'committed',
    sha,
    paths: toStage,
    skipped: skippedArtifacts({ projectRoot, planDir, specDir, phaseOrder: phase.order }),
  };
}

// POCKET_ARTIFACTS_IGNORED for this phase's artifacts, probed with this phase's
// snapshot name (closeout-phase-<order>.md). The T4 probe always used phase 1.
function phaseArtifactWarnings({ planDir, specDir, phaseOrder }) {
  const projectRoot = resolveProjectRoot(planDir) || planDir;
  const warning = ignoredArtifactWarning(projectRoot, pocketArtifactProbePaths({ planDir, specDir, phaseOrder }), { audience: 'core' });
  return warning ? [warning] : [];
}

// Plan artifacts the handoff would commit but git ignores. Reported, never staged.
function skippedArtifacts({ projectRoot, planDir, specDir, phaseOrder }) {
  const rels = pocketArtifactProbePaths({ planDir, specDir, phaseOrder })
    .map((p) => relToRoot(projectRoot, p))
    .filter(Boolean);
  return ignoredPaths(projectRoot, rels);
}

// Stages exactly <paths>, never the whole tree. A force-tracked file under an
// ignore rule is already in the index, so it is staged with `git add -u`, which
// cannot add an untracked file. Untracked paths go through the T1 addPaths seam.
// Both are explicit pathspecs; nothing is staged with -A or '.'.
function stagePaths(cwd, paths) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...paths], { cwd, encoding: 'utf8' });
  if (listed.status !== 0) return { ok: false, code: 'GIT_ADD_FAILED', message: 'could not list tracked paths' };
  const tracked = new Set(listed.stdout.split('\0').filter(Boolean));
  const trackedPaths = paths.filter((p) => tracked.has(p));
  const untrackedPaths = paths.filter((p) => !tracked.has(p));
  if (trackedPaths.length > 0) {
    const update = spawnSync('git', ['add', '-u', '--', ...trackedPaths], { cwd, encoding: 'utf8' });
    if (update.status !== 0) return { ok: false, code: 'GIT_ADD_FAILED', message: 'could not stage tracked plan artifacts' };
  }
  return untrackedPaths.length > 0 ? addPaths(cwd, untrackedPaths) : { ok: true };
}

// Seam failures from the commit, mapped to handoff codes. Each message says
// that nothing was committed and how to continue.
function commitRefusal(committed, phase, { subject, trailer }) {
  const output = `${committed.stdout}${committed.stderr}`.trim() || '(no output)';
  if (committed.code === 'GIT_HOOK_FAILED') {
    return new CliError(
      'HANDOFF_COMMIT_FAILED',
      `The pre-commit hook rejected the handoff commit. Hook output:\n${output}\nNo commit was made and HEAD is unchanged. Fix the hook, then rerun log handoff for ${phase.file}.`,
    );
  }
  if (committed.code === 'GIT_COMMIT_TIMEOUT') {
    return new CliError(
      'HANDOFF_COMMIT_TIMEOUT',
      `The handoff commit did not finish in time (a hook or commit signing may be waiting for input). No commit was made and HEAD is unchanged. ` +
        `The plan artifacts are still staged. Finish the commit by hand with: git commit -m "${subject}" -m "${trailer}" ` +
        `then rerun log handoff for ${phase.file}, or rerun it now to retry the commit step.`,
    );
  }
  if (committed.code === 'GIT_IDENTITY_MISSING') {
    return new CliError(
      'HANDOFF_GIT_IDENTITY',
      `git has no author identity, so the handoff commit was not made. Set it with: git config user.email "<you@example.com>" and git config user.name "<Your Name>", then rerun log handoff for ${phase.file}. HEAD is unchanged.`,
    );
  }
  return new CliError(committed.code, committed.message);
}

// Step 5: create the next phase branch at HEAD and switch to it. An existing
// branch is adopted only when it points at exactly HEAD.
function createNextBranch({ planDir, phase, next }) {
  const projectRoot = resolveProjectRoot(planDir) || planDir;
  if (!next) return { from: phase.branch, created: null, switched: false, status: 'none' };
  const head = branchTip(projectRoot, 'HEAD');
  const existing = branchTip(projectRoot, `refs/heads/${next.branch}`);
  if (existing) {
    if (existing !== head) throw branchConflict({ phase, next, existing, head });
    const switched = switchBranch(projectRoot, next.branch);
    if (!switched.ok) throw new CliError(switched.code, switched.message);
    return { from: phase.branch, created: null, switched: true, status: 'adopted' };
  }
  const created = createAndSwitch(projectRoot, next.branch);
  if (created.ok) return { from: phase.branch, created: next.branch, switched: true, status: 'created' };
  if (created.code === 'GIT_BRANCH_EXISTS') {
    throw branchConflict({ phase, next, existing: branchTip(projectRoot, `refs/heads/${next.branch}`), head });
  }
  throw new CliError(created.code, created.message);
}

// The event is already recorded when this runs, so the message says so and
// names the one manual action that frees the branch name.
function branchConflict({ phase, next, existing, head }) {
  return new CliError(
    'HANDOFF_BRANCH_CONFLICT',
    `Branch ${next.branch} already exists at ${existing || 'an unknown commit'} and is not the handoff commit (${head || 'unknown'}). ` +
      `The phase-closed event is recorded and HEAD stays on ${phase.branch}. ` +
      `Manual action: rename or delete that branch (for example git branch -m ${next.branch} ${next.branch}.old), then rerun log handoff for ${phase.file}.`,
  );
}

module.exports = { commitPlanArtifacts, createNextBranch, phaseArtifactWarnings };
