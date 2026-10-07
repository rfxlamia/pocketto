'use strict';

const fs = require('node:fs');
const path = require('node:path');
const enterpriseMeta = require('./meta');
const { PhaseHandlerError, safeMessage } = require('./phase-handler-errors');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function invalidLifecyclePath(label) {
  return new PhaseHandlerError('PHASE_LIFECYCLE_PATH_INVALID', `Lifecycle ${label} must resolve inside the registered project root.`);
}

function invalidPlanArtifactPath(label) {
  return new PhaseHandlerError('PHASE_ARTIFACT_PATH_INVALID', `Lifecycle ${label} must resolve inside the selected plan root.`);
}

function transientLifecycleIo(label, error) {
  return new PhaseHandlerError('PHASE_LIFECYCLE_UNAVAILABLE',
    `Lifecycle ${label} could not be resolved because of a temporary I/O failure: ${safeMessage(error)}`, {
      status: 'retryable',
      retryable: true,
    });
}

function resolvePhysicalPlanRoot(planDir, label) {
  try {
    const root = fs.realpathSync(planDir);
    if (!fs.statSync(root).isDirectory()) throw new Error('plan root is not a directory');
    return root;
  } catch (error) {
    if (enterpriseMeta.isTransientIoError(error)) throw error;
    throw invalidPlanArtifactPath(label);
  }
}

function resolveMissingPlanArtifact(root, candidate, label, allowMissing, missingError) {
  let ancestor = path.dirname(candidate);
  let physicalAncestor;
  while (!physicalAncestor) {
    try {
      physicalAncestor = fs.realpathSync(ancestor);
    } catch (ancestorError) {
      if (enterpriseMeta.isTransientIoError(ancestorError)) throw ancestorError;
      if (!ancestorError || !['ENOENT', 'ENOTDIR'].includes(ancestorError.code)) {
        throw invalidPlanArtifactPath(label);
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw invalidPlanArtifactPath(label);
      ancestor = parent;
    }
  }
  if (!isInside(root, physicalAncestor) || !fs.statSync(physicalAncestor).isDirectory()) {
    throw invalidPlanArtifactPath(label);
  }
  if (allowMissing) return null;
  throw missingError;
}

function resolvePlanArtifactPath(planDir, relative, label, { allowMissing = false } = {}) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) {
    throw invalidPlanArtifactPath(label);
  }

  const root = resolvePhysicalPlanRoot(planDir, label);
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) throw invalidPlanArtifactPath(label);

  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return resolveMissingPlanArtifact(root, candidate, label, allowMissing, error);
    }
    throw error;
  }

  let physical;
  try {
    physical = fs.realpathSync(candidate);
  } catch (error) {
    if (enterpriseMeta.isTransientIoError(error)) throw error;
    throw invalidPlanArtifactPath(label);
  }
  if (!isInside(root, physical)) throw invalidPlanArtifactPath(label);
  return physical;
}

function resolveLifecyclePath(root, registeredRoot, value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PhaseHandlerError('PHASE_LIFECYCLE_PATH_REQUIRED', `Lifecycle metadata does not contain ${label}.`);
  }
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(registeredRoot, value);
  if (!isInside(registeredRoot, resolved) && !isInside(root, resolved)) {
    throw invalidLifecyclePath(label);
  }

  let physical;
  try {
    physical = fs.realpathSync(resolved);
  } catch (error) {
    if (enterpriseMeta.isTransientIoError(error)) throw transientLifecycleIo(label, error);
    throw invalidLifecyclePath(label);
  }
  if (!isInside(root, physical)) throw invalidLifecyclePath(label);
  return { resolved, physical };
}

function resolveLifecycleFile(root, candidate) {
  let physical;
  try {
    physical = fs.realpathSync(candidate);
  } catch (error) {
    if (enterpriseMeta.isTransientIoError(error)) throw transientLifecycleIo('lifecycle document', error);
    throw invalidLifecyclePath('lifecycle document');
  }
  const specDir = path.dirname(candidate);
  if (!isInside(root, physical) || !isInside(specDir, physical)) {
    throw invalidLifecyclePath('lifecycle document');
  }
  return physical;
}

