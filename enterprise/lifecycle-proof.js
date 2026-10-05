'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { markerFor } = require('../cli/lib/identity');
const { TASKLIST_MARKER } = require('../cli/lib/bodies');

const PROOF_HASH_PATTERN = /^[0-9a-f]{64}$/;
const ISSUE_PROOF_REF = 'meta:github_issue';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hasExactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalArtifactRefs(event) {
  return event.artifact_refs.map((ref) => ({
    root: ref.root,
    kind: ref.kind,
    path: ref.path,
    sha256: ref.sha256,
    revision: ref.revision,
  }));
}

function canonicalProofHash(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
      || !PROOF_HASH_PATTERN.test(proof.proof_hash || '')) return null;
  const { proof_hash: persistedHash, ...proofRecord } = proof;
  const expectedHash = sha256(JSON.stringify(proofRecord));
  return persistedHash === expectedHash ? expectedHash : null;
}

function validFingerprintRecords(value) {
  return Array.isArray(value) && value.every((record) => record && typeof record === 'object'
    && !Array.isArray(record) && typeof record.fingerprint === 'string'
    && /^[0-9a-f]{16}$/.test(record.fingerprint)
    && (record.thread === undefined || (typeof record.thread === 'string' && record.thread.length > 0))
    && Object.keys(record).every((key) => key === 'fingerprint' || key === 'thread'));
}

function validEventIdentity(event) {
  return event && typeof event.event_id === 'string' && typeof event.plan_id === 'string'
    && Number.isInteger(event.revision) && event.event_id === `${event.plan_id}:${event.type}:r${event.revision}`
    && Array.isArray(event.artifact_refs);
}

function specApprovalProof(metadata, event) {
  const issue = metadata.github_issue;
  const proof = issue && issue.ownership;
  const identity = proof && proof.identity;
  const ref = event.artifact_refs[0];
  if (!issue || !proof || !hasExactKeys(proof, [
    'plan_id', 'repository', 'event_id', 'spec_path', 'identity', 'proof_hash',
  ]) || !['title', 'full-spec-path', 'title+full-spec-path'].includes(identity)
      || proof.event_id !== event.event_id || proof.plan_id !== event.plan_id
      || typeof proof.repository !== 'string' || proof.repository.length === 0
      || !ref || event.artifact_refs.some((artifact) => artifact.root !== 'spec')
      || !Number.isInteger(issue.number) || issue.number <= 0
      || typeof issue.url !== 'string' || issue.url.length === 0) return null;

  const specPath = `docs/pocket/spec/${event.plan_id}/${ref.path.split(path.sep).join('/')}`;
  if (proof.spec_path !== specPath || !PROOF_HASH_PATTERN.test(proof.proof_hash || '')) return null;
  const proofRecord = {
    event_id: event.event_id,
    plan_id: event.plan_id,
    repository: proof.repository,
    issue_number: issue.number,
    issue_url: issue.url,
    spec_path: proof.spec_path,
    identity,
  };
  const expectedHash = sha256(JSON.stringify(proofRecord));
  return proof.proof_hash === expectedHash
    ? { proof_ref: ISSUE_PROOF_REF, proof_hash: expectedHash }
    : null;
}

function phaseCompletionProof(metadata, event) {
  const refs = event.artifact_refs.filter((artifact) => artifact.root === 'plan' && artifact.kind === 'phase-evidence');
  const ref = refs[0];
  const match = ref && typeof ref.path === 'string' ? /phase[-_](\d+)/i.exec(ref.path) : null;
  if (!match) return null;
  const phaseNumber = Number(match[1]);
  const phaseKey = `phase-${phaseNumber}`;
  const entry = metadata.phases && metadata.phases[phaseKey];
  const review = entry && entry.review;
  const proof = review && review.proof;
  const recordedPr = entry && entry.github_pr;
  const proofRef = `meta:phases.${phaseKey}.github_pr+meta:phases.${phaseKey}.review.fingerprints`;
  if (!proof || !hasExactKeys(proof, [
    'event_id', 'plan_id', 'phase_key', 'phase_number', 'artifact_refs', 'pr_number',
    'pr_url', 'marker', 'fingerprints', 'proof_ref', 'proof_hash',
  ]) || !recordedPr || !Number.isInteger(recordedPr.number) || recordedPr.number <= 0
      || typeof recordedPr.url !== 'string' || recordedPr.url.length === 0
      || proof.event_id !== event.event_id || proof.plan_id !== event.plan_id
      || proof.phase_key !== phaseKey || proof.phase_number !== phaseNumber
      || JSON.stringify(proof.artifact_refs) !== JSON.stringify(canonicalArtifactRefs(event))
      || proof.pr_number !== recordedPr.number || proof.pr_url !== recordedPr.url
      || proof.marker !== markerFor(phaseNumber)
      || !validFingerprintRecords(proof.fingerprints)
      || JSON.stringify(review.fingerprints) !== JSON.stringify(proof.fingerprints)
      || proof.proof_ref !== proofRef) return null;

  const proofHash = canonicalProofHash(proof);
  return proofHash ? { proof_ref: proofRef, proof_hash: proofHash } : null;
}

function planClosureProof(metadata, event) {
  const issue = metadata.github_issue;
  const proof = issue && issue.tasklist;
  const proofRef = 'meta:github_issue|marker:issue-tasklist';
  if (!proof || !hasExactKeys(proof, [
    'event_id', 'plan_id', 'revision', 'issue_number', 'issue_url', 'marker', 'comment_id',
    'body_sha256', 'final_state', 'artifact_refs', 'proof_ref', 'proof_hash',
  ]) || proof.event_id !== event.event_id || proof.plan_id !== event.plan_id
      || proof.revision !== event.revision
      || !Number.isInteger(issue.number) || issue.number <= 0 || proof.issue_number !== issue.number
      || typeof issue.url !== 'string' || issue.url.length === 0 || proof.issue_url !== issue.url
      || proof.marker !== TASKLIST_MARKER
      || !Number.isInteger(proof.comment_id) || proof.comment_id <= 0
      || !PROOF_HASH_PATTERN.test(proof.body_sha256 || '')
      || !proof.final_state || typeof proof.final_state !== 'object' || Array.isArray(proof.final_state)
      || JSON.stringify(proof.artifact_refs) !== JSON.stringify(canonicalArtifactRefs(event))
      || proof.proof_ref !== proofRef) return null;

  const proofHash = canonicalProofHash(proof);
  return proofHash ? { proof_ref: proofRef, proof_hash: proofHash } : null;
}

function lifecycleEventProofFromMetadata(metadata, event) {
  if (!validEventIdentity(event)) return null;
  if (event.type === 'spec-approved') return specApprovalProof(metadata, event);
  if (event.type === 'phase-complete') return phaseCompletionProof(metadata, event);
  if (event.type === 'plan-closed') return planClosureProof(metadata, event);
  return null;
}

function issueProofRef() {
  return ISSUE_PROOF_REF;
}

module.exports = {
  lifecycleEventProofFromMetadata,
  issueProofRef,
};
