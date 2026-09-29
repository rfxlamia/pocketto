'use strict';

// Neutral lifecycle transition coordinator (T3).
//
// Core-only orchestration: commits lifecycle state plus event through the T2
// store BEFORE any projection work. Phase (cycle 2) and closure (cycle 3)
// emission live here; later cycles add projection repair and local-first
// dispatch here so `cli/commands/log.js` stays free of inline lifecycle
// orchestration.
//
// Boundary: never imports enterprise/**, never shells to `gh`, never reads
// GitHub IDs, credentials, or Enterprise policy.

const path = require('node:path');
const { readFileSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { CliError } = require('./envelope');
const { EVENT_TYPES } = require('./lifecycle-contract');
const { commitTransition, readLifecycleDoc, lifecyclePathFor, hashBytes: sha256Bytes } = require('./lifecycle-store');
const { writeFileAtomicSync } = require('./atomic-file');
const { writeProjection: defaultWriteProjection } = require('./logjson');

// Parses one `--artifact <root>:<kind>:<relative-path>:<sha256>` flag value.
// The relative path may itself contain ':' — it is everything between kind
// and the trailing sha256. The artifact revision defaults to 1; deeper shape
// validation stays in the T1 contract / T2 store (fail-closed there).
function parseArtifactFlag(value) {
  const parts = String(value).split(':');
  if (parts.length < 4) {
    throw new CliError(
      'USAGE',
      `--artifact must be <root>:<kind>:<relative-path>:<sha256>, got '${value}'.`,
    );
  }
  const root = parts[0];
  const kind = parts[1];
  const sha256 = parts[parts.length - 1];
  const relPath = parts.slice(2, -1).join(':');
  if (!root || !kind || !relPath || !sha256) {
    throw new CliError(
      'USAGE',
      `--artifact must be <root>:<kind>:<relative-path>:<sha256>, got '${value}'.`,
    );
  }
  return { root, kind, path: relPath, sha256, revision: 1 };
}

// `plan_id` is the normalized kebab-slug basename of `spec_dir` (spec:
// Lifecycle Contract normative). The store validates the slug shape.
function planIdFor(specDir) {
  return path.basename(path.resolve(specDir));
}

// Commits one neutral transition and reports the local-first dispatch
// decision. With no adapter registration present, Core succeeds locally and
// defers dispatch — zero remote work (Cycle 6 hardens this boundary).
function runTransition({ specDir, type, artifactFlags, planDir = null, deps = {} } = {}) {
  if (!specDir) {
    throw new CliError('USAGE', 'Usage: pocketto-pi lifecycle transition <spec_dir> <event-type> --artifact <root>:<kind>:<relative-path>:<sha256> [--artifact ...]');
  }
  if (!EVENT_TYPES.includes(type)) {
    throw new CliError('LIFECYCLE_UNKNOWN_TYPE', `unsupported lifecycle type: ${type}`);
  }
  if (!Array.isArray(artifactFlags) || artifactFlags.length === 0) {
    throw new CliError('USAGE', `'lifecycle transition' requires at least one --artifact <root>:<kind>:<relative-path>:<sha256>.`);
  }
  const artifacts = artifactFlags.map(parseArtifactFlag);
  const planId = planIdFor(specDir);

  const res = commitTransition({
    specDir,
    planDir: planDir === undefined ? null : planDir,
    planId,
    type,
    artifacts,
    deps,
  });
  if (!res.ok) {
    throw new CliError(res.code, res.message);
  }

  const dispatch = decideDispatch(specDir);
  const data = {
    event_id: res.event.event_id,
    plan_id: planId,
    type,
    revision: res.revision,
    status: res.event.delivery.status,
    plan_dir: planDir ?? null,
    dispatch,
  };
  const human = [
    `Committed ${res.event.event_id} (revision ${res.revision})`,
    `  status   : ${data.status}`,
    `  dispatch : ${dispatch.deferred ? 'deferred' : 'dispatched'} (${dispatch.reason})`,
  ];
  return { command: 'lifecycle transition', exit: 0, human, data };
}

// Local-first dispatch decision: Core never performs remote work itself.
// The ONLY adapter signal is the project-local registration file
// `<project>/.pocket/lifecycle-adapter.json` (checked with a single
// existence probe — no child process, no filesystem reads outside the
// project, no Enterprise imports, no `gh`, no credentials). Without that
// registration present there is nothing to invoke, so Core succeeds
// locally and defers dispatch with the event pending.
const ADAPTER_REGISTRATION_REL = path.join('.pocket', 'lifecycle-adapter.json');
const NO_ADAPTER_REASON = 'no-adapter-registration';

// A project carries an adapter registration only when the Enterprise-owned
// registration file exists directly under that project root. `projectDir`
// may be a spec dir (CLI `lifecycle transition`) or a plan dir (`log`
// update/close); a missing directory simply has no registration.
function hasAdapterRegistration(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) return false;
  try {
    return existsSync(path.join(path.resolve(projectDir), ADAPTER_REGISTRATION_REL));
  } catch {
    return false;
  }
}

