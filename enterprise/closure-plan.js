'use strict';

// Final plan-state projection used by closure proof persistence.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readLog } = require('../cli/lib/logjson');
const enterpriseMeta = require('./meta');
const { PhaseHandlerError } = require('./phase-handler-errors');
const { resolvePlanArtifactPath } = require('./phase-handler-context');

function validateClosureArtifactRefs(planDir, artifactRefs) {
  const refs = Array.isArray(artifactRefs) ? artifactRefs.filter((ref) => ref.root === 'plan') : [];
  for (const ref of refs) {
    try {
      if (typeof ref.path !== 'string' || !ref.path.length || path.isAbsolute(ref.path)
          || ref.path.split(/[\\/]/).includes('..')) {
        throw new PhaseHandlerError('STALE_ARTIFACT', 'Committed plan closure evidence must use a contained plan-root path.');
      }

      const root = fs.realpathSync(planDir);
      const filePath = resolvePlanArtifactPath(root, ref.path, 'plan closure evidence');
      let candidate = root;
      let artifactStat;
      for (const component of path.normalize(ref.path).split(path.sep).filter((part) => part && part !== '.')) {
        candidate = path.join(candidate, component);
        artifactStat = fs.lstatSync(candidate);
        if (artifactStat.isSymbolicLink()) {
          throw new PhaseHandlerError('STALE_ARTIFACT', 'Committed plan closure evidence must not traverse symbolic links.');
        }
      }
      if (!artifactStat || !artifactStat.isFile()) {
        throw new PhaseHandlerError('STALE_ARTIFACT', 'Committed plan closure evidence must be a regular file.');
      }

      const contents = fs.readFileSync(filePath);
      const digest = crypto.createHash('sha256').update(contents).digest('hex');
      if (digest !== ref.sha256) {
        throw new PhaseHandlerError('STALE_ARTIFACT', 'Committed plan closure evidence no longer matches its SHA-256.');
      }
    } catch (error) {
      if (error instanceof PhaseHandlerError && error.code === 'STALE_ARTIFACT') throw error;
      if (enterpriseMeta.isTransientIoError(error)) {
        throw new PhaseHandlerError('CLOSEOUT_ARTIFACT_UNAVAILABLE',
          'Committed plan closure evidence could not be read because of a temporary I/O failure; retry delivery.', {
            status: 'retryable',
            retryable: true,
          });
      }
      throw new PhaseHandlerError('STALE_ARTIFACT',
        'Committed plan closure evidence is missing, unsafe, or no longer matches its SHA-256.');
    }
  }
}

function readPlan(planDir, artifactRefs) {
  validateClosureArtifactRefs(planDir, artifactRefs);
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
