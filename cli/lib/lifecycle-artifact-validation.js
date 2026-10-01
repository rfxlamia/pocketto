'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requiredPlanDir(type) {
  return type === 'phase-complete' || type === 'plan-closed';
}

function allowedRootsFor(type) {
  if (type === 'spec-approved') return ['spec'];
  return ['spec', 'plan'];
}

function rootDirFor(root, specDir, planDir) {
  return root === 'spec' ? specDir : planDir;
}

function resolveArtifactPath(ref, rootDir, statFn, realpathFn) {
  const candidate = path.resolve(rootDir, ref.path);
  const rootSyntactic = path.resolve(rootDir);
  const rel = path.relative(rootSyntactic, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
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
  if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) {
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

module.exports = {
  validateArtifactOnDisk,
  hashBytes,
  requiredPlanDir,
  allowedRootsFor,
  rootDirFor,
};
