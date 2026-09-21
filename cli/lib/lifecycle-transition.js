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
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { CliError } = require('./envelope');
const { EVENT_TYPES } = require('./lifecycle-contract');
const { commitTransition, readLifecycleDoc, lifecyclePathFor } = require('./lifecycle-store');
const { writeFileAtomicSync } = require('./atomic-file');

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

  const dispatch = decideDispatch();
  const data = {
    event_id: res.event.event_id,
    plan_id: planId,
    type,
    revision: res.revision,
    status: res.event.delivery.status,
    plan_dir: res.event && planDir === undefined ? null : (planDir === undefined ? null : planDir),
    dispatch,
  };
  const human = [
    `Committed ${res.event.event_id} (revision ${res.revision})`,
    `  status   : ${data.status}`,
    `  dispatch : deferred (no adapter registration)`,
  ];
  return { command: 'lifecycle transition', exit: 0, human, data };
}

// Local-first dispatch decision: Core never performs remote work itself.
// Without an adapter registration there is nothing to invoke.
function decideDispatch() {
  return { attempted: false, deferred: true, reason: 'no-adapter-registration' };
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

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

// Emission hook for `log update`: commits exactly one `phase-complete` event
// when a phase-level (not task-level) update moves a phase INTO REVIEW, and
// nothing otherwise. Called by `cli/commands/log.js` AFTER the log.json
// projection write — Core commits the authoritative event, then stamps the
// captured branch onto the lifecycle document (T2 store owns persistence;
// lifecycle.json itself is rewritten atomically here via the shared atomic
// writer). Fail-closed by construction: any emission failure surfaces as a
// CliError and the projection write has already succeeded, so log.json is
// never left half-written.
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
  const existing = readLifecycleDoc(planDir);
  if (!existing || !existing.plan || existing.plan.plan_id !== planId) return null;
  const artifacts = [phaseEvidenceRef(planDir, phaseFile)];
  const res = commitTransition({
    specDir: planDir,
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
    stampBranch(planDir, planId, branch);
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
function stampBranch(planDir, planId, branch) {
  const doc = readLifecycleDoc(planDir);
  if (doc && doc.plan && doc.plan.plan_id === planId && doc.plan.branch !== branch) {
    doc.plan.branch = branch;
    doc.plan.plan_dir = planDir;
    writeFileAtomicSync(lifecyclePathFor(planDir), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

// Emission hook for `log close`: commits exactly one `plan-closed` event
// when every phase is DONE, and nothing otherwise. Called by
// `cli/commands/log.js` AFTER the log.json projection write — Core commits
// the authoritative event, then stamps the captured branch onto the
// lifecycle document. Fail-closed by construction: any emission failure
// surfaces as a CliError and the projection write has already succeeded,
// so log.json is never left half-written.
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
  const existing = readLifecycleDoc(planDir);
  if (!existing || !existing.plan || existing.plan.plan_id !== planId) return null;
  const artifacts = closureEvidenceRefs(planDir, phaseFiles);
  const res = commitTransition({
    specDir: planDir,
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
    stampBranch(planDir, planId, branch);
  }
  return res.event;
}

module.exports = { parseArtifactFlag, planIdFor, runTransition, emitPhaseCompleteIfReview, emitPlanClosedIfDone };
