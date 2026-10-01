'use strict';

// Enterprise plan-closure reconciliation. The tasklist marker and its
// metadata record are the canonical remote proof; closeout.md is local and
// informational only.

const fs = require('node:fs');
const path = require('node:path');
const { validateEvent } = require('../cli/lib/lifecycle-contract');
const { closeoutBody, tasklistBody, TASKLIST_MARKER } = require('../cli/lib/bodies');
const enterpriseMeta = require('./meta');
const {
  PROOF_REF,
  adapterResult,
  withTasklistProof,
  fromTransport,
  ghJson,
  selectIssue,
  sha256,
} = require('./closure-prerequisites');
const { repoIdentity } = require('./issue-identity');
const { readPlan, proofState } = require('./closure-plan');
const {
  flattenPages,
  selectTasklistComments,
  hasCanonicalTasklistProof,
  evaluateClosureProof,
  listTasklistComments,
  upsertTasklist,
} = require('./closure-tasklist');

function validateEventAndPaths(event, opts, eventId) {
  const validation = validateEvent(event);
  if (!validation.ok || event.type !== 'plan-closed') {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_INVALID_EVENT',
      'Closure handler requires a valid plan-closed event.', false);
  }
  if (typeof opts.specDir !== 'string' || !opts.specDir.length
      || typeof opts.planDir !== 'string' || !opts.planDir.length) {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_PATH_REQUIRED',
      'Closure reconciliation requires the spec and plan directories.', false);
  }
  if (path.basename(path.resolve(opts.specDir)) !== event.plan_id) {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_PLAN_ID_MISMATCH',
      'The spec directory does not match the lifecycle plan identity.', false);
  }
  if (!event.artifact_refs.some((ref) => ref.root === 'plan')) {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_ARTIFACT_REQUIRED',
      'Plan closure requires final plan-root artifact references.', false);
  }
  return null;
}

function loadClosureContext(event, opts, eventId, log) {
  let metadata;
  try {
    metadata = enterpriseMeta.readMetaFor(opts.specDir);
  } catch {
    return {
      ok: false,
      result: adapterResult(eventId, 'terminal', 'ISSUE_METADATA_INVALID',
        'Linked issue metadata is unavailable or malformed; manual resolution is required.', false),
    };
  }

  const currentRepo = ghJson(['repo', 'view', '--json', 'nameWithOwner,url'], opts);
  if (!currentRepo.ok) return { ok: false, result: fromTransport(eventId, currentRepo, 'REPOSITORY_LOOKUP_FAILED') };
  const repositoryIdentity = repoIdentity(currentRepo.data);
  if (!repositoryIdentity) {
    return {
      ok: false,
      result: adapterResult(eventId, 'terminal', 'REPOSITORY_LOOKUP_FAILED',
        'The current origin repository could not be resolved.', false),
    };
  }

  const selected = selectIssue(event, metadata, repositoryIdentity, opts);
  if (!selected.ok) return { ok: false, result: selected.result };
  return { ok: true, metadata, repository: repositoryIdentity.nameWithOwner, issue: selected.issue, log };
}

function prepareClosure(event, opts, eventId) {
  const invalid = validateEventAndPaths(event, opts, eventId);
  if (invalid) return { ok: false, result: invalid };
  const plan = readPlan(opts.planDir);
  if (!plan.ok) return { ok: false, result: adapterResult(eventId, 'terminal', plan.code, plan.message, false) };
  return loadClosureContext(event, opts, eventId, plan.log);
}

function writeCloseoutFile(planDir, content, opts) {
  const filePath = path.join(planDir, 'closeout.md');
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) return;
  } catch {
    // A missing or unreadable closeout is repaired by the same local write path.
  }
  (opts.writeFile || fs.writeFileSync)(filePath, content, 'utf8');
}

function isCurrentTasklistProof(event, context, listed, tasklist) {
  const existingProof = evaluateClosureProof({ event, comments: listed.markers, metadata: context.metadata });
  const previousRecord = context.metadata.github_issue && context.metadata.github_issue.tasklist;
  const existingMarker = listed.markers.find((comment) => comment.id === (previousRecord && previousRecord.comment_id));
  return existingProof.proven && listed.markers.length === 1 && existingMarker
    && existingMarker.body === tasklist && previousRecord.body_sha256 === sha256(tasklist)
    ? existingProof
    : null;
}