function resolveRegisteredRoot(options) {
  if (typeof options.projectRoot !== 'string' || !path.isAbsolute(options.projectRoot)) {
    throw new PhaseHandlerError('PHASE_PROJECT_ROOT_REQUIRED', 'Lifecycle context requires the explicit absolute registered project root.');
  }
  const registeredRoot = path.resolve(options.projectRoot);
  let root;
  try {
    root = fs.realpathSync(registeredRoot);
    if (!fs.statSync(root).isDirectory()) throw new Error('registered root is not a directory');
  } catch (error) {
    if (enterpriseMeta.isTransientIoError(error)) throw transientLifecycleIo('registered project root', error);
    throw new PhaseHandlerError('PHASE_PROJECT_ROOT_INVALID', 'Registered project root must resolve to an accessible directory.');
  }
  return { registeredRoot, root };
}

function readLifecycleDocument(root, specDir) {
  const lifecyclePath = resolveLifecycleFile(root, path.join(specDir, 'lifecycle.json'));
  try {
    return JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  } catch (error) {
    if (enterpriseMeta.isTransientIoError(error)) throw transientLifecycleIo('lifecycle evidence', error);
    throw new PhaseHandlerError('PHASE_LIFECYCLE_INVALID', `Lifecycle evidence is missing or malformed: ${safeMessage(error)}`);
  }
}

function validateLifecycleContext(event, options, root, registeredRoot, specDir, lifecycle) {
  if (!lifecycle || lifecycle.schema !== 1 || !lifecycle.plan || lifecycle.plan.plan_id !== event.plan_id) {
    throw new PhaseHandlerError('PHASE_PLAN_IDENTITY_MISMATCH', 'Lifecycle metadata does not identify this event plan.');
  }
  const recordedSpecDir = resolveLifecyclePath(root, registeredRoot, lifecycle.plan.spec_dir, 'spec_dir');
  const overrideSpecDir = options.specDir
    ? resolveLifecyclePath(root, registeredRoot, options.specDir, 'specDir override')
    : { physical: specDir };
  if (recordedSpecDir.physical !== specDir || overrideSpecDir.physical !== specDir) {
    throw new PhaseHandlerError('PHASE_SPEC_DIR_MISMATCH', 'Lifecycle metadata does not resolve to this plan’s registered spec directory.');
  }
  const recordedPlanDir = resolveLifecyclePath(root, registeredRoot, lifecycle.plan.plan_dir, 'plan_dir');
  const overridePlanDir = options.planDir
    ? resolveLifecyclePath(root, registeredRoot, options.planDir, 'planDir override')
    : { physical: recordedPlanDir.physical };
  if (path.basename(recordedPlanDir.resolved) !== event.plan_id
      || overridePlanDir.physical !== recordedPlanDir.physical) {
    throw new PhaseHandlerError('PHASE_PLAN_DIR_MISMATCH', 'Lifecycle metadata does not resolve to this plan’s registered plan directory.');
  }
  if (typeof lifecycle.plan.branch !== 'string' || lifecycle.plan.branch.length === 0) {
    throw new PhaseHandlerError('PHASE_BRANCH_REQUIRED', 'Lifecycle metadata does not contain the captured plan branch.');
  }
  return { root, specDir, planDir: recordedPlanDir.physical, branch: lifecycle.plan.branch, lifecycle };
}

function loadContext(event, options = {}) {
  if (!event || typeof event.plan_id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.plan_id)) {
    throw new PhaseHandlerError('PHASE_PLAN_IDENTITY_MISMATCH', 'Lifecycle context requires a normalized event plan identity.');
  }
  const { registeredRoot, root } = resolveRegisteredRoot(options);
  const specCandidate = path.resolve(registeredRoot, 'docs', 'pocket', 'spec', event.plan_id);
  const specPath = resolveLifecyclePath(root, registeredRoot, specCandidate, 'spec directory');
  const specDir = specPath.physical;
  const expectedSpecDir = path.resolve(root, 'docs', 'pocket', 'spec', event.plan_id);
  if (specDir !== expectedSpecDir) {
    throw new PhaseHandlerError('PHASE_SPEC_DIR_MISMATCH', 'Lifecycle spec directory must resolve to the exact selected plan directory.');
  }
  const lifecycle = readLifecycleDocument(root, specDir);
  return validateLifecycleContext(event, options, root, registeredRoot, specDir, lifecycle);
}


module.exports = { loadContext, resolvePlanArtifactPath };
