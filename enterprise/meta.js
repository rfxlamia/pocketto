'use strict';

// Enterprise metadata seam (T7, Cycle 3).
//
// Thin wrapper over cli/lib/meta.js for origin/ownership validation —
// never rewritten here. All GitHub IDs reach Core-opaque proof only
// through these helpers; Core never reads `.pocket-meta.json` remote
// identity directly.

const coreMeta = require('../cli/lib/meta');

function resolveMetaPath(specDir) {
  return coreMeta.metaPathFor(specDir);
}

function readMetaFor(specDir) {
  return coreMeta.readMeta(resolveMetaPath(specDir));
}

function writeMetaFor(specDir, meta) {
  coreMeta.writeMeta(resolveMetaPath(specDir), meta);
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
  readMetaFor,
  writeMetaFor,
  getIssueIdentity,
  setIssueIdentity,
  getPrIdentity,
  setPrIdentity,
  issueProofRef,
  phasePrProofRef,
};
