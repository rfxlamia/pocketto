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

const RECONCILABLE_DELIVERY_STATUSES = new Set(['claimed', 'pending', 'retryable', 'reconciling']);
const PROOF_HASH_PATTERN = /^[0-9a-f]{64}$/;

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
    metadata = enterpriseMeta.readMetaFor(opts.specDir, metadataContextFor(opts));
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
  const plan = readPlan(opts.planDir, event.artifact_refs);
  if (!plan.ok) return { ok: false, result: adapterResult(eventId, 'terminal', plan.code, plan.message, false) };

  let closeoutTarget;
  try {
    closeoutTarget = resolveCloseoutTarget(opts.planDir);
  } catch {
    return {
      ok: false,
      result: adapterResult(eventId, 'terminal', 'CLOSEOUT_PATH_INVALID',
        'The local closeout target must remain a regular file inside the selected plan directory.', false),
    };
  }

  const context = loadClosureContext(event, opts, eventId, plan.log);
  return context.ok ? { ...context, closeoutRoot: closeoutTarget.root } : context;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveCloseoutTarget(planDir, expectedRoot, { requireTarget = false } = {}) {
  const selectedPath = path.resolve(planDir);
  const root = fs.realpathSync(selectedPath);
  if (expectedRoot && root !== expectedRoot) {
    throw new Error('closeout plan directory changed');
  }

  const target = path.join(root, 'closeout.md');
  if (fs.realpathSync(path.dirname(target)) !== root) throw new Error('closeout parent changed');
  let targetExists = false;
  try {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error('closeout target is not a regular file');
    const physicalTarget = fs.realpathSync(target);
    if (!isInside(root, physicalTarget)) throw new Error('closeout target escaped the plan directory');
    targetExists = true;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (requireTarget && !targetExists) throw new Error('closeout target is missing after replacement');
  return { root, target };
}

function writeCloseoutFile(planDir, content, opts, expectedRoot) {
  let temporaryDirectory;
  try {
    const initial = resolveCloseoutTarget(planDir, expectedRoot);
    temporaryDirectory = fs.mkdtempSync(path.join(initial.root, '.closeout-'));
    const physicalTemporaryDirectory = fs.realpathSync(temporaryDirectory);
    if (!isInside(initial.root, physicalTemporaryDirectory)
        || path.dirname(physicalTemporaryDirectory) !== initial.root) {
      throw new Error('closeout temporary directory escaped the plan directory');
    }

    const temporaryPath = path.join(physicalTemporaryDirectory, 'closeout.md');
    resolveCloseoutTarget(planDir, initial.root);
    if (opts.writeFile) {
      opts.writeFile(temporaryPath, content, 'utf8');
    } else {
      const descriptor = fs.openSync(temporaryPath, 'wx', 0o666);
      try {
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }

    const temporaryStat = fs.lstatSync(temporaryPath);
    const physicalTemporaryPath = fs.realpathSync(temporaryPath);
    if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile()
        || !isInside(initial.root, physicalTemporaryPath)) {
      throw new Error('closeout temporary artifact is invalid');
    }

    const beforeRename = resolveCloseoutTarget(planDir, initial.root);
    if (beforeRename.target !== initial.target
        || fs.realpathSync(path.dirname(temporaryPath)) !== physicalTemporaryDirectory
        || fs.realpathSync(temporaryPath) !== physicalTemporaryPath) {
      throw new Error('closeout paths changed before replacement');
    }
    fs.renameSync(temporaryPath, beforeRename.target);
    const afterRename = resolveCloseoutTarget(planDir, initial.root, { requireTarget: true });
    if (afterRename.target !== beforeRename.target) throw new Error('closeout target changed after replacement');
  } finally {
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
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
    writeCloseoutFile(opts.planDir, closeout, opts, context.closeoutRoot);
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
    plan_id: event.plan_id,
    revision: event.revision,
    issue_number: context.issue.number,
    issue_url: context.issue.html_url || context.issue.url || context.metadata.github_issue.url,
    marker: TASKLIST_MARKER,
    comment_id: comment.id,
    body_sha256: sha256(tasklist),
    final_state: proofState(context.log),
    artifact_refs: canonicalArtifactRefs(event),
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
    if (opts.writeMeta) {
      enterpriseMeta.preflightMetaFor(opts.specDir, metadataContextFor(opts));
      opts.writeMeta(opts.specDir, context.metadata);
    } else {
      enterpriseMeta.writeMetaFor(opts.specDir, context.metadata, metadataContextFor(opts));
    }
  } catch (error) {
    return withTasklistProof(
      adapterResult(eventId, 'reconciling', 'CLOSEOUT_LEDGER_WRITE_FAILED',
        `Remote tasklist proof is present but local metadata persistence failed: ${error && error.message ? error.message : String(error)}. Replay will reconcile the existing marker.`, true),
      proofHash
    );
  }
  return null;
}

function persistCloseout(eventId, opts, closeout, proofHash, closeoutRoot) {
  try {
    writeCloseoutFile(opts.planDir, closeout, opts, closeoutRoot);
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
  const closeoutFailure = persistCloseout(eventId, opts, closeout, proofHash, context.closeoutRoot);
  if (closeoutFailure) return closeoutFailure;
  return { event_id: eventId, status: 'succeeded', proof_ref: PROOF_REF, proof_hash: proofHash };
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

function replayClosureProof(event, opts, eventId) {
  const delivery = event.delivery || {};
  let metadata;
  try {
    metadata = enterpriseMeta.readMetaFor(opts.specDir, metadataContextFor(opts));
  } catch {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_PROOF_MISMATCH',
      'Succeeded event has no readable persisted tasklist proof; resolve metadata manually before replay.', false);
  }
  const issue = metadata.github_issue || {};
  const record = issue.tasklist;
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.event_id !== event.event_id
      || record.plan_id !== event.plan_id
      || record.revision !== event.revision
      || !Number.isInteger(record.issue_number) || record.issue_number <= 0
      || record.issue_number !== issue.number
      || typeof record.issue_url !== 'string' || record.issue_url.length === 0
      || record.issue_url !== issue.url
      || record.marker !== TASKLIST_MARKER
      || !Number.isInteger(record.comment_id) || record.comment_id <= 0
      || typeof record.body_sha256 !== 'string' || !PROOF_HASH_PATTERN.test(record.body_sha256)
      || !record.final_state || typeof record.final_state !== 'object' || Array.isArray(record.final_state)
      || JSON.stringify(record.artifact_refs) !== JSON.stringify(canonicalArtifactRefs(event))
      || record.proof_ref !== PROOF_REF
      || delivery.proof_ref !== PROOF_REF
      || typeof record.proof_hash !== 'string' || !PROOF_HASH_PATTERN.test(record.proof_hash)
      || typeof delivery.proof_hash !== 'string' || !PROOF_HASH_PATTERN.test(delivery.proof_hash)) {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_PROOF_MISMATCH',
      'Succeeded event has no matching event-bound persisted tasklist proof; resolve metadata manually before replay.', false);
  }

  const { proof_hash: persistedHash, ...proofRecord } = record;
  const expectedHash = sha256(JSON.stringify(proofRecord));
  if (persistedHash !== expectedHash || delivery.proof_hash !== expectedHash) {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_PROOF_MISMATCH',
      'Succeeded event tasklist proof does not match persisted metadata; resolve metadata manually before replay.', false);
  }
  return {
    event_id: eventId,
    status: 'succeeded',
    proof_ref: delivery.proof_ref,
    proof_hash: delivery.proof_hash,
  };
}

function metadataContextFor(opts) {
  if (typeof opts.projectRoot !== 'string') return undefined;
  return { projectRoot: opts.projectRoot, specDir: opts.specDir };
}

function metadataFailure(eventId, error) {
  const missing = error && error.code === 'ENTERPRISE_META_MISSING';
  return adapterResult(eventId, 'terminal', missing ? 'CLOSEOUT_METADATA_MISSING' : 'CLOSEOUT_METADATA_PATH_INVALID',
    'Linked issue metadata is missing or has an unsafe path; manual resolution is required.', false);
}

function handlePlanClosed(event, opts = {}) {
  const eventId = event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event';
  const invalid = validateEventAndPaths(event, opts, eventId);
  if (invalid) return invalid;
  try {
    enterpriseMeta.preflightMetaFor(opts.specDir, metadataContextFor(opts));
  } catch (error) {
    return metadataFailure(eventId, error);
  }
  if (event.delivery.status === 'succeeded') return replayClosureProof(event, opts, eventId);
  if (!RECONCILABLE_DELIVERY_STATUSES.has(event.delivery.status)) {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_DELIVERY_INELIGIBLE',
      'Only claimed, pending, retryable, or reconciling closure events may enter remote reconciliation.', false);
  }
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
