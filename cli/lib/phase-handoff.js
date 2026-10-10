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
const { spawnSync } = require('node:child_process');
const { CliError } = require('./envelope');
const { readLogChecked } = require('./logjson');
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
const { currentBranch, dirtyPaths, repoPathPrefix } = require('./git-worktree');
const { resolveProjectRoot, REGISTRATION_PATH } = require('./lifecycle-adapter');
const { planArtifactWarnings } = require('./artifact-ignore');

function snapshotRel(order) {
  return `reviews/closeout-phase-${order}.md`;
}

const HEADING = /^#{1,6}\s/;
const MARKER_PREFIX = '<!-- pocket-closeout:';

function closeoutMarker(order) {
  return `${MARKER_PREFIX}phase-${order} -->`;
}

// Indexes of lines that are exactly <marker> (surrounding whitespace aside).
// Never a substring or heading match: phase-1 must not match phase-10.
function markerLines(lines, marker) {
  const hits = [];
  lines.forEach((line, i) => {
    if (line.trim() === marker) hits.push(i);
  });
  return hits;
}

// closeout.md split into lines, or HANDOFF_CLOSEOUT_MISSING when the file is
// absent or the phase's exact marker is not there exactly once.
function readCloseoutLines(planDir, order) {
  const file = path.join(planDir, 'closeout.md');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : null;
  const hits = lines ? markerLines(lines, closeoutMarker(order)) : [];
  if (hits.length !== 1) {
    const reason = hits.length === 0 ? 'has no' : `has ${hits.length} copies of the`;
    throw new CliError(
      'HANDOFF_CLOSEOUT_MISSING',
      `${file} ${reason} ${closeoutMarker(order)} section. It needs exactly one; append or repair the phase's closeout section (pocket-closing), then rerun log handoff.`,
    );
  }
  return { lines, start: hits[0] };
}

// The phase's closeout section: from its marker line up to the next
// `<!-- pocket-closeout:` marker line or EOF. Each marker sits directly under
// its own heading, so the heading line that belongs to the next marker is
// left out, and trailing whitespace is normalized to one newline. The result
// is therefore unchanged when later sections are appended.
function extractSection({ lines, start }) {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith(MARKER_PREFIX)) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end);
  if (end < lines.length) {
    while (section.length > 1 && section[section.length - 1].trim() === '') section.pop();
    if (section.length > 1 && HEADING.test(section[section.length - 1])) section.pop();
  }
  return `${section.join('\n').replace(/\s+$/, '')}\n`;
}

// HEAD must be exactly this phase's recorded branch; detached HEAD is a
// mismatch too.
function assertOnPhaseBranch(planDir, phase) {
  const head = currentBranch(planDir);
  if (head === phase.branch) return;
  throw new CliError(
    'PHASE_BRANCH_MISMATCH',
    `${phase.file} belongs on ${phase.branch}, but HEAD is ${head === null ? 'detached' : head}. ` +
      `Run: git switch ${phase.branch}`,
  );
}

// Worktree paths from `git worktree list --porcelain`. The first entry is the
// main worktree. Null when git cannot list them (fail closed by the caller).
function worktreeList(cwd) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0 || r.error) return null;
  return r.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

// Pocket parallel groups register task worktrees (conventionally under
// .worktree/). Any registered worktree besides the main one means a group may
// still hold unmerged work, so handoff refuses. Entries are counted, never
// compared as path strings.
function assertNoExtraWorktrees(planDir) {
  const list = worktreeList(planDir);
  if (list === null) {
    throw new CliError('HANDOFF_WORKTREES_ACTIVE', 'Could not list git worktrees (git worktree list --porcelain failed), so handoff cannot confirm no parallel group is active.');
  }
  const extra = list.slice(1);
  if (extra.length === 0) return;
  const err = new CliError(
    'HANDOFF_WORKTREES_ACTIVE',
    `Other git worktrees are still registered: ${extra.join(', ')}. Merge or finish the parallel group, remove them with git worktree remove <path> (and git worktree prune), then rerun log handoff.`,
  );
  err.details = { worktrees: extra };
  throw err;
}