function decideDispatch(projectDir = null) {
  if (projectDir !== null && projectDir !== undefined && hasAdapterRegistration(projectDir)) {
    return { attempted: false, deferred: true, reason: 'adapter-registered' };
  }
  return { attempted: false, deferred: true, reason: NO_ADAPTER_REASON };
}

// Deterministic clock for tests: POCKETTO_LIFECYCLE_NOW pins `occurred_at`.
function lifecycleNow() {
  return process.env.POCKETTO_LIFECYCLE_NOW || new Date().toISOString();
}

// Current git branch of a directory, or null when unavailable (never throws:
// a missing repo cannot block the log.json projection write).
function currentBranch(planDir) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: planDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Phase evidence is the phase file itself, referenced from the `plan` root.
// Hashes the on-disk content directly (no git required), matching the T1/T2
// sha256-hex contract.
function phaseEvidenceRef(planDir, phaseFile) {
  const bytes = readFileSync(path.join(planDir, phaseFile));
  return { root: 'plan', kind: 'phase-evidence', path: phaseFile, sha256: sha256Bytes(bytes), revision: 1 };
}

// `plan_id` for a log-owned plan: the kebab-slug basename of the plan
// directory, matching the Lifecycle Contract normative slug rule. Used only
// for the `log update` emission hook; returns null when the plan directory
// name is not a valid slug (a v3-only plan with no lifecycle identity —
// emission is skipped so existing log behavior is unchanged).
function planIdForLog(planDir) {
  const slug = path.basename(path.resolve(planDir));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  return slug;
}

// Execution indexes retain the approved spec file reference. Resolve that
// file from the plan's directory/ancestors so log transitions always find the
// canonical `<spec_dir>/lifecycle.json`; legacy plans without a Spec field
// keep their existing colocated-root behavior.
function lifecycleSpecDirForPlan(planDir) {
  const indexPath = path.join(planDir, 'execution-plan', 'index.md');
  if (!existsSync(indexPath)) return planDir;
  const index = readFileSync(indexPath, 'utf8');
  const match = index.match(/^\*\*Spec:\*\*\s*(.+?)\s*$/m);
  if (!match) return planDir;
  const specFile = match[1].trim();
  if (path.isAbsolute(specFile)) return path.dirname(specFile);

  let candidateRoot = path.resolve(planDir);
  while (true) {
    const candidate = path.resolve(candidateRoot, specFile);
    if (existsSync(candidate)) return path.dirname(candidate);
    const parent = path.dirname(candidateRoot);
    if (parent === candidateRoot) break;
    candidateRoot = parent;
  }
  return path.dirname(path.resolve(specFile));
}

// Emission hook for `log update`: commits exactly one `phase-complete` event
// when a phase-level (not task-level) update moves a phase INTO REVIEW, and
// nothing otherwise. Called by `cli/commands/log.js` BEFORE the log.json
// projection write — Core commits the authoritative event FIRST, then the
// caller projects log.json; a projection failure surfaces as
// PROJECTION_REPAIR_REQUIRED with the commit durable, the event pending,
// and dispatch deferred (never dispatched on a failed projection).
// Lifecycle persistence stays with the T2 store; lifecycle.json itself is
// rewritten atomically here via the shared atomic writer for branch
// capture. Fail-closed by construction: any emission failure surfaces as a
// CliError and the projection write never happens, so log.json is never
// left ahead of the authoritative document.
//
// Boundary: no enterprise/** imports, no `gh`, no GitHub IDs.
function emitPhaseCompleteIfReview({ planDir, phaseFile, level, oldStatus, newStatus }) {
  if (level !== 'phase') return null;
  if (newStatus !== 'REVIEW') return null;
  if (oldStatus === 'REVIEW') return null;
  // v3-only plans (no lifecycle identity or no lifecycle document) keep
  // existing `log update` behavior untouched: no event, no error, no new
  // file. Only plans already carrying a lifecycle document participate.
  const planId = planIdForLog(planDir);
  if (!planId) return null;
  const specDir = lifecycleSpecDirForPlan(planDir);
  const existing = readLifecycleDoc(specDir);
  if (!existing || !existing.plan || existing.plan.plan_id !== planId) return null;
  const artifacts = [phaseEvidenceRef(planDir, phaseFile)];
  const res = commitTransition({
    specDir,
    planDir,
    planId,
    type: 'phase-complete',
    artifacts,
    deps: { now: lifecycleNow },
  });
  if (!res.ok) {
    throw new CliError(res.code, res.message);
  }
  // Capture the current branch on the committed document: the emission is
  // the point where Core observes delivery context. Idempotent with respect
  // to the event journal — the event itself is already committed, so a
  // no-op replay (identical payload) still stamps the branch.
  const branch = currentBranch(planDir);
  if (branch) {
    stampBranch(specDir, planDir, planId, branch);
  }
  return res.event;
}

