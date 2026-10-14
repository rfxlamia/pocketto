'use strict';

// `log handoff <plan_dir> <phase_file>` for stacked plans (steps 1-3).
//   1. Preconditions (fail closed, nothing written).
//   2. Snapshot: the phase's closeout section, written once to
//      <plan_dir>/reviews/closeout-phase-<order>.md.
//   3. Event + projection: a `phase-closed` lifecycle event referencing the
//      snapshot and the next phase's branch identity, then log.json.
// Steps 4-5 (commit, next branch) live in phase-handoff-git.js.
//
// Boundary: local only. No push, no `gh`, no enterprise/** imports.


const path = require('node:path');
const { readFileSync, existsSync, mkdirSync } = require('node:fs');
const { CliError } = require('./envelope');
const { writeFileAtomicSync } = require('./atomic-file');
const { hashBytes, readLifecycleDoc } = require('./lifecycle-store');
const {
  emitPhaseClosed,
  runLifecycleTransition,
  transitionDeps,
  lifecycleSpecDirForPlan,
  planIdForLog,
} = require('./lifecycle-transition');
const { pendingDrainActions } = require('./next-actions');
const { checkPreconditions, extractSection, closeoutMarker } = require('./phase-handoff-preconditions');
const { commitPlanArtifacts, createNextBranch, phaseArtifactWarnings } = require('./phase-handoff-git');
const { stagedPaths } = require('./git-worktree');

function snapshotRel(order) {
  return `reviews/closeout-phase-${order}.md`;
}

// Current lifecycle revision, or 0 when there is no document.
function lifecycleRevision(specDir) {
  const doc = specDir ? readLifecycleDoc(specDir) : null;
  return doc && doc.plan && Number.isInteger(doc.plan.revision) ? doc.plan.revision : 0;
}

// 'skipped' without a lifecycle document; 'replayed' when the store returned
// an event that already existed; otherwise 'committed'.
function eventStep(event, revisionBefore) {
  if (!event) return 'skipped';
  return event.revision <= revisionBefore ? 'replayed' : 'committed';
}

function nextPhaseIdentity(log, phase, planId) {
  const index = log.phases.indexOf(phase);
  const next = log.phases[index + 1];
  if (!next) return null;
  return {
    phaseKey: `phase-${next.order}`,
    branch: `pocket/${planId}/phase-${next.order}`,
    base_branch: phase.branch,
    entry: next,
  };
}

// Step 2: the snapshot is written once and never rewritten. A rerun verifies
// it byte-for-byte against the freshly extracted section; any difference is
// HANDOFF_SNAPSHOT_CONFLICT and nothing is touched.
function ensureSnapshot(planDir, order, closeout) {
  const section = Buffer.from(extractSection(closeout), 'utf8');
  const rel = snapshotRel(order);
  const file = path.join(planDir, rel);
  if (existsSync(file)) {
    const existing = readFileSync(file);
    if (!existing.equals(section)) {
      throw new CliError(
        'HANDOFF_SNAPSHOT_CONFLICT',
        `${file} differs from the ${closeoutMarker(order)} section in closeout.md. The snapshot is write-once and was left as is. ` +
          `Restore it to match the closeout section (or fix the section), then rerun log handoff.`,
      );
    }
    return { path: rel, sha256: hashBytes(existing), step: 'verified' };
  }
  mkdirSync(path.join(planDir, 'reviews'), { recursive: true });
  writeFileAtomicSync(file, section);
  return { path: rel, sha256: hashBytes(section), step: 'written' };
}

function eventSummary(event) {
  if (!event) return null;
  return {
    event_id: event.event_id,
    plan_id: event.plan_id,
    type: event.type,
    revision: event.revision,
    status: event.delivery.status,
  };
}

// Step 3: commit the event first, then project log.json (commit-before-
// project). An identical rerun replays in the store and appends nothing.
function commitPhaseClosed({ planDir, logPath, log, phase, snapshot, projectionWriter, adapterRunner }) {
  const specDir = lifecycleSpecDirForPlan(planDir);
  const revisionBefore = lifecycleRevision(specDir);
  const next = nextPhaseIdentity(log, phase, planIdForLog(planDir));
  const outcome = runLifecycleTransition({
    logPath,
    log,
    prepare: () => {
      if (!next) return;
      next.entry.branch = next.branch;
      next.entry.base_branch = next.base_branch;
    },
    commit: () => emitPhaseClosed({
      planDir,
      phaseFile: phase.file,
      order: phase.order,
      snapshot: { path: snapshot.path, sha256: snapshot.sha256 },
      nextIdentity: next,
    }),
    ...transitionDeps({ projectionWriter, adapterRunner }),
  });
  return { specDir, next, outcome, eventStep: eventStep(outcome.event, revisionBefore) };
}

