'use strict';

const { readFileSync } = require('node:fs');
const { writeFileAtomicSync } = require('./atomic-file');
const { CliError } = require('./envelope');
const { acquireLifecycleGuard, releaseLifecycleGuard } = require('./lifecycle-lock');
const { PIPELINE, PIPELINE_FLOOR_CLI, MARKERLESS_FLOOR_CLI } = require('./version');

// log.json is written with 2-space indent + trailing newline to match the
// previous Python writer byte-for-byte (json.dumps(..., indent=2) + "\n").
function readLog(logPath) {
  const content = readFileSync(logPath, 'utf8');
  try {
    return JSON.parse(content);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new SyntaxError(`invalid log projection at ${logPath}: ${err.message}`, { cause: err });
  }
}

// State-changing commands call this AFTER readLog and BEFORE any mutation or
// writeLog. Read-only consumers (format tasklist) must keep using readLog.
function assertPipeline(log, logPath) {
  const detected = log && log.header ? log.header.pipeline : undefined;
  const valid = Number.isInteger(detected);
  if (!valid || detected < PIPELINE) {
    const named = detected == null ? 'absent' : valid ? detected : 'invalid';
    // An absent/invalid marker predates the whole pipeline system (fixed
    // floor); a present-but-lower marker is a plan stranded by the most
    // recent PIPELINE bump (floor moves with it) — the two need different pins.
    const floor = detected == null ? MARKERLESS_FLOOR_CLI : PIPELINE_FLOOR_CLI;
    throw new CliError(
      'PIPELINE_TOO_OLD',
      `${logPath}: pipeline marker is ${named} (current is ${PIPELINE}). ` +
        `Pin the CLI with npx -y pocketto-pi@${floor} and close the plan under the old pipeline before updating.`,
    );
  }
}

function readLogChecked(logPath) {
  const log = readLog(logPath);
  assertPipeline(log, logPath);
  return log;
}

function writeLog(logPath, log) {
  // Same bytes as the historical in-place writer (2-space indent + trailing
  // newline). Publish them with temp-file plus rename so a crash cannot
  // leave a truncated projection.
  writeFileAtomicSync(logPath, JSON.stringify(log, null, 2) + '\n');
}

// All log.json read-modify-write operations hold this guard from their first
// read through persistence. Repair may probe before locking, but must re-read
// under the guard before applying lifecycle-owned fields.
function withProjectionMutation(logPath, mutate) {
  let guard;
  try {
    guard = acquireLifecycleGuard(`${logPath}.projection-lock`, { wait: true });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new CliError('LOG_PROJECTION_LOCK_FAILED', `could not serialize log.json mutation: ${detail}`);
  }
  if (!guard) throw new CliError('LOG_PROJECTION_LOCK_FAILED', 'could not acquire the log.json projection guard');
  try {
    return mutate();
  } finally {
    releaseLifecycleGuard(guard);
  }
}

// Explicit projection writer: `log.json` is a derived, repairable
// projection of the authoritative lifecycle document — never the authority
// itself. Callers must hold withProjectionMutation from read through write;
// the optional writer override exists only for failure injection in tests.
function writeProjection(logPath, log, { writer = writeLog } = {}) {
  writer(logPath, log);
}

// Local-time YYYY-MM-DD, matching Python date.today().isoformat().
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = {
  readLog,
  writeLog,
  writeProjection,
  withProjectionMutation,
  todayISO,
  assertPipeline,
  readLogChecked,
};
