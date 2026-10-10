'use strict';

// `log handoff <plan_dir> <phase_file>` for stacked plans (steps 1-3).
//   1. Preconditions (fail closed, nothing written).
//   2. Snapshot: the phase's closeout section, written once to
//      <plan_dir>/reviews/closeout-phase-<order>.md.
//   3. Event + projection: a `phase-closed` lifecycle event referencing the
//      snapshot and the next phase's branch identity, then log.json.
// Steps 4-5 (commit, next branch) are reported as 'pending'.
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
const { planArtifactWarnings } = require('./artifact-ignore');
const { checkPreconditions, extractSection, closeoutMarker } = require('./phase-handoff-preconditions');

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

// Steps 4-5 (commit, next branch) are not performed here.
function handoffResult({ planDir, phase, snapshot, transition }) {
  const order = phase.order;
  const { specDir, next, outcome } = transition;
  const steps = {
    snapshot: snapshot.step,
    event: transition.eventStep,
    commit: 'pending',
    branch: 'pending',
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
      next_phase: next ? { phase_key: next.phaseKey, branch: next.branch, base_branch: next.base_branch } : null,
      warnings: planArtifactWarnings(planDir),
      next_actions: pendingDrainActions({ specDir, projectDir: planDir }),
    },
  };
}

function handoff(positionals, { findPhaseInLog, resolvePlanDir, projectionWriter = null, adapterRunner = null } = {}) {
  if (positionals.length !== 2) {
    throw new CliError('USAGE', 'Usage: pocketto-pi log handoff <plan_dir> <phase_file>');
  }
  const planDir = resolvePlanDir(positionals[0]);
  const { logPath, log, phase, closeout } = checkPreconditions(planDir, positionals[1], findPhaseInLog);
  const snapshot = ensureSnapshot(planDir, phase.order, closeout);
  const transition = commitPhaseClosed({ planDir, logPath, log, phase, snapshot, projectionWriter, adapterRunner });
  return handoffResult({ planDir, phase, snapshot, transition });
}

module.exports = { handoff };
