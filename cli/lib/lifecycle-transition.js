'use strict';

// Neutral lifecycle transition coordinator (T3).
//
// Core-only orchestration: commits lifecycle state plus event through the T2
// store BEFORE any projection work. Later cycles add phase/closure emission,
// projection repair, and local-first dispatch here so `cli/commands/log.js`
// stays free of inline lifecycle orchestration.
//
// Boundary: never imports enterprise/**, never shells to `gh`, never reads
// GitHub IDs, credentials, or Enterprise policy.

const path = require('node:path');
const { CliError } = require('./envelope');
const { EVENT_TYPES } = require('./lifecycle-contract');
const { commitTransition } = require('./lifecycle-store');

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

module.exports = { parseArtifactFlag, planIdFor, runTransition };
