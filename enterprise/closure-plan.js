'use strict';

// Final plan-state projection used by closure proof persistence.

const path = require('node:path');
const { readLog } = require('../cli/lib/logjson');

function readPlan(planDir) {
  let log;
  try {
    log = readLog(path.join(planDir, 'log.json'));
  } catch {
    return { ok: false, code: 'PLAN_STATE_UNAVAILABLE', message: 'Final plan log is unavailable or malformed.' };
  }
  if (!log.header || log.header.status !== 'DONE' || !Array.isArray(log.phases)
      || log.phases.length === 0 || log.phases.some((phase) => phase.status !== 'DONE')) {
    return { ok: false, code: 'PLAN_NOT_CLOSED', message: 'Plan closure requires a DONE plan with every phase DONE.' };
  }
  return { ok: true, log };
}

function proofState(log) {
  return {
    status: log.header.status,
    phases: log.phases.map((phase) => ({
      file: phase.file,
      status: phase.status,
      tasks: (phase.tasks || []).map((task) => ({
        id: task.id,
        status: task.status,
        done_sha: task.done_sha || null,
      })),
    })),
  };
}

module.exports = { readPlan, proofState };
