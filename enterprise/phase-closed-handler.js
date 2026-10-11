'use strict';

// Enterprise phase-closed handler (T13). Publishes the closed phase's PR through the
// T11 publisher, reconciles its summary and findings through the shared seam in
// phase-handler.js, and stores a stack proof for local replay. Stacked plans only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateEvent,
  ADAPTER_NOTICE_MAX_COUNT,
  ADAPTER_NOTICE_MAX_MESSAGE_LENGTH,
} = require('../cli/lib/lifecycle-contract');
const { pocketArtifactProbePaths, ignoredArtifactWarning } = require('../cli/lib/artifact-ignore');
const { redactSecrets } = require('./retry');
const { canonicalArtifactRefs } = require('./lifecycle-proof');
const enterpriseMeta = require('./meta');
const { loadContext, phaseBranchFor, resolvePlanArtifactPath } = require('./phase-handler-context');
const { readPhaseEvidence } = require('./phase-handler-evidence');
const { resolveRepository, resolveOwnedIssue, resolvePhasePr } = require('./phase-handler-targets');
const { PhaseHandlerError, phaseFailure, safeMessage } = require('./phase-handler-errors');
const { publishPhase } = require('./phase-stack');
const { reconcileOnPr, metaContextFor, phaseEntry } = require('./phase-handler');

const RECONCILABLE_DELIVERY_STATUSES = new Set(['claimed', 'pending', 'retryable', 'reconciling']);

// Typed handler errors keep their own code, status, and retryable flag unchanged.
function phaseClosedFailure(eventId, error) {
  if (error instanceof PhaseHandlerError) {
    return phaseFailure(eventId, error.code, error.message, error.status, error.retryable);
  }
  return phaseFailure(eventId, 'PHASE_HANDLER_FAILED', safeMessage(error), 'retryable', true);
}

function rootBaseBranch(context) {
  const root = context.lifecycle.plan.phase_branches.root_base;
  if (!root || typeof root.branch !== 'string' || root.branch.length === 0) {
    throw new PhaseHandlerError('PHASE_BRANCH_REQUIRED', 'Lifecycle metadata does not contain the recorded root base branch.');
  }
  return root.branch;
}

function planPhaseCount(context) {
  let log;
  try {
    log = JSON.parse(fs.readFileSync(resolvePlanArtifactPath(context.planDir, 'log.json', 'plan task evidence'), 'utf8'));
  } catch (error) {
    if (error instanceof PhaseHandlerError) throw error;
    throw new PhaseHandlerError('PHASE_EVIDENCE_INVALID', `Cannot read plan task evidence: ${safeMessage(error)}`);
  }
  if (!log || typeof log !== 'object' || !Array.isArray(log.phases)) {
    throw new PhaseHandlerError('PHASE_EVIDENCE_INVALID', 'Plan task evidence must list its phases.');
  }
  return log.phases.length;
}

// Phase 1 targets the recorded root base; phase N targets phase N-1's branch and key.
function phaseFor(context, evidence) {
  const order = evidence.number;
  const parentKey = order > 1 ? `phase-${order - 1}` : null;
  return {
    ...evidence,
    order,
    count: planPhaseCount(context),
    branch: phaseBranchFor(context, evidence.key),
    parentKey,
    baseBranch: parentKey ? phaseBranchFor(context, parentKey) : rootBaseBranch(context),
  };
}

function readCloseoutSnapshot(event, context) {
  const ref = event.artifact_refs.find((artifact) => artifact.root === 'plan' && artifact.kind === 'closeout-snapshot');
  if (!ref || typeof ref.path !== 'string') {
    throw new PhaseHandlerError('PHASE_CLOSEOUT_REQUIRED', 'phase-closed requires a closeout-snapshot artifact.');
  }
  return fs.readFileSync(resolvePlanArtifactPath(context.planDir, ref.path, 'closeout snapshot'), 'utf8');
}

function priorStackFingerprints(meta, phaseKey) {
  const entry = meta.phases && meta.phases[phaseKey];
  const records = entry && entry.stack && entry.stack.fingerprints;
  return Array.isArray(records) ? records : [];
}

function stackProofRef(phaseKey) {
  return `meta:phases.${phaseKey}.stack.proof`;
}

function proofHashOf(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
}

function phaseKeyOf(event) {
  const ref = event.artifact_refs.find((artifact) => artifact.root === 'plan' && artifact.kind === 'phase-evidence');
  const match = ref && typeof ref.path === 'string' ? /phase[-_](\d+)/i.exec(ref.path) : null;
  if (!match) throw new PhaseHandlerError('PHASE_IDENTITY_UNPROVEN', 'Cannot derive phase identity from the phase-evidence artifact.');
  return `phase-${Number(match[1])}`;
}