function handoffResult({ planDir, phase, snapshot, transition, commit, branch, warnings }) {
  const order = phase.order;
  const { specDir, next, outcome } = transition;
  const steps = {
    snapshot: snapshot.step,
    event: transition.eventStep,
    commit: commit.status,
    branch: branch.status,
  };
  const human = [
    `Handed off ${phase.file} (phase-${order})`,
    `  snapshot : ${snapshot.path} (${steps.snapshot})`,
    `  event    : ${steps.event}`,
    `  commit   : ${steps.commit}`,
    `  branch   : ${steps.branch}`,
  ];
  return {
    command: 'log handoff',
    exit: 0,
    human,
    data: {
      planDir,
      phaseFile: phase.file,
      phaseKey: `phase-${order}`,
      snapshot: { path: snapshot.path, sha256: snapshot.sha256 },
      steps,
      event: eventSummary(outcome.event),
      dispatch: outcome.dispatch,
      branch,
      commit: { sha: commit.sha, paths: commit.paths, skipped: commit.skipped },
      next_phase: next ? { phase_key: next.phaseKey, branch: next.branch, base_branch: next.base_branch } : null,
      warnings: [...phaseArtifactWarnings({ planDir, specDir, phaseOrder: order }), ...warnings],
      next_actions: pendingDrainActions({ specDir, projectDir: planDir }),
    },
  };
}

// Step 1 reports staged and unstaged foreign paths alike (DIRTY_OUTSIDE_PLAN).
// Staged foreign work is the user's index, which the commit would sweep in, so
// it gets its own code. Same refusal, nothing written.
function checkPreconditionsStagedAware(planDir, phaseFileArg, findPhaseInLog) {
  try {
    return checkPreconditions(planDir, phaseFileArg, findPhaseInLog);
  } catch (err) {
    if (err.code !== 'DIRTY_OUTSIDE_PLAN' || !err.details || !Array.isArray(err.details.paths)) throw err;
    const staged = new Set(stagedPaths(planDir));
    const stagedForeign = err.details.paths.filter((p) => staged.has(p));
    if (stagedForeign.length === 0) throw err;
    const refusal = new CliError(
      'STAGED_OUTSIDE_PLAN',
      `Staged changes outside the plan and spec directories: ${stagedForeign.join(', ')}. Unstage them with git restore --staged <path>, or commit them yourself, then rerun log handoff. Nothing was changed.`,
    );
    refusal.details = { paths: stagedForeign };
    throw refusal;
  }
}

// The next phase branch is named from the plan id. A non-slug plan dir would
// yield pocket/null/phase-N, so it is refused before anything is written.
function assertPlanIdIsSlug(planDir) {
  if (planIdForLog(planDir)) return;
  throw new CliError(
    'PHASE_BRANCHES_PLAN_ID_INVALID',
    `Plan directory name '${path.basename(path.resolve(planDir))}' is not a kebab-case slug (lowercase letters, digits, single hyphens), so the next phase branch cannot be named. ` +
      `Rename the plan directory back to its slug, then rerun log handoff. Nothing was changed.`,
  );
}

function handoff(positionals, { findPhaseInLog, resolvePlanDir, projectionWriter = null, adapterRunner = null } = {}) {
  if (positionals.length !== 2) {
    throw new CliError('USAGE', 'Usage: pocketto-pi log handoff <plan_dir> <phase_file>');
  }
  const planDir = resolvePlanDir(positionals[0]);
  assertPlanIdIsSlug(planDir);
  const { logPath, log, phase, closeout, warnings } = checkPreconditionsStagedAware(planDir, positionals[1], findPhaseInLog);
  const snapshot = ensureSnapshot(planDir, phase.order, closeout);
  const transition = commitPhaseClosed({ planDir, logPath, log, phase, snapshot, projectionWriter, adapterRunner });
  const commit = commitPlanArtifacts({ planDir, phase, specDir: transition.specDir, planId: planIdForLog(planDir) });
  const branch = createNextBranch({ planDir, phase, next: transition.next });
  return handoffResult({ planDir, phase, snapshot, transition, commit, branch, warnings });
}

module.exports = { handoff };
