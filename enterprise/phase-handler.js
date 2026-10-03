'use strict';

const crypto = require('node:crypto');
const { validateEvent } = require('../cli/lib/lifecycle-contract');
const { summaryBody } = require('../cli/lib/bodies');
const identity = require('../cli/lib/identity');
const enterpriseMeta = require('./meta');
const github = require('./phase-handler-github');
const { loadContext } = require('./phase-handler-context');
const { readPhaseEvidence } = require('./phase-handler-evidence');
const { resolveRepository, resolveOwnedIssue, resolvePhasePr } = require('./phase-handler-targets');
const { readPriorFingerprints, reconcileFindings } = require('./phase-handler-findings');
const { PhaseHandlerError, phaseFailure, safeMessage } = require('./phase-handler-errors');

const RECONCILABLE_DELIVERY_STATUSES = new Set(['claimed', 'pending', 'retryable', 'reconciling']);
const PROOF_HASH_PATTERN = /^[0-9a-f]{64}$/;

function handlePhaseComplete(event, options = {}) {
  const eventId = event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event';
  try {
    const checked = validateEvent(event);
    if (!checked.ok || event.type !== 'phase-complete') {
      throw new PhaseHandlerError('PHASE_EVENT_INVALID', 'Expected a valid phase-complete lifecycle event.');
    }

    const context = loadContext(event, options);
    const phase = readPhaseEvidence(event, context);
    if (event.delivery.status === 'succeeded') return replayPhaseProof(event, context, phase);
    if (!RECONCILABLE_DELIVERY_STATUSES.has(event.delivery.status)) {
      throw new PhaseHandlerError('PHASE_DELIVERY_INELIGIBLE', 'Only claimed, pending, retryable, or reconciling phase events may enter remote reconciliation.');
    }

    const repo = resolveRepository(options);
    const meta = enterpriseMeta.readMetaFor(context.specDir);
    const issue = resolveOwnedIssue(event, context, repo, options);
    const selectedPr = resolvePhasePr(context, phase, repo, options);
    const pr = selectedPr.pr;
    const marker = identity.markerFor(phase.number);
    const commentEndpoint = `repos/${repo.nameWithOwner}/issues/${pr.number}/comments`;
    github.upsertSummary(commentEndpoint, selectedPr.comments, marker, summaryBody({
      phase: phase.number,
      verdicts: phase.verdicts,
      prLinked: true,
    }), options);

    const threads = github.listReviewThreads(repo, pr.number, options);
    const fingerprints = reconcileFindings({
      repo,
      pr,
      threads,
      prior: readPriorFingerprints(meta, phase.key),
      findings: phase.findings,
      options,
      onResolveFailure: (records) => persistPhaseProof(event, context, issue, phase, pr, marker, records),
    });

    const proofHash = persistPhaseProof(event, context, issue, phase, pr, marker, fingerprints);
    return {
      event_id: eventId,
      status: 'succeeded',
      proof_ref: phaseProofRef(phase.key),
      proof_hash: proofHash,
    };
  } catch (error) {
    if (error instanceof PhaseHandlerError) {
      return phaseFailure(eventId, error.code, error.message, error.status, error.retryable);
    }
    return phaseFailure(eventId, 'PHASE_HANDLER_FAILED', safeMessage(error), 'retryable', true);
  }
}

