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
  writeFileAtomicSync(target.path, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

const LIFECYCLE_DELIVERY_SCHEMA = 1;
const LIFECYCLE_DELIVERY_FIELDS = ['schema', 'plan_id', 'last_applied_revision'];
const PROOF_HASH_PATTERN = /^[0-9a-f]{64}$/;

function lifecycleDeliveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateLifecycleDelivery(metadata, planId) {
  const delivery = metadata.lifecycle_delivery;
  if (delivery === undefined) {
    return { schema: LIFECYCLE_DELIVERY_SCHEMA, plan_id: planId, last_applied_revision: 0 };
  }
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)
      || Object.keys(delivery).some((key) => !LIFECYCLE_DELIVERY_FIELDS.includes(key))
      || LIFECYCLE_DELIVERY_FIELDS.some((key) => !(key in delivery))
      || delivery.schema !== LIFECYCLE_DELIVERY_SCHEMA
      || delivery.plan_id !== planId
      || !Number.isInteger(delivery.last_applied_revision)
      || delivery.last_applied_revision < 0) {
    throw lifecycleDeliveryError('LIFECYCLE_DELIVERY_INVALID', 'Enterprise lifecycle delivery watermark is malformed or belongs to a different plan. Resolve metadata before retrying.');
  }
  return delivery;
}

function readLifecycleDelivery(specDir, planId, context) {
  return validateLifecycleDelivery(readMetaFor(specDir, context), planId);
}

function lifecycleEventProof(specDir, event, context) {
  const metadata = readMetaFor(specDir, context);
  let proofRef;
  let proof;
  if (event.type === 'spec-approved') {
    proof = metadata.github_issue && metadata.github_issue.ownership;
    proofRef = issueProofRef();
    if (!proof || proof.event_id !== event.event_id || proof.plan_id !== event.plan_id
        || !PROOF_HASH_PATTERN.test(proof.proof_hash || '')) return null;
    return { proof_ref: proofRef, proof_hash: proof.proof_hash };
  }
  if (event.type === 'phase-complete') {
    const ref = event.artifact_refs.find((artifact) => artifact.root === 'plan' && artifact.kind === 'phase-evidence');
    const match = ref && typeof ref.path === 'string' ? /phase[-_](\d+)/i.exec(ref.path) : null;
    if (!match) return null;
    const phaseKey = `phase-${Number(match[1])}`;
    proof = metadata.phases && metadata.phases[phaseKey]
      && metadata.phases[phaseKey].review && metadata.phases[phaseKey].review.proof;
    proofRef = `meta:phases.${phaseKey}.github_pr+meta:phases.${phaseKey}.review.fingerprints`;
    if (!proof || proof.event_id !== event.event_id || proof.plan_id !== event.plan_id
        || proof.phase_key !== phaseKey || proof.proof_ref !== proofRef
        || !PROOF_HASH_PATTERN.test(proof.proof_hash || '')) return null;
    return { proof_ref: proofRef, proof_hash: proof.proof_hash };
  }
  if (event.type === 'plan-closed') {
    proof = metadata.github_issue && metadata.github_issue.tasklist;
    proofRef = 'meta:github_issue|marker:issue-tasklist';
    if (!proof || proof.event_id !== event.event_id || proof.plan_id !== event.plan_id
        || proof.revision !== event.revision || proof.proof_ref !== proofRef
        || !PROOF_HASH_PATTERN.test(proof.proof_hash || '')) return null;
    return { proof_ref: proofRef, proof_hash: proof.proof_hash };
  }
  return null;
}

function advanceLifecycleDelivery(specDir, planId, revision, context) {
  const metadata = readMetaFor(specDir, context);
  const current = validateLifecycleDelivery(metadata, planId);
  if (revision <= current.last_applied_revision) return current;
  if (revision !== current.last_applied_revision + 1) {
    throw lifecycleDeliveryError('REVISION_GAP', `Lifecycle revision ${revision} cannot advance the watermark from ${current.last_applied_revision}.`);
  }
  const delivery = {
    schema: LIFECYCLE_DELIVERY_SCHEMA,
    plan_id: planId,
    last_applied_revision: revision,
  };
  metadata.lifecycle_delivery = delivery;
  writeMetaFor(specDir, metadata, context);
  return delivery;
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
  LIFECYCLE_DELIVERY_SCHEMA,
  readLifecycleDelivery,
  lifecycleEventProof,
  advanceLifecycleDelivery,
  getIssueIdentity,
  setIssueIdentity,
  getPrIdentity,
  setPrIdentity,
  issueProofRef,
  phasePrProofRef,
};
