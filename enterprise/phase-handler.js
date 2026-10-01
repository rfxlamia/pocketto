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

function handlePhaseComplete(event, options = {}) {
  const eventId = event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event';
  try {
    const checked = validateEvent(event);
    if (!checked.ok || event.type !== 'phase-complete') {
      throw new PhaseHandlerError('PHASE_EVENT_INVALID', 'Expected a valid phase-complete lifecycle event.');
    }

    const context = loadContext(event, options);
    const repo = resolveRepository(options);
    const phase = readPhaseEvidence(event, context);
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
      onResolveFailure: (records) => persistPhaseProof(context, issue, phase, pr, marker, records),
    });

    const proofHash = persistPhaseProof(context, issue, phase, pr, marker, fingerprints);
    return {
      event_id: eventId,
      status: 'succeeded',
      proof_ref: `meta:phases.${phase.key}.github_pr+meta:phases.${phase.key}.review.fingerprints`,
      proof_hash: proofHash,
    };
  } catch (error) {
    if (error instanceof PhaseHandlerError) {
      return phaseFailure(eventId, error.code, error.message, error.status, error.retryable);
    }
    return phaseFailure(eventId, 'PHASE_HANDLER_FAILED', safeMessage(error), 'retryable', true);
  }
}

function persistPhaseProof(context, issue, phase, pr, marker, fingerprints) {
  const meta = enterpriseMeta.readMetaFor(context.specDir);
  meta.github_issue = { ...(meta.github_issue || {}), number: issue.number, url: issue.url };
  const entry = phaseEntry(meta, phase.key);
  entry.github_pr = { ...(entry.github_pr || {}), number: pr.number, url: pr.url };
  entry.review = { ...(entry.review || {}), fingerprints };
  try {
    enterpriseMeta.writeMetaFor(context.specDir, meta);
  } catch (error) {
    throw new PhaseHandlerError('PHASE_PROOF_RECONCILING', `Remote phase proof succeeded but local metadata could not be saved: ${safeMessage(error)}`, {
      status: 'reconciling',
      retryable: true,
    });
  }
  return crypto.createHash('sha256').update(JSON.stringify({ marker, fingerprints })).digest('hex');
}

function phaseEntry(meta, phaseKey) {
  if (!meta.phases || typeof meta.phases !== 'object' || Array.isArray(meta.phases)) meta.phases = {};
  if (!meta.phases[phaseKey] || typeof meta.phases[phaseKey] !== 'object' || Array.isArray(meta.phases[phaseKey])) {
    meta.phases[phaseKey] = {};
  }
  return meta.phases[phaseKey];
}

module.exports = { handlePhaseComplete };
