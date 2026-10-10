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
const { writeFileAtomicSync } = require('../cli/lib/atomic-file');
const lifecycleProof = require('./lifecycle-proof');
const lifecycleWatermark = require('./lifecycle-watermark');

const TRANSIENT_IO_ERROR_CODES = new Set([
  'EAGAIN', 'EBUSY', 'EINTR', 'EIO', 'EMFILE', 'ENFILE', 'ESTALE', 'ETIMEDOUT', 'EWOULDBLOCK',
]);

function isTransientIoError(error) {
  return Boolean(error && TRANSIENT_IO_ERROR_CODES.has(error.code));
}

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
    if ((error && error.code === 'ENTERPRISE_META_PATH_INVALID') || isTransientIoError(error)) throw error;
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
    if (isTransientIoError(error)) throw error;
    throw metaPathError();
  }

  let target;
  try {
    target = fs.realpathSync(metadataPath);
  } catch (error) {
    if (isTransientIoError(error)) throw error;
    // A dangling symlink is present according to lstat but has no safe target.
    throw metaPathError();
  }
  if (!isInside(physical.specDir, target)) throw metaPathError();
  try {
    if (!fs.statSync(target).isFile()) throw metaPathError();
  } catch (error) {
    if ((error && error.code === 'ENTERPRISE_META_PATH_INVALID') || isTransientIoError(error)) throw error;
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
  writeFileAtomicSync(target.path, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

const LIFECYCLE_DELIVERY_SCHEMA = lifecycleWatermark.LIFECYCLE_DELIVERY_SCHEMA;

function readLifecycleDelivery(specDir, planId, context) {
  return lifecycleWatermark.readLifecycleDelivery(specDir, planId, context, readMetaFor);
}

function lifecycleEventProof(specDir, event, context) {
  return lifecycleProof.lifecycleEventProofFromMetadata(readMetaFor(specDir, context), event);
}

function recoverLifecycleDelivery(specDir, event, context) {
  return lifecycleWatermark.recoverLifecycleDelivery(specDir, event, context, { readMetaFor, writeMetaFor });
}

function advanceLifecycleDelivery(specDir, planId, revision, context) {
  return lifecycleWatermark.advanceLifecycleDelivery(specDir, planId, revision, context, { readMetaFor, writeMetaFor });
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

// Stack identity for a phase PR (T11). Written only after a successful publish,
// so a blocked or failed publish never touches metadata. Merges into the phase's
// github_pr entry and leaves every sibling key (issue, review, approval) unchanged.
function setPrStackIdentity(specDir, phase, identity = {}, context) {
  if (typeof phase !== 'string' || phase.length === 0) {
    throw new Error('ENTERPRISE_META: phase must be a non-empty string');
  }
  const { number, url, head, base, parent_pr: parentPr, head_sha: headSha } = identity;
  validatePositiveInteger(number, 'PR number');
  if (url !== undefined && (typeof url !== 'string' || url.length === 0)) {
    throw new Error('ENTERPRISE_META: PR url must be a non-empty string');
  }
  if (typeof head !== 'string' || head.length === 0) throw new Error('ENTERPRISE_META: PR head must be a non-empty string');
  if (typeof base !== 'string' || base.length === 0) throw new Error('ENTERPRISE_META: PR base must be a non-empty string');
  if (parentPr !== null && parentPr !== undefined) validatePositiveInteger(parentPr, 'parent PR number');
  if (typeof headSha !== 'string' || !PUSH_APPROVAL_SHA.test(headSha)) {
    throw new Error('ENTERPRISE_META: PR head_sha must be 40 lowercase hex characters');
  }
  const patch = { number, head, base, head_sha: headSha };
  if (url !== undefined) patch.url = url;
  patch.parent_pr = parentPr === undefined ? null : parentPr;
  const meta = readMetaFor(specDir, context);
  coreMeta.setPr(meta, phase, patch);
  writeMetaFor(specDir, meta, context);
  return getPrIdentity(specDir, phase);
}

// --- Per-SHA push approval (Enterprise-owned consent fallback) ---

const PUSH_APPROVAL_SHA = /^[0-9a-f]{40}$/;
const PUSH_APPROVAL_PHASE_KEY = /^phase-[1-9][0-9]*$/;

function consentInvalid(message) {
  const error = new Error(`ENTERPRISE_CONSENT: ${message}`);
  error.code = 'ENTERPRISE_CONSENT_INVALID';
  return error;
}

function validatePhaseKey(phase) {
  if (typeof phase !== 'string' || !PUSH_APPROVAL_PHASE_KEY.test(phase)) {
    throw consentInvalid('phase key must be phase-<positive integer>');
  }
}

function validateApprovalSha(sha) {
  if (typeof sha !== 'string' || !PUSH_APPROVAL_SHA.test(sha)) {
    throw consentInvalid('sha must be 40 lowercase hex characters');
  }
}

function getPushApproval(specDir, phase, context) {
  validatePhaseKey(phase);
  const meta = readMetaFor(specDir, context);
  const approval = ((meta.phases || {})[phase] || {}).push_approval || {};
  const out = {};
  if (typeof approval.sha === 'string') out.sha = approval.sha;
  if (typeof approval.approved_at === 'string') out.approved_at = approval.approved_at;
  return out;
}

// Validates everything before the read-modify-write so invalid input never touches
// .pocket-meta.json. Missing metadata fails closed instead of creating a new file.
function setPushApproval(specDir, phase, { sha } = {}, context) {
  validatePhaseKey(phase);
  validateApprovalSha(sha);
  preflightMetaFor(specDir, context);
  const meta = readMetaFor(specDir, context);
  coreMeta.setDotted(meta, `phases.${phase}.push_approval`, {
    sha,
    approved_at: new Date().toISOString(),
  });
  writeMetaFor(specDir, meta, context);
  return getPushApproval(specDir, phase, context);
}

// --- Opaque Core-facing proof refs (no remote identity leaks) ---

function issueProofRef() {
  return lifecycleProof.issueProofRef();
}

function phasePrProofRef(phase) {
  return `meta:phases.${phase}.github_pr`;
}

module.exports = {
  resolveMetaPath,
  isTransientIoError,
  preflightMetaFor,
  readMetaFor,
  writeMetaFor,
  LIFECYCLE_DELIVERY_SCHEMA,
  readLifecycleDelivery,
  lifecycleEventProof,
  recoverLifecycleDelivery,
  advanceLifecycleDelivery,
  getIssueIdentity,
  setIssueIdentity,
  getPrIdentity,
  setPrIdentity,
  setPrStackIdentity,
  getPushApproval,
  setPushApproval,
  issueProofRef,
  phasePrProofRef,
};
