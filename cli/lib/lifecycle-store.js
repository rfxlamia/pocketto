'use strict';

// Authoritative lifecycle document store (T2).
//
// `<spec_dir>/lifecycle.json` is the SINGLE authoritative document holding
// plan state, the event journal, and the delivery ledger as one document.
// It is always replaced atomically (temp-file plus rename). `log.json` and
// `.pocket-meta.json` are never written here — `log.json` stays a
// projection concern only.
//
// T1 `cli/lib/lifecycle-contract.js` owns canonical hashing/validation;
// this module never reimplements it.

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomicSync } = require('./atomic-file');
const { hasSpecDirectory, withLifecycleMutation } = require('./lifecycle-lock');
const {
  allowedRootsFor, hashBytes, requiredPlanDir, rootDirFor, validateArtifactOnDisk,
} = require('./lifecycle-artifact-validation');
const { validateDeliveryPatch } = require('./lifecycle-delivery-validation');
const { createDeliveryWriter } = require('./lifecycle-delivery-store');
const {
  EVENT_TYPES,
  buildEventId,
  canonicalArtifactRef,
  hashCanonicalPayload,
  validateArtifactRef,
  validateEvent,
} = require('./lifecycle-contract');

const LIFECYCLE_FILE = 'lifecycle.json';
const LIFECYCLE_SCHEMA = 1;

function lifecyclePathFor(specDir) {
  return path.join(specDir, LIFECYCLE_FILE);
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function readLifecycleDoc(specDir) {
  const target = lifecyclePathFor(specDir);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const invalid = new Error(`invalid lifecycle document at ${target}: ${err.message}`, { cause: err });
    invalid.code = 'LIFECYCLE_CORRUPT';
    throw invalid;
  }
}

function initDoc({ planId, specDir, planDir }) {
  return {
    schema: LIFECYCLE_SCHEMA,
    plan: {
      plan_id: planId,
      spec_dir: specDir,
      plan_dir: planDir === undefined ? null : planDir,
      branch: null,
      state: { approval: 'PENDING', phase_status: {}, status: 'IN_PROGRESS' },
      revision: 0,
    },
    events: [],
  };
}

// Logical payload: everything that defines what the event means, minus
// revision (assigned by the journal) and volatile delivery fields.
// Identical logical transitions share one payload hash → replay-safe.
function logicalPayload({ planId, type, artifactRefs, proofRef, proofHash }) {
  return {
    plan_id: planId,
    type,
    artifact_refs: artifactRefs,
    proof_ref: proofRef === undefined ? null : proofRef,
    proof_hash: proofHash === undefined ? null : proofHash,
  };
}

function applyStateSnapshot(doc, type) {
  const state = doc.plan.state;
  if (type === 'spec-approved') {
    state.approval = 'APPROVED';
  } else if (type === 'phase-complete') {
    const key = `phase-${Object.keys(state.phase_status).length + 1}`;
    state.phase_status[key] = 'COMPLETE';
  } else if (type === 'plan-closed') {
    state.status = 'DONE';
  }
}