// Final closure evidence is every DONE phase file, referenced from the
// `plan` root. Hashes the on-disk content directly (no git required),
// matching the T1/T2 sha256-hex contract.
function closureEvidenceRefs(planDir, phaseFiles) {
  return phaseFiles.map((phaseFile) => phaseEvidenceRef(planDir, phaseFile));
}

// Stamps the captured branch onto the committed lifecycle document (T2
// store owns persistence; lifecycle.json itself is rewritten atomically
// here via the shared atomic writer). No-op when the branch is unchanged.
function stampBranch(specDir, planDir, planId, branch) {
  const doc = readLifecycleDoc(specDir);
  if (doc && doc.plan && doc.plan.plan_id === planId && doc.plan.branch !== branch) {
    doc.plan.branch = branch;
    doc.plan.plan_dir = planDir;
    writeFileAtomicSync(lifecyclePathFor(specDir), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

// Emission hook for `log close`: commits exactly one `plan-closed` event
// when every phase is DONE, and nothing otherwise. Called by
// `cli/commands/log.js` BEFORE the log.json projection write — Core commits
// the authoritative event FIRST, then the caller projects log.json; a
// projection failure surfaces as PROJECTION_REPAIR_REQUIRED with the commit
// durable, the event pending, and dispatch deferred. Fail-closed by
// construction: any emission failure surfaces as a CliError and the
// projection write never happens, so log.json is never left ahead of the
// authoritative document.
//
// Guard: only plans already carrying a matching lifecycle document
// participate (same v3-preservation rule as cycle 2) — v3-only plans keep
// existing `log close` behavior untouched: no event, no error, no new
// file. Replay-safe by construction: an identical closure payload is a
// store-level no-op (same event ID and revision, no second event).
//
// Boundary: no enterprise/** imports, no `gh`, no GitHub IDs.
function emitPlanClosedIfDone({ planDir, phaseFiles }) {
  if (!Array.isArray(phaseFiles) || phaseFiles.length === 0) return null;
  // v3-only plans (no lifecycle identity or no lifecycle document) keep
  // existing `log close` behavior untouched: no event, no error, no new
  // file. Only plans already carrying a lifecycle document participate.
  const planId = planIdForLog(planDir);
  if (!planId) return null;
  const specDir = lifecycleSpecDirForPlan(planDir);
  const existing = readLifecycleDoc(specDir);
  if (!existing || !existing.plan || existing.plan.plan_id !== planId) return null;
  const artifacts = closureEvidenceRefs(planDir, phaseFiles);
  const res = commitTransition({
    specDir,
    planDir,
    planId,
    type: 'plan-closed',
    artifacts,
    deps: { now: lifecycleNow },
  });
  if (!res.ok) {
    throw new CliError(res.code, res.message);
  }
  // Capture the current branch on the committed document: the emission is
  // the point where Core observes delivery context. Idempotent with respect
  // to the event journal — the event itself is already committed, so a
  // no-op replay (identical payload) still stamps the branch.
  const branch = currentBranch(planDir);
  if (branch) {
    stampBranch(specDir, planDir, planId, branch);
  }
  return res.event;
}

// Runs the adapter runner for a committed event exactly once the projection
// write has succeeded. Never invoked on a projection failure — the event
// stays pending with dispatch deferred. The default runner keeps the Cycle-6
// local-first behavior (no adapter registration → deferred, zero remote
// work); the override exists only for failure injection in tests.
function dispatchCommittedEvent(event, { adapterRunner = defaultDispatchRunner } = {}) {
  return adapterRunner({ event });
}

function defaultDispatchRunner({ event } = {}) {
  const projectDir = (event && (event.plan_dir || event.spec_dir)) || null;
  return decideDispatch(projectDir);
}

// State-changing orchestration for `log update` (phase-level) and
// `log close`: commit the authoritative lifecycle event FIRST, write the
// derived `log.json` projection SECOND, dispatch LAST. A projection failure
// throws the stable repair error with the commit durable and dispatch
// deferred; dispatch never runs on a failed projection.
//
// `prepare` mutates the in-memory `log` object (the caller owns the
// projection content); `commit` emits the authoritative event and returns
// the committed event or null when no transition applies; `write` projects
// log.json (defaults to the explicit projection writer); `dispatch` runs
// the adapter (defaults to the deferred local-first runner).
// Successful transitions return `{ event, dispatch }`; no-op transitions
// return `{ event: null, dispatch: { attempted: false, deferred: true,
// reason: 'no-transition' } }`.
function runLifecycleTransition({ logPath, log, prepare, commit, write = defaultWriteProjection, dispatch = dispatchCommittedEvent } = {}) {
  if (typeof prepare === 'function') prepare();
  const event = typeof commit === 'function' ? commit() : null;
  if (!event) {
    write(logPath, log);
    return { event: null, dispatch: { attempted: false, deferred: true, reason: 'no-transition' } };
  }
  try {
    write(logPath, log);
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    const repair = new CliError(
      'PROJECTION_REPAIR_REQUIRED',
      `projection write failed for ${event.event_id} (revision ${event.revision}): ${detail}. ` +
        `Lifecycle commit is durable; event remains pending with dispatch deferred. ` +
        `Re-run the command to rebuild the log.json projection without a new event.`,
      {
        exitCode: 1,
        human: [
          `Projection write failed for ${event.event_id} (revision ${event.revision}): ${detail}.`,
          `Lifecycle commit is durable; event remains pending with dispatch deferred.`,
          `Re-run the command to rebuild the log.json projection without a new event.`,
        ].join('\n'),
      },
    );
    repair.details = {
      event_id: event.event_id,
      revision: event.revision,
      lifecycle_committed: true,
      dispatch_deferred: true,
    };
    throw repair;
  }
  return { event, dispatch: dispatch(event) };
}

// Shared commit→project→dispatch wiring: resolves the injectable
// projection writer and adapter runner (null means "use the default").
function transitionDeps(deps = {}) {
  return {
    write: deps.projectionWriter || defaultWriteProjection,
    dispatch: deps.adapterRunner
      ? (event) => dispatchCommittedEvent(event, { adapterRunner: deps.adapterRunner })
      : dispatchCommittedEvent,
  };
}

// Commit-first `log update` orchestration: emits the authoritative
// phase-complete event, then projects the REVIEW status into log.json, then
// dispatches. `mutate` applies the status change to the in-memory log.
// No-op statuses (non-phase, non-REVIEW, repeated REVIEW, v3-only plans)
// still project log.json and report `{ event: null }`.
function runPhaseUpdateTransition({ planDir, logPath, log, phaseFile, level, oldStatus, newStatus, mutate, deps = {} } = {}) {
  return runLifecycleTransition({
    planDir,
    logPath,
    log,
    prepare: mutate,
    commit: () => emitPhaseCompleteIfReview({ planDir, phaseFile, level, oldStatus, newStatus }),
    ...transitionDeps(deps),
  });
}

// Commit-first `log close` orchestration: emits the authoritative plan-closed
// event, then projects the DONE status into log.json, then dispatches.
// `mutate` applies the closure to the in-memory log. No-op closes (v3-only
// plans, replayed closures) still project log.json and report
// `{ event: null }`.
function runPlanCloseTransition({ planDir, logPath, log, phaseFiles, mutate, deps = {} } = {}) {
  return runLifecycleTransition({
    planDir,
    logPath,
    log,
    prepare: mutate,
    commit: () => emitPlanClosedIfDone({ planDir, phaseFiles }),
    ...transitionDeps(deps),
  });
}

module.exports = { parseArtifactFlag, planIdFor, runTransition, emitPhaseCompleteIfReview, emitPlanClosedIfDone, runLifecycleTransition, runPhaseUpdateTransition, runPlanCloseTransition, dispatchCommittedEvent, decideDispatch, hasAdapterRegistration };
