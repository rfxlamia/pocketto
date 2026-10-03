'use strict';

// Enterprise metadata seam (T7, Cycle 3).
//
// Thin wrapper over cli/lib/meta.js for origin/ownership validation —
// never rewritten here. All GitHub IDs reach Core-opaque proof only
// through these helpers; Core never reads `.pocket-meta.json` remote
// identity directly.

const fs = require('node:fs');
const path = require('node:path');
const coreMeta = require('../cli/lib/meta');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function metaPathError(code = 'ENTERPRISE_META_PATH_INVALID') {
  const message = code === 'ENTERPRISE_META_MISSING'
    ? 'Metadata file is missing from the selected plan spec directory.'
    : 'Metadata path must resolve to a regular file inside the selected plan spec directory.';
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveMetaContext(specDir, context) {
  if (typeof specDir !== 'string' || !path.isAbsolute(specDir)) throw metaPathError();
  const hasExplicitContext = context && typeof context === 'object'
    && (context.projectRoot !== undefined || context.specDir !== undefined);
  try {
    if (hasExplicitContext) {
      if (typeof context.projectRoot !== 'string' || !path.isAbsolute(context.projectRoot)
          || typeof context.specDir !== 'string' || !path.isAbsolute(context.specDir)) {
        throw metaPathError();
      }
      const root = fs.realpathSync(context.projectRoot);
      const specPath = path.resolve(context.specDir);
      const physicalSpecDir = fs.realpathSync(specPath);
      if (physicalSpecDir !== specPath || path.resolve(specDir) !== physicalSpecDir
          || physicalSpecDir === root || !isInside(root, physicalSpecDir)
          || !fs.statSync(root).isDirectory() || !fs.statSync(physicalSpecDir).isDirectory()) {
        throw metaPathError();
      }
      return { root, specDir: physicalSpecDir };
    }

    // Standalone Enterprise metadata helpers use the explicit specDir argument
    // as their physical boundary. Registered handlers always supply projectRoot.
    const physicalSpecDir = fs.realpathSync(specDir);
    if (!fs.statSync(physicalSpecDir).isDirectory()) throw metaPathError();
    return { root: physicalSpecDir, specDir: physicalSpecDir };
  } catch (error) {
    if (error && error.code === 'ENTERPRISE_META_PATH_INVALID') throw error;
    throw metaPathError();
  }
}

function resolveSafeMetaTarget(specDir, context) {
  const physical = resolveMetaContext(specDir, context);
  const metadataPath = path.join(physical.specDir, coreMeta.META_FILE);
  try {
    fs.lstatSync(metadataPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path: metadataPath, exists: false };
    throw metaPathError();
  }

  let target;
  try {
    target = fs.realpathSync(metadataPath);
  } catch {
    // A dangling symlink is present according to lstat but has no safe target.
    throw metaPathError();
  }
  if (!isInside(physical.specDir, target)) throw metaPathError();
  try {
    if (!fs.statSync(target).isFile()) throw metaPathError();
  } catch (error) {
    if (error && error.code === 'ENTERPRISE_META_PATH_INVALID') throw error;
    throw metaPathError();
  }
  return { path: target, exists: true };
}

function resolveMetaPath(specDir) {
  return coreMeta.metaPathFor(specDir);
}

function preflightMetaFor(specDir, context, { allowMissing = false } = {}) {
  const target = resolveSafeMetaTarget(specDir, context);
  if (!target.exists && !allowMissing) throw metaPathError('ENTERPRISE_META_MISSING');
  return target;
}

function readMetaFor(specDir, context) {
  const target = resolveSafeMetaTarget(specDir, context);
  return coreMeta.readMeta(target.path);
}

function writeMetaFor(specDir, meta, context) {
  const target = resolveSafeMetaTarget(specDir, context);
  coreMeta.writeMeta(target.path, meta);
  return meta;
}

// --- Issue identity (Enterprise-owned GitHub IDs) ---

function getIssueIdentity(specDir) {
  const meta = readMetaFor(specDir);
  const issue = coreMeta.getIssue(meta);
  const out = {};
  if (typeof issue.number === 'number' && Number.isInteger(issue.number) && issue.number > 0) {
    out.number = issue.number;
  }
  if (typeof issue.url === 'string' && issue.url.length > 0) {
    out.url = issue.url;
  }
  return out;
}

function validatePositiveInteger(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`ENTERPRISE_META: ${name} must be a positive integer`);
  }
}

function setIssueIdentity(specDir, { number, url } = {}) {
  if (number !== undefined) validatePositiveInteger(number, 'issue number');
  if (url !== undefined && (typeof url !== 'string' || url.length === 0)) {
    throw new Error('ENTERPRISE_META: issue url must be a non-empty string');
  }
  const meta = readMetaFor(specDir);
  const patch = {};
  if (number !== undefined) patch.number = number;
  if (url !== undefined) patch.url = url;
  coreMeta.setIssue(meta, patch);
  writeMetaFor(specDir, meta);
  return getIssueIdentity(specDir);
}

// --- Phase PR identity (Enterprise-owned GitHub IDs) ---

function getPrIdentity(specDir, phase) {
  if (typeof phase !== 'string' || phase.length === 0) {
    throw new Error('ENTERPRISE_META: phase must be a non-empty string');
  }
  const meta = readMetaFor(specDir);
  const pr = coreMeta.getPr(meta, phase);
  const out = {};
  if (typeof pr.number === 'number' && Number.isInteger(pr.number) && pr.number > 0) {
    out.number = pr.number;
  }
  if (typeof pr.url === 'string' && pr.url.length > 0) {
    out.url = pr.url;
  }
  return out;
}

function setPrIdentity(specDir, phase, { number, url } = {}) {
  if (typeof phase !== 'string' || phase.length === 0) {
    throw new Error('ENTERPRISE_META: phase must be a non-empty string');
  }
  if (number !== undefined) validatePositiveInteger(number, 'PR number');
  if (url !== undefined && (typeof url !== 'string' || url.length === 0)) {
    throw new Error('ENTERPRISE_META: PR url must be a non-empty string');
  }
  const meta = readMetaFor(specDir);
  const patch = {};
  if (number !== undefined) patch.number = number;
  if (url !== undefined) patch.url = url;
  coreMeta.setPr(meta, phase, patch);
  writeMetaFor(specDir, meta);
  return getPrIdentity(specDir, phase);
}

// --- Opaque Core-facing proof refs (no remote identity leaks) ---

function issueProofRef() {
  return 'meta:github_issue';
}

function phasePrProofRef(phase) {
  return `meta:phases.${phase}.github_pr`;
}

module.exports = {
  resolveMetaPath,
  preflightMetaFor,
  readMetaFor,
  writeMetaFor,
  getIssueIdentity,
  setIssueIdentity,
  getPrIdentity,
  setPrIdentity,
  issueProofRef,
  phasePrProofRef,
};