// Repo-relative, forward-slash path of <p> under <root>, or null when outside.
function relativeUnder(root, p) {
  const rel = path.relative(root, path.resolve(root, p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// The allowed dirty set, as git-toplevel-relative prefixes: the plan dir, the
// spec dir (lifecycle document), and the machine-local adapter registration
// file (Pocket-owned, untracked by design; `log init` tolerates it too).
// An unknown repository base allows nothing (fail closed).
function allowedPrefixes(planDir) {
  const projectRoot = resolveProjectRoot(planDir) || planDir;
  const gitBase = repoPathPrefix(projectRoot);
  if (gitBase === null) return [];
  let specDir = null;
  try {
    specDir = lifecycleSpecDirForPlan(planDir);
  } catch {
    specDir = null;
  }
  const registration = path.join(projectRoot, REGISTRATION_PATH);
  return [planDir, specDir, registration]
    .filter(Boolean)
    .map((p) => relativeUnder(projectRoot, p))
    .filter(Boolean)
    .map((rel) => `${gitBase}${rel}`);
}

function assertCleanOutsidePlan(planDir) {
  const prefixes = allowedPrefixes(planDir);
  const foreign = dirtyPaths(planDir).filter((p) => !prefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)));
  if (foreign.length === 0) return;
  const err = new CliError(
    'DIRTY_OUTSIDE_PLAN',
    `Uncommitted changes outside the plan and spec directories: ${foreign.join(', ')}. Commit, stash, or revert them, then rerun log handoff.`,
  );
  err.details = { paths: foreign };
  throw err;
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

// Step 1: preconditions, in spec order. Every refusal throws before anything
// is written. Returns the plan context the later steps need.
function checkPreconditions(planDir, phaseFileArg, findPhaseInLog) {
  const logPath = path.join(planDir, 'log.json');
  if (!existsSync(logPath)) {
    throw new CliError('NO_LOG', `log.json not found at '${logPath}'. Run 'pocketto-pi log init' first.`);
  }
  const log = readLogChecked(logPath);
  const mode = log.header && log.header.phase_branches ? log.header.phase_branches.mode : 'none';
  if (mode !== 'stacked') {
    throw new CliError(
      'HANDOFF_NOT_STACKED',
      `${logPath} records phase_branches '${mode || 'none'}'; log handoff applies only to stacked plans. Nothing was changed.`,
    );
  }
  const phase = findPhaseInLog(log, phaseFileArg);
  if (!phase) {
    const available = log.phases.map((p) => p.file);
    throw new CliError('PHASE_NOT_FOUND', `'${phaseFileArg}' not found in log. Available: ${JSON.stringify(available)}`);
  }
  if (phase.status !== 'DONE') {
    throw new CliError(
      'HANDOFF_PHASE_NOT_DONE',
      `${phase.file} is ${phase.status}; handoff runs only after the phase is DONE. Close the phase first (pocket-closing), then rerun log handoff.`,
    );
  }
  const closeout = readCloseoutLines(planDir, phase.order);
  assertOnPhaseBranch(planDir, phase);
  assertNoExtraWorktrees(planDir);
  assertCleanOutsidePlan(planDir);
  return { logPath, log, phase, closeout };
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

function handoff(positionals, { findPhaseInLog, resolvePlanDir, projectionWriter = null, adapterRunner = null } = {}) {
  if (positionals.length !== 2) {
    throw new CliError('USAGE', 'Usage: pocketto-pi log handoff <plan_dir> <phase_file>');
  }
  const planDir = resolvePlanDir(positionals[0]);
  const { logPath, log, phase, closeout } = checkPreconditions(planDir, positionals[1], findPhaseInLog);
  const order = phase.order;
  const snapshot = ensureSnapshot(planDir, order, closeout);

  // Step 3: commit the event first, then project log.json (commit-before-
  // project). An identical rerun replays in the store and appends nothing.
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
      order,
      snapshot: { path: snapshot.path, sha256: snapshot.sha256 },
      nextIdentity: next,
    }),
    ...transitionDeps({ projectionWriter, adapterRunner }),
  });

  // Steps 4-5 (commit, next branch) are not performed here.
  const steps = {
    snapshot: snapshot.step,
    event: eventStep(outcome.event, revisionBefore),
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

module.exports = { handoff };