// Replay compares only the locally stored proof. No artifact is re-read and no gh call runs.
function replayStackProof(event, context) {
  const key = phaseKeyOf(event);
  const ref = stackProofRef(key);
  const mismatch = () => new PhaseHandlerError('PHASE_PROOF_MISMATCH',
    'Succeeded phase-closed event has no matching stack proof; resolve metadata manually before replay.',
    { status: 'terminal', retryable: false });
  let meta;
  try {
    meta = enterpriseMeta.readMetaFor(context.specDir, metaContextFor(context));
  } catch {
    throw mismatch();
  }
  const entry = meta.phases && meta.phases[key];
  const proof = entry && entry.stack && entry.stack.proof;
  const delivery = event.delivery || {};
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
      || proof.event_id !== event.event_id || proof.plan_id !== event.plan_id || proof.proof_ref !== ref
      || JSON.stringify(proof.artifact_refs) !== JSON.stringify(canonicalArtifactRefs(event))
      || delivery.proof_ref !== ref || delivery.proof_hash !== proof.proof_hash) {
    throw mismatch();
  }
  const { proof_hash: storedHash, ...record } = proof;
  if (proofHashOf(record) !== storedHash) throw mismatch();
  return { event_id: event.event_id, status: 'succeeded', proof_ref: ref, proof_hash: storedHash };
}

// Remote work already happened when this runs, so a failed local write is reconciling, not terminal.
function writeStackMeta(context, meta) {
  try {
    enterpriseMeta.writeMetaFor(context.specDir, meta, metaContextFor(context));
  } catch (error) {
    throw new PhaseHandlerError('PHASE_PROOF_RECONCILING',
      `Remote phase work succeeded but local metadata could not be saved: ${safeMessage(error)}`,
      { status: 'reconciling', retryable: true });
  }
}

// Partial state saved when a thread resolution fails. It is not a proof, so replay never accepts it.
function persistStackFingerprints(context, phase, fingerprints) {
  const meta = enterpriseMeta.readMetaFor(context.specDir, metaContextFor(context));
  const entry = phaseEntry(meta, phase.key);
  entry.stack = { ...(entry.stack || {}), fingerprints };
  writeStackMeta(context, meta);
}

function persistStackProof(event, context, phase, published, marker, fingerprints) {
  const meta = enterpriseMeta.readMetaFor(context.specDir, metaContextFor(context));
  const entry = phaseEntry(meta, phase.key);
  const proof = {
    event_id: event.event_id,
    plan_id: event.plan_id,
    phase_key: phase.key,
    pr_number: published.pr.number,
    pr_url: published.pr.url,
    head_sha: published.headSha,
    base: phase.baseBranch,
    marker,
    fingerprints,
    artifact_refs: canonicalArtifactRefs(event),
    proof_ref: stackProofRef(phase.key),
  };
  const proofHash = proofHashOf(proof);
  entry.stack = { fingerprints, proof: { ...proof, proof_hash: proofHash } };
  writeStackMeta(context, meta);
  return proofHash;
}

function publishStackedPhase(event, context, options) {
  const phase = phaseFor(context, readPhaseEvidence(event, context));
  const closeoutSnapshot = readCloseoutSnapshot(event, context);
  const repo = resolveRepository(options);
  const issue = resolveOwnedIssue(event, context, repo, options);
  enterpriseMeta.setIssueIdentity(context.specDir, { number: issue.number, url: issue.url });
  const published = publishPhase({
    projectRoot: context.root,
    specDir: context.specDir,
    planId: event.plan_id,
    phase,
    closeoutSnapshot,
    registration: options.record,
    options,
  });
  const selectedPr = resolvePhasePr(context, phase, repo, options);
  const meta = enterpriseMeta.readMetaFor(context.specDir, metaContextFor(context));
  const prior = priorStackFingerprints(meta, phase.key);
  const { marker, fingerprints } = reconcileOnPr(phase, {
    repo,
    selectedPr,
    prior,
    persist: (_marker, records) => persistStackFingerprints(context, phase, records),
  }, options);
  const proofHash = persistStackProof(event, context, phase, published, marker, fingerprints);
  return {
    event_id: event.event_id,
    status: 'succeeded',
    proof_ref: stackProofRef(phase.key),
    proof_hash: proofHash,
    notices: [published.notice],
  };
}

