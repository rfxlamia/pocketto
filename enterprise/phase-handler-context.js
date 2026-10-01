'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PhaseHandlerError, safeMessage } = require('./phase-handler-errors');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveLifecyclePath(root, value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PhaseHandlerError('PHASE_LIFECYCLE_PATH_REQUIRED', `Lifecycle metadata does not contain ${label}.`);
  }
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  if (!isInside(root, resolved)) {
    throw new PhaseHandlerError('PHASE_LIFECYCLE_PATH_INVALID', `Lifecycle ${label} must resolve inside the registered project root.`);
  }
  return resolved;
}

function loadContext(event, options = {}) {
  if (!event || typeof event.plan_id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.plan_id)) {
    throw new PhaseHandlerError('PHASE_PLAN_IDENTITY_MISMATCH', 'Lifecycle context requires a normalized event plan identity.');
  }
  if (typeof options.projectRoot !== 'string' || !path.isAbsolute(options.projectRoot)) {
    throw new PhaseHandlerError('PHASE_PROJECT_ROOT_REQUIRED', 'Lifecycle context requires the explicit absolute registered project root.');
  }
  const root = path.resolve(options.projectRoot);
  const specDir = path.resolve(root, 'docs', 'pocket', 'spec', event.plan_id);
  const lifecyclePath = path.join(specDir, 'lifecycle.json');
  let lifecycle;
  try {
    lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  } catch (error) {
    throw new PhaseHandlerError('PHASE_LIFECYCLE_UNAVAILABLE', `Cannot read phase lifecycle evidence: ${safeMessage(error)}`, {
      status: 'retryable',
      retryable: true,
    });
  }
  if (!lifecycle || lifecycle.schema !== 1 || !lifecycle.plan || lifecycle.plan.plan_id !== event.plan_id) {
    throw new PhaseHandlerError('PHASE_PLAN_IDENTITY_MISMATCH', 'Lifecycle metadata does not identify this event plan.');
  }
  const recordedSpecDir = resolveLifecyclePath(root, lifecycle.plan.spec_dir, 'spec_dir');
  const overrideSpecDir = options.specDir
    ? resolveLifecyclePath(root, options.specDir, 'specDir override')
    : specDir;
  if (recordedSpecDir !== specDir || overrideSpecDir !== specDir) {
    throw new PhaseHandlerError('PHASE_SPEC_DIR_MISMATCH', 'Lifecycle metadata does not resolve to this plan’s registered spec directory.');
  }
  const planDir = resolveLifecyclePath(root, lifecycle.plan.plan_dir, 'plan_dir');
  const overridePlanDir = options.planDir
    ? resolveLifecyclePath(root, options.planDir, 'planDir override')
    : planDir;
  if (path.basename(planDir) !== event.plan_id || overridePlanDir !== planDir) {
    throw new PhaseHandlerError('PHASE_PLAN_DIR_MISMATCH', 'Lifecycle metadata does not resolve to this plan’s registered plan directory.');
  }
  if (typeof lifecycle.plan.branch !== 'string' || lifecycle.plan.branch.length === 0) {
    throw new PhaseHandlerError('PHASE_BRANCH_REQUIRED', 'Lifecycle metadata does not contain the captured plan branch.');
  }
  return { root, specDir, planDir, branch: lifecycle.plan.branch, lifecycle };
}


module.exports = { loadContext };
