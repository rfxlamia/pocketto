'use strict';

// Final plan-state projection used by closure proof persistence.

const { readLog } = require('../cli/lib/logjson');
const enterpriseMeta = require('./meta');
const { PhaseHandlerError } = require('./phase-handler-errors');
const { resolvePlanArtifactPath } = require('./phase-handler-context');

function readPlan(planDir) {
  let log;
  try {
    const logPath = resolvePlanArtifactPath(planDir, 'log.json', 'plan log');
    log = readLog(logPath);
  } catch (error) {
    if (enterpriseMeta.isTransientIoError(error)) {
      throw new PhaseHandlerError('PLAN_STATE_UNAVAILABLE',
        'Final plan log could not be read because of a temporary I/O failure; retry delivery.', {
          status: 'retryable',
          retryable: true,
        });
    }
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