function reconcileExistingProof(eventId, context, listed, tasklist, closeout, opts, event) {
  const existingProof = isCurrentTasklistProof(event, context, listed, tasklist);
  if (!existingProof) return null;
  try {
    writeCloseoutFile(opts.planDir, closeout, opts);
  } catch (error) {
    return withTasklistProof(
      adapterResult(eventId, 'reconciling', 'CLOSEOUT_LOCAL_WRITE_FAILED',
        `Canonical tasklist proof is present but local closeout.md could not be written: ${error && error.message ? error.message : String(error)}. Replay will reconcile the local artifact.`, true),
      existingProof.proof_hash
    );
  }
  return {
    event_id: eventId,
    status: 'succeeded',
    proof_ref: existingProof.proof_ref,
    proof_hash: existingProof.proof_hash,
  };
}

function createProofRecord(event, context, comment, tasklist) {
  return {
    event_id: event.event_id,
    revision: event.revision,
    marker: TASKLIST_MARKER,
    comment_id: comment.id,
    body_sha256: sha256(tasklist),
    final_state: proofState(context.log),
    artifact_refs: event.artifact_refs.map((ref) => ({ ...ref })),
    proof_ref: PROOF_REF,
  };
}

function persistMetadata(eventId, context, record, proofHash, opts) {
  context.metadata.github_issue = {
    ...(context.metadata.github_issue || {}),
    number: context.issue.number,
    url: context.issue.html_url || context.issue.url || context.metadata.github_issue.url,
    tasklist: record,
  };
  try {
    (opts.writeMeta || enterpriseMeta.writeMetaFor)(opts.specDir, context.metadata);
  } catch (error) {
    return withTasklistProof(
      adapterResult(eventId, 'reconciling', 'CLOSEOUT_LEDGER_WRITE_FAILED',
        `Remote tasklist proof is present but local metadata persistence failed: ${error && error.message ? error.message : String(error)}. Replay will reconcile the existing marker.`, true),
      proofHash
    );
  }
  return null;
}

function persistCloseout(eventId, opts, closeout, proofHash) {
  try {
    writeCloseoutFile(opts.planDir, closeout, opts);
  } catch (error) {
    return withTasklistProof(
      adapterResult(eventId, 'reconciling', 'CLOSEOUT_LOCAL_WRITE_FAILED',
        `Remote tasklist proof is present but local closeout.md could not be written: ${error && error.message ? error.message : String(error)}. Replay will reconcile the existing marker.`, true),
      proofHash
    );
  }
  return null;
}

function persistClosureProof(eventId, event, context, comment, tasklist, closeout, opts) {
  const record = createProofRecord(event, context, comment, tasklist);
  const proofHash = sha256(JSON.stringify(record));
  record.proof_hash = proofHash;
  const ledgerFailure = persistMetadata(eventId, context, record, proofHash, opts);
  if (ledgerFailure) return ledgerFailure;
  const closeoutFailure = persistCloseout(eventId, opts, closeout, proofHash);
  if (closeoutFailure) return closeoutFailure;
  return { event_id: eventId, status: 'succeeded', proof_ref: PROOF_REF, proof_hash: proofHash };
}

function handlePlanClosed(event, opts = {}) {
  const eventId = event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event';
  const context = prepareClosure(event, opts, eventId);
  if (!context.ok) return context.result;
  const tasklist = tasklistBody(context.log);
  const closeout = closeoutBody({
    slug: event.plan_id,
    issue: context.issue.number,
    phases: context.log.phases.length,
  });
  const listed = listTasklistComments(event, context.repository, context.issue.number, opts);
  if (!listed.ok) return listed.result;
  const existingProof = reconcileExistingProof(eventId, context, listed, tasklist, closeout, opts, event);
  if (existingProof) return existingProof;
  const upserted = upsertTasklist(event, context.repository, context.issue.number, tasklist, opts, listed.markers);
  if (!upserted.ok) return upserted.result;
  return persistClosureProof(eventId, event, context, upserted.comment, tasklist, closeout, opts);
}

module.exports = {
  handlePlanClosed,
  selectTasklistComments,
  flattenPages,
  hasCanonicalTasklistProof,
  evaluateClosureProof,
};
