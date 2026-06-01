'use strict';

const { readFileSync, writeFileSync } = require('node:fs');

// log.json is written with 2-space indent + trailing newline to match the
// previous Python writer byte-for-byte (json.dumps(..., indent=2) + "\n").
function readLog(logPath) {
  return JSON.parse(readFileSync(logPath, 'utf8'));
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

module.exports = { readLog, writeLog, todayISO };