function serializeDoc(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// Current-state gate: the plan's committed state must legally accept the
// requested event type. `spec-approved` fires once (PENDING → APPROVED);
// once the plan is closed (DONE) no further transition is legal. Rejection
// happens before any journal mutation, so an invalid transition emits no
// event and leaves the document byte-identical.
function checkStateAllowsTransition(doc, type) {
  const state = (doc.plan && doc.plan.state) || {};
  if (state.status === 'DONE') {
    return fail('LIFECYCLE_BAD_STATE', `plan is closed; ${type} is not allowed`);
  }
  if (type === 'spec-approved' && state.approval === 'APPROVED') {
    return fail('LIFECYCLE_BAD_STATE', 'spec has already been approved');
  }
  return { ok: true, code: null, message: null };
}

// Event identity plus payload integrity: the deterministic event ID for a
// revision is bound to exactly one canonical payload hash (T1 hashing).
// An existing event with the same ID but a different payload hash is a
// terminal integrity conflict — never overwritten, never appended
// alongside, and never mutated.
function findIdentityConflict(doc, eventId, payloadHash) {
  for (const event of doc.events) {
    if (event.event_id === eventId && event.payload_hash !== payloadHash) return event;
  }
  return null;
}

// Deterministic replay lookup: an identical logical transition already in
// the journal (same type and canonical payload hash; volatile timestamps
// and delivery fields excluded) is a no-op returning the original event.
function findReplayEvent(doc, type, payloadHash) {
  for (const event of doc.events) {
    if (event.type === type && event.payload_hash === payloadHash) return event;
  }
  return null;
}

// Commits one logical lifecycle transition atomically.
// Input: { specDir, planDir, planId, type, artifacts, branch?,
//          proofRef?, proofHash?, deps?: { now, stat, readFile, realpath, hashFile } }
// Success: { ok, event, revision }. Failure: { ok:false, code, message }.
// Failures leave `<spec_dir>/lifecycle.json` untouched (no partial success).
function commitTransition(input) {
  const { specDir } = input || {};
  if (typeof specDir !== 'string' || specDir.length === 0 || !hasSpecDirectory(specDir)) {
    return commitTransitionUnlocked(input);
  }
  return withLifecycleMutation(specDir, () => commitTransitionUnlocked(input));
}

function commitTransitionUnlocked(input) {
  const { specDir, planDir, planId, type, artifacts, branch } = input || {};
  const deps = (input && input.deps) || {};
  const now = deps.now || (() => new Date().toISOString());

  if (typeof specDir !== 'string' || specDir.length === 0) {
    return fail('LIFECYCLE_BAD_SPEC_DIR', 'specDir must be a non-empty string');
  }
  if (!EVENT_TYPES.includes(type)) {
    return fail('LIFECYCLE_UNKNOWN_TYPE', `unsupported lifecycle type: ${type}`);
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return fail('LIFECYCLE_BAD_ARTIFACT', 'artifact_refs must be a non-empty array');
  }

  let doc = readLifecycleDoc(specDir);
  if (doc === null) {
    doc = initDoc({ planId, specDir, planDir });
  }
  if (doc.plan.plan_id !== planId) {
    return fail('LIFECYCLE_PLAN_MISMATCH', 'plan_id does not match the lifecycle document');
  }

  const normalized = [];
  for (const ref of artifacts) {
    const res = validateArtifactRef(ref);
    if (!res.ok) return fail(res.code, res.message);
    normalized.push(canonicalArtifactRef(ref));
  }

  if (requiredPlanDir(type) && (planDir === null || planDir === undefined)) {
    return fail('LIFECYCLE_PLAN_DIR_REQUIRED', `${type} requires a non-null plan_dir`);
  }
  const allowed = allowedRootsFor(type);
  const ioDeps = {
    stat: deps.stat, readFile: deps.readFile, realpath: deps.realpath, hashFile: deps.hashFile,
  };
  for (const ref of normalized) {
    if (!allowed.includes(ref.root)) {
      return fail('LIFECYCLE_BAD_ARTIFACT_ROOT', `${type} may not reference root: ${ref.root}`);
    }
    const rootDir = rootDirFor(ref.root, specDir, planDir);
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      return fail('LIFECYCLE_BAD_ARTIFACT_ROOT', `missing root directory for: ${ref.root}`);
    }
    const disk = validateArtifactOnDisk(ref, rootDir, ioDeps);
    if (!disk.ok) return disk;
  }

  const payload = logicalPayload({
    planId,
    type,
    artifactRefs: normalized,
    proofRef: input.proofRef,
    proofHash: input.proofHash,
  });
  const payloadHash = hashCanonicalPayload(payload);

  // Identical replay is a no-op: return the original event ID and revision
  // without appending or rewriting the authoritative document. Looked up
  // after validation (refs are real) but before the state gate so an already
  // committed logical transition replays even when its type can no longer
  // fire on the current state.
  const replayed = findReplayEvent(doc, type, payloadHash);
  if (replayed) return { ok: true, event: replayed, revision: replayed.revision };

  // Identity conflict precedes the state gate: the existing journal entry
  // already binds this event ID to a different canonical payload, so this
  // submission is terminally rejected with zero mutation — no state
  // change, no journal append, and no delivery change.
  const revision = doc.plan.revision + 1;
  const candidateEventId = buildEventId(planId, type, revision);
  const conflicting = findIdentityConflict(doc, candidateEventId, payloadHash);
  if (conflicting) {
    return fail(
      'LIFECYCLE_INTEGRITY_CONFLICT',
      `event ${candidateEventId} conflicts with a different canonical payload`,
      { event_id: candidateEventId, terminal: true },
    );
  }

  const gate = checkStateAllowsTransition(doc, type);
  if (!gate.ok) return gate;

  const event = {
    event_id: candidateEventId,
    plan_id: planId,
    type,
    revision,
    occurred_at: now(),
    artifact_refs: normalized,
    payload_hash: payloadHash,
    proof_ref: payload.proof_ref,
    proof_hash: payload.proof_hash,
    delivery: { status: 'pending', attempts: 0 },
  };

  const valid = validateEvent(event);
  if (!valid.ok) return fail(valid.code, valid.message);

  applyStateSnapshot(doc, type);
  if (type === 'phase-complete' && typeof branch === 'string' && branch.length > 0) {
    doc.plan.branch = branch;
    doc.plan.plan_dir = planDir;
  }
  doc.plan.revision = revision;
  doc.events.push(event);

  const target = lifecyclePathFor(specDir);
  // All-or-nothing commit: the single authoritative document is replaced
  // via temp-file plus rename. Any write/rename failure leaves the previous
  // document byte-identical with no orphan temp (the atomic writer cleans
  // up); the caller sees LIFECYCLE_PERSISTENCE with no partial success.
  try {
    writeFileAtomicSync(target, serializeDoc(doc), deps.atomic || {});
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    return fail('LIFECYCLE_PERSISTENCE', `lifecycle persistence failed: ${detail}`);
  }

  return { ok: true, event, revision };
}

const updateEventDeliveryUnlocked = createDeliveryWriter({
  readLifecycleDoc,
  lifecyclePathFor,
  serializeDoc,
  writeFileAtomicSync,
  fail,
  validateDeliveryPatch,
});

function updateEventDelivery(specDir, eventId, patch) {
  if (typeof specDir !== 'string' || specDir.length === 0 || !hasSpecDirectory(specDir)) {
    return updateEventDeliveryUnlocked(specDir, eventId, patch);
  }
  return withLifecycleMutation(specDir, () => updateEventDeliveryUnlocked(specDir, eventId, patch));
}

module.exports = {
  LIFECYCLE_FILE,
  LIFECYCLE_SCHEMA,
  lifecyclePathFor,
  readLifecycleDoc,
  commitTransition,
  updateEventDelivery,
  hashBytes,
};
