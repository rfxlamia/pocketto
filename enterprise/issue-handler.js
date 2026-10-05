'use strict';

// Enterprise-owned reconciliation for the neutral `spec-approved` event.
// GitHub identity stays in Enterprise metadata; adapter responses expose only
// opaque proof references and hashes. The adapter validates the lifecycle
// contract before dispatch; this handler
// checks only the fields needed to operate safely without importing Core.

const { specContext } = require('./issue-handler-identity');
const enterpriseMeta = require('./meta');
const { repoIdentity } = require('./issue-identity');
const { proveIssue, replayIssueProof, resultError } = require('./issue-handler-proof');
const {
  issueView,
  lookupMetadataIssue,
  mapGhFailure,
  repoView,
  searchExactIssues,
  writeIssue,
} = require('./issue-handler-reconcile');

function isSafeSpecApprovedEvent(event) {
  return Boolean(event && typeof event === 'object' && !Array.isArray(event)
    && event.type === 'spec-approved'
    && typeof event.event_id === 'string'
    && typeof event.plan_id === 'string'
    && Array.isArray(event.artifact_refs)
    && event.artifact_refs.every((ref) => ref && typeof ref === 'object' && !Array.isArray(ref)
      && typeof ref.root === 'string' && typeof ref.path === 'string')
    && event.delivery && typeof event.delivery === 'object' && !Array.isArray(event.delivery));
}

function handleSpecApproved(event, opts = {}) {
  if (!isSafeSpecApprovedEvent(event)) {
    return resultError(event, 'ISSUE_INVALID_EVENT', 'Expected a valid spec-approved lifecycle event.');
  }
  const projectRoot = opts.projectRoot;
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return resultError(event, 'ISSUE_NO_PROJECT', 'A project root is required to resolve the approved specification.');
  }
  const spec = specContext(event, projectRoot);
  if (spec.error === 'approved spec artifact is unavailable (read failed)') {
    return resultError(event, 'ARTIFACT_READ_FAILED', 'Approved spec artifact could not be read because of a temporary I/O failure; retry delivery.', true);
  }
  if (spec.error) return resultError(event, 'STALE_ARTIFACT', `${spec.error}; verify the committed spec artifact before retrying.`);
  if (event.delivery.status === 'succeeded') {
    const metadataError = preflightIssueMetadata(event, spec, false);
    return metadataError || replayIssueProof(event, spec);
  }
  if (!['claimed', 'pending', 'retryable', 'reconciling'].includes(event.delivery.status)) {
    return resultError(event, 'ISSUE_DELIVERY_INELIGIBLE', 'Only claimed, pending, retryable, or reconciling issue events may enter remote reconciliation.');
  }
  const metadataError = preflightIssueMetadata(event, spec, true);
  if (metadataError) return metadataError;

  const runner = opts.ghRunner;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();
  const repositoryResult = repoView(runner);
  if (!repositoryResult.ok) return mapGhFailure(event, 'Current origin lookup', repositoryResult);
  const repo = repoIdentity(repositoryResult.data);
  if (!repo) return resultError(event, 'ISSUE_ORIGIN_UNVERIFIED', 'Current origin repository identity could not be verified; resolve repository ownership manually.');

  const metadata = lookupMetadataIssue(event, spec, repo, runner);
  if (metadata.error) return metadata.error;
  if (metadata.issue) return proveIssue(event, metadata.issue, spec, repo, clock);

  const search = searchExactIssues(event, spec, repo, runner);
  if (search.error) return search.error;
  if (search.matches.length === 1) {
    const viewed = issueView(repo, search.matches[0].number, runner);
    if (!viewed.ok) return mapGhFailure(event, 'Exact issue validation', viewed);
    return proveIssue(event, viewed.data, spec, repo, clock);
  }
  if (metadata.hasRecordedIdentity) {
    return resultError(event, 'ISSUE_MANUAL_RESOLUTION', `Recorded issue metadata is invalid (${metadata.invalidReason || 'identity mismatch'}) and no exact open current-origin issue was found; resolve it manually rather than creating a duplicate.`);
  }

  const created = writeIssue(event, runner, spec, repo);
  if (created.error) return mapGhFailure(event, 'Issue creation or validation', created.error);
  if (created.manual) return resultError(event, 'ISSUE_MANUAL_RESOLUTION', `${created.manual}; verify the target manually before retrying.`);
  return proveIssue(event, created.issue, spec, repo, clock);
}

function preflightIssueMetadata(event, spec, allowMissing) {
  try {
    enterpriseMeta.preflightMetaFor(spec.specDir, spec.metaContext, { allowMissing });
    return null;
  } catch (error) {
    const missing = error && error.code === 'ENTERPRISE_META_MISSING';
    return resultError(event, missing ? 'ISSUE_METADATA_MISSING' : 'ISSUE_METADATA_PATH_INVALID',
      'Issue metadata is missing or has an unsafe path; resolve it manually before retrying.');
  }
}

module.exports = { handleSpecApproved };
