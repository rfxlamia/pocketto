'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { CliError } = require('./envelope');
const { PIPELINE } = require('./version');

// log.json is written with 2-space indent + trailing newline to match the
// previous Python writer byte-for-byte (json.dumps(..., indent=2) + "\n").
function readLog(logPath) {
  return JSON.parse(readFileSync(logPath, 'utf8'));
}

// State-changing commands call this AFTER readLog and BEFORE any mutation or
// writeLog. Read-only consumers (format tasklist) must keep using readLog.
function assertPipeline(log, logPath) {
  const detected = log && log.header ? log.header.pipeline : undefined;
  if (detected == null || detected < PIPELINE) {
    const named = detected == null ? 'absent' : detected;
    throw new CliError(
      'PIPELINE_TOO_OLD',
      `${logPath}: pipeline marker is ${named} (current is ${PIPELINE}). ` +
        `Pin the CLI with npx -y pocketto-pi@2.4.4 and close the plan under the old pipeline before updating.`,
    );
  }
}

function readLogChecked(logPath) {
  const log = readLog(logPath);
  assertPipeline(log, logPath);
  return log;
}

function writeLog(logPath, log) {
  writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n');
}

// Local-time YYYY-MM-DD, matching Python date.today().isoformat().
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { readLog, writeLog, todayISO, assertPipeline, readLogChecked };