// Display-only ignored-artifact notice. The message is the consequence and the fix, then as many
// repo-relative paths as fit, then "…and N more". It must pass the Core notice bound both as built
// and after adapter redaction; serializeNotices drops a notice that fails either check.
function ignoredArtifactNotice(warning, root) {
  const paths = [...new Set(warning.paths.map((p) => path.relative(root, p).split(path.sep).join('/')))];
  const head = `${warning.consequence} Fix: git add -f each listed path, or remove its rule from .gitignore. `
    + `Pocket never edits .gitignore. Ignored: `;
  const fits = (message) => message.length <= ADAPTER_NOTICE_MAX_MESSAGE_LENGTH
    && redactSecrets(message).length <= ADAPTER_NOTICE_MAX_MESSAGE_LENGTH;
  for (let shown = paths.length; shown >= 0; shown -= 1) {
    const remaining = paths.length - shown;
    const list = paths.slice(0, shown).join(', ');
    const more = remaining === 0 ? '' : `…and ${remaining} more`;
    const tail = shown === 0 ? more : (remaining === 0 ? list : `${list}, ${more}`);
    const message = `${head}${tail}`;
    if (fits(message)) return { code: 'POCKET_ARTIFACTS_IGNORED', message };
  }
  return { code: 'POCKET_ARTIFACTS_IGNORED', message: `Ignored Pocket artifacts: …and ${paths.length} more` };
}

// Probes the artifacts of the given phase orders from already-resolved directories.
// Returns null when nothing is ignored or the directories cannot be resolved; never throws.
function ignoredNoticeFor({ root, planDir, specDir, phaseOrders }) {
  try {
    const physicalRoot = fs.realpathSync(root);
    const physicalPlanDir = fs.realpathSync(planDir);
    const physicalSpecDir = fs.realpathSync(specDir);
    // Each phase repeats the plan-level and spec-level paths, so the probe list is deduplicated.
    const probes = [...new Set(phaseOrders.flatMap((phaseOrder) => pocketArtifactProbePaths({
      planDir: physicalPlanDir,
      specDir: physicalSpecDir,
      phaseOrder,
    })))];
    const warning = ignoredArtifactWarning(physicalRoot, probes, { audience: 'enterprise' });
    return warning ? ignoredArtifactNotice(warning, physicalRoot) : null;
  } catch {
    return null;
  }
}

// Appends the notice after the existing notices, keeping status and every other field unchanged.
function withIgnoredArtifactNotice(response, notice) {
  if (!notice || !response) return response;
  const existing = Array.isArray(response.notices) ? response.notices : [];
  if (existing.length >= ADAPTER_NOTICE_MAX_COUNT) return response;
  return { ...response, notices: [...existing, notice] };
}

// Phase orders a plan closure covers: every phase in log.json, or phase 1 when log.json cannot be read.
function planPhaseOrders(planDir) {
  try {
    const log = JSON.parse(fs.readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    const count = log && Array.isArray(log.phases) ? log.phases.length : 0;
    return count > 0 ? Array.from({ length: count }, (_, index) => index + 1) : [1];
  } catch {
    return [1];
  }
}

// Notice for a phase-closed or plan-closed event from directories the caller has resolved.
// Returns null for any other event type, when nothing is ignored, or when the directories do not resolve.
function ignoredNoticeForEvent(event, { projectRoot, planDir, specDir }) {
  try {
    if (!event) return null;
    let phaseOrders;
    if (event.type === 'phase-closed') phaseOrders = [Number(phaseKeyOf(event).slice('phase-'.length))];
    else if (event.type === 'plan-closed') phaseOrders = planPhaseOrders(planDir);
    else return null;
    return ignoredNoticeFor({ root: projectRoot, planDir, specDir, phaseOrders });
  } catch {
    return null;
  }
}

function phaseClosedNotice(event, context) {
  if (!context) return null;
  return ignoredNoticeForEvent(event, { projectRoot: context.root, planDir: context.planDir, specDir: context.specDir });
}

function handlePhaseClosed(event, options = {}) {
  const scope = { context: null };
  const response = phaseClosedResponse(event, options, scope);
  return withIgnoredArtifactNotice(response, phaseClosedNotice(event, scope.context));
}

function phaseClosedResponse(event, options, scope) {
  const eventId = event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event';
  try {
    const checked = validateEvent(event);
    if (!checked.ok || event.type !== 'phase-closed') {
      throw new PhaseHandlerError('PHASE_EVENT_INVALID', 'Expected a valid phase-closed lifecycle event.');
    }
    const context = loadContext(event, options);
    scope.context = context;
    if (!context.stacked) {
      throw new PhaseHandlerError('PHASE_CLOSED_NOT_STACKED', 'phase-closed applies only to stacked plans; no phase PR was published.');
    }
    const status = event.delivery.status;
    if (status === 'succeeded') return replayStackProof(event, context);
    if (!RECONCILABLE_DELIVERY_STATUSES.has(status)) {
      throw new PhaseHandlerError('PHASE_DELIVERY_INELIGIBLE', 'Only claimed, pending, retryable, or reconciling phase-closed events may enter remote reconciliation.');
    }
    return publishStackedPhase(event, context, options);
  } catch (error) {
    return phaseClosedFailure(eventId, error);
  }
}

module.exports = {
  handlePhaseClosed,
  phaseFor,
  phaseKeyOf,
  readCloseoutSnapshot,
  ignoredArtifactNotice,
  ignoredNoticeFor,
  ignoredNoticeForEvent,
  withIgnoredArtifactNotice,
};