function replayPhaseProof(event, context, phase) {
  const delivery = event.delivery || {};
  const proofRef = phaseProofRef(phase.key);
  let metadata;
  try {
    metadata = enterpriseMeta.readMetaFor(context.specDir);
  } catch {
    return phaseFailure(event.event_id, 'PHASE_PROOF_MISMATCH', 'Succeeded event has no readable persisted phase proof; resolve metadata manually before replay.', 'terminal', false);
  }
  const entry = metadata.phases && metadata.phases[phase.key];
  const review = entry && entry.review;
  const proof = review && review.proof;
  const recordedPr = entry && entry.github_pr;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
      || !recordedPr || !Number.isInteger(recordedPr.number) || recordedPr.number <= 0
      || typeof recordedPr.url !== 'string' || recordedPr.url.length === 0
      || proof.event_id !== event.event_id
      || proof.plan_id !== event.plan_id
      || proof.phase_key !== phase.key
      || proof.phase_number !== phase.number
      || JSON.stringify(proof.artifact_refs) !== JSON.stringify(canonicalArtifactRefs(event))
      || proof.pr_number !== recordedPr.number
      || proof.pr_url !== recordedPr.url
      || proof.marker !== identity.markerFor(phase.number)
      || !validFingerprintRecords(proof.fingerprints)
      || JSON.stringify(review.fingerprints) !== JSON.stringify(proof.fingerprints)
      || proof.proof_ref !== proofRef
      || delivery.proof_ref !== proofRef
      || typeof proof.proof_hash !== 'string' || !PROOF_HASH_PATTERN.test(proof.proof_hash)
      || typeof delivery.proof_hash !== 'string' || !PROOF_HASH_PATTERN.test(delivery.proof_hash)) {
    return phaseFailure(event.event_id, 'PHASE_PROOF_MISMATCH', 'Succeeded event has no matching event-bound persisted phase proof; resolve metadata manually before replay.', 'terminal', false);
  }

  const { proof_hash: persistedHash, ...proofRecord } = proof;
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify(proofRecord), 'utf8').digest('hex');
  if (persistedHash !== expectedHash || delivery.proof_hash !== expectedHash) {
    return phaseFailure(event.event_id, 'PHASE_PROOF_MISMATCH', 'Succeeded event phase proof does not match persisted metadata; resolve metadata manually before replay.', 'terminal', false);
  }
  return {
    event_id: event.event_id,
    status: 'succeeded',
    proof_ref: delivery.proof_ref,
    proof_hash: delivery.proof_hash,
  };
}

function persistPhaseProof(event, context, issue, phase, pr, marker, fingerprints) {
  const meta = enterpriseMeta.readMetaFor(context.specDir);
  meta.github_issue = { ...(meta.github_issue || {}), number: issue.number, url: issue.url };
  const entry = phaseEntry(meta, phase.key);
  entry.github_pr = { ...(entry.github_pr || {}), number: pr.number, url: pr.url };
  const review = { ...(entry.review || {}), fingerprints };
  const proof = {
    event_id: event.event_id,
    plan_id: event.plan_id,
    phase_key: phase.key,
    phase_number: phase.number,
    artifact_refs: canonicalArtifactRefs(event),
    pr_number: pr.number,
    pr_url: pr.url,
    marker,
    fingerprints,
    proof_ref: phaseProofRef(phase.key),
  };
  const proofHash = crypto.createHash('sha256').update(JSON.stringify(proof), 'utf8').digest('hex');
  review.proof = { ...proof, proof_hash: proofHash };
  entry.review = review;
  try {
    enterpriseMeta.writeMetaFor(context.specDir, meta);
  } catch (error) {
    throw new PhaseHandlerError('PHASE_PROOF_RECONCILING', `Remote phase proof succeeded but local metadata could not be saved: ${safeMessage(error)}`, {
      status: 'reconciling',
      retryable: true,
    });
  }
  return proofHash;
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

function validFingerprintRecords(value) {
  return Array.isArray(value) && value.every((record) => record && typeof record === 'object'
    && !Array.isArray(record) && typeof record.fingerprint === 'string'
    && /^[0-9a-f]{16}$/.test(record.fingerprint)
    && (record.thread === undefined || (typeof record.thread === 'string' && record.thread.length > 0))
    && Object.keys(record).every((key) => key === 'fingerprint' || key === 'thread'));
}

function phaseProofRef(phaseKey) {
  return `meta:phases.${phaseKey}.github_pr+meta:phases.${phaseKey}.review.fingerprints`;
}

function phaseEntry(meta, phaseKey) {
  if (!meta.phases || typeof meta.phases !== 'object' || Array.isArray(meta.phases)) meta.phases = {};
  if (!meta.phases[phaseKey] || typeof meta.phases[phaseKey] !== 'object' || Array.isArray(meta.phases[phaseKey])) {
    meta.phases[phaseKey] = {};
  }
  return meta.phases[phaseKey];
}

module.exports = { handlePhaseComplete };
