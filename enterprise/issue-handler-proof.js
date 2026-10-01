'use strict';

const crypto = require('node:crypto');
const meta = require('./meta');
const { issueValidation } = require('./issue-handler-identity');

function resultError(event, code, message, retryable = false) {
  return {
    event_id: event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event',
    status: retryable ? 'retryable' : 'terminal',
    error: { code, retryable, message: String(message || code) },
  };
}

function resultSucceeded(event, proofHash) {
  return {
    event_id: event.event_id,
    status: 'succeeded',
    proof_ref: meta.issueProofRef(),
    proof_hash: proofHash,
  };
}

function computeProofHash({ event, issue, repository, specPath, identity }) {
  const proof = {
    event_id: event.event_id,
    plan_id: event.plan_id,
    repository,
    issue_number: issue.number,
    issue_url: issue.url,
    spec_path: specPath,
    identity,
  };
  return crypto.createHash('sha256').update(JSON.stringify(proof), 'utf8').digest('hex');
}

function replayIssueProof(event, spec) {
  if (event.delivery.status !== 'succeeded') return null;
  const recorded = meta.readMetaFor(spec.specDir).github_issue || {};
  const ownership = recorded.ownership || {};
  const identity = ownership.identity;
  const validIdentity = ['title', 'full-spec-path', 'title+full-spec-path'].includes(identity);
  if (event.proof_ref !== meta.issueProofRef()
      || typeof event.proof_hash !== 'string'
      || ownership.event_id !== event.event_id
      || ownership.plan_id !== event.plan_id
      || ownership.spec_path !== spec.specPath
      || typeof ownership.repository !== 'string'
      || !Number.isInteger(recorded.number) || recorded.number <= 0
      || typeof recorded.url !== 'string' || recorded.url.length === 0
      || !validIdentity) {
    return resultError(event, 'ISSUE_PROOF_MISMATCH', 'Succeeded event has no matching persisted issue ownership proof; resolve metadata manually before replay.');
  }
  const expectedHash = computeProofHash({
    event,
    issue: { number: recorded.number, url: recorded.url },
    repository: ownership.repository,
    specPath: ownership.spec_path,
    identity,
  });
  if (expectedHash !== ownership.proof_hash || event.proof_hash !== expectedHash) {
    return resultError(event, 'ISSUE_PROOF_MISMATCH', 'Succeeded event issue proof does not match persisted metadata; resolve metadata manually before replay.');
  }
  return resultSucceeded(event, event.proof_hash);
}

function saveIssueProof(specDir, event, issue, repo, specPath, identity, clock) {
  const proofHash = computeProofHash({
    event,
    issue,
    repository: repo.nameWithOwner,
    specPath,
    identity,
  });
  const current = meta.readMetaFor(specDir);
  const createdAt = typeof issue.createdAt === 'string'
    ? issue.createdAt
    : clock().toISOString();
  const updated = {
    ...current,
    github_issue: {
      ...(current.github_issue || {}),
      number: issue.number,
      url: issue.url,
      created_at: createdAt,
      ownership: {
        plan_id: event.plan_id,
        repository: repo.nameWithOwner,
        event_id: event.event_id,
        spec_path: specPath,
        identity,
        proof_hash: proofHash,
      },
    },
  };
  meta.writeMetaFor(specDir, updated);
  return proofHash;
}

function proveIssue(event, issue, spec, repo, clock) {
  const validation = issueValidation(issue, event, spec, repo);
  if (!validation.ok) {
    return resultError(event, 'ISSUE_MANUAL_RESOLUTION', `Issue could not be safely reconciled: ${validation.reason}; resolve it manually.`);
  }
  const identity = validation.identity;
  const identityProof = identity.titleMatch && identity.pathMatch
    ? 'title+full-spec-path'
    : identity.titleMatch ? 'title' : 'full-spec-path';
  const proofHash = saveIssueProof(spec.specDir, event, issue, repo, spec.specPath, identityProof, clock);
  return resultSucceeded(event, proofHash);
}

module.exports = { proveIssue, replayIssueProof, resultError, resultSucceeded };
