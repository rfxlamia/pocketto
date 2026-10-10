'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { canonicalArtifactRef, validateArtifactRef } = require('./lifecycle-contract');

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requiredPlanDir(type) {
  return type === 'phase-complete' || type === 'phase-closed' || type === 'plan-closed';
}

function allowedRootsFor(type) {
  if (type === 'spec-approved') return ['spec'];
  return ['spec', 'plan'];
}

function rootDirFor(root, specDir, planDir) {
  return root === 'spec' ? specDir : planDir;
}

function escapesRoot(relativePath) {
  return relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
}

function resolveArtifactPath(ref, rootDir, statFn, realpathFn) {
  const candidate = path.resolve(rootDir, ref.path);
  const rootSyntactic = path.resolve(rootDir);
  const rel = path.relative(rootSyntactic, candidate);
  if (rel === '' || escapesRoot(rel)) {
    return fail('LIFECYCLE_BAD_ARTIFACT_PATH', `artifact escapes its root: ${ref.path}`);
  }

  let rootResolved;
  try {
    rootResolved = realpathFn(rootDir);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return fail('LIFECYCLE_ARTIFACT_MISSING', `artifact not found: ${ref.path}`);
    }
    return fail('LIFECYCLE_ARTIFACT_IO', `artifact unreadable: ${ref.path}`);
  }

  let stat;
  try {
    stat = statFn(candidate);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return fail('LIFECYCLE_ARTIFACT_MISSING', `artifact not found: ${ref.path}`);
    }
    return fail('LIFECYCLE_ARTIFACT_IO', `artifact unreadable: ${ref.path}`);
  }
  if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory()) {
    return fail('LIFECYCLE_ARTIFACT_MISSING', `artifact not found: ${ref.path}`);
  }

  let real;
  try {
    real = realpathFn(candidate);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return fail('LIFECYCLE_ARTIFACT_MISSING', `artifact not found: ${ref.path}`);
    }
    return fail('LIFECYCLE_ARTIFACT_IO', `artifact unreadable: ${ref.path}`);
  }
  const realRel = path.relative(rootResolved, real);
  if (realRel === '' || escapesRoot(realRel)) {
    return fail('LIFECYCLE_ARTIFACT_ESCAPE', `artifact escapes its root: ${ref.path}`);
  }
  return { ok: true, candidate };
}

// Fail-closed filesystem validation of one artifact ref against its declared
// root. Transient read/I/O failures remain retryable and never touch the journal.
function validateArtifactOnDisk(ref, rootDir, deps) {
  const statFn = (deps && deps.stat) || fs.statSync;
  const readFn = (deps && deps.readFile) || fs.readFileSync;
  const realpathFn = (deps && deps.realpath) || fs.realpathSync;
  const hashFn = (deps && deps.hashFile) || null;

  const resolved = resolveArtifactPath(ref, rootDir, statFn, realpathFn);
  if (!resolved.ok) return resolved;

  let digest;
  try {
    digest = hashFn ? hashFn(resolved.candidate) : hashBytes(readFn(resolved.candidate));
  } catch {
    return fail('LIFECYCLE_ARTIFACT_IO', `artifact unreadable: ${ref.path}`);
  }
  if (String(digest).toLowerCase() !== ref.sha256) {
    return fail('LIFECYCLE_ARTIFACT_STALE', `artifact hash mismatch: ${ref.path}`);
  }
  return { ok: true, code: null, message: null };
}

// Normalizes artifact refs, then checks plan_dir, root allowance, and on-disk
// identity. Returns { ok: true, normalized } or the first failure.
function validateTransitionArtifacts({ artifacts, type, specDir, planDir }, deps) {
  const normalized = [];
  for (const ref of artifacts) {
    const res = validateArtifactRef(ref);
    if (!res.ok) return fail(res.code, res.message);
    normalized.push(canonicalArtifactRef(ref));
  }
  if (requiredPlanDir(type) && (planDir === null || planDir === undefined)) {
    return fail('LIFECYCLE_PLAN_DIR_REQUIRED', `${type} requires a non-null plan_dir`);
  }
  const allowed = allowedRootsFor(type);
  const ioDeps = {
    stat: deps.stat, readFile: deps.readFile, realpath: deps.realpath, hashFile: deps.hashFile,
  };
  for (const ref of normalized) {
    if (!allowed.includes(ref.root)) {
      return fail('LIFECYCLE_BAD_ARTIFACT_ROOT', `${type} may not reference root: ${ref.root}`);
    }
    const rootDir = rootDirFor(ref.root, specDir, planDir);
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      return fail('LIFECYCLE_BAD_ARTIFACT_ROOT', `missing root directory for: ${ref.root}`);
    }
    const disk = validateArtifactOnDisk(ref, rootDir, ioDeps);
    if (!disk.ok) return disk;
  }
  return { ok: true, normalized };
}

module.exports = {
  validateArtifactOnDisk,
  validateTransitionArtifacts,
  hashBytes,
  requiredPlanDir,
  allowedRootsFor,
  rootDirFor,
};
