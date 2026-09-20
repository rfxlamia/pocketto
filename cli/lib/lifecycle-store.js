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
  return JSON.parse(fs.readFileSync(target, 'utf8'));
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

// Commits one logical lifecycle transition atomically.
// Input: { specDir, planDir, planId, type, artifacts,
//          proofRef?, proofHash?, deps?: { now } }
// Success: { ok, event, revision }. Failure: { ok:false, code, message }.
// Failures leave `<spec_dir>/lifecycle.json` untouched (no partial success).
function commitTransition(input) {
  const { specDir, planDir, planId, type, artifacts } = input || {};
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

  const payload = logicalPayload({
    planId,
    type,
    artifactRefs: normalized,
    proofRef: input.proofRef,
    proofHash: input.proofHash,
  });
  const payloadHash = hashCanonicalPayload(payload);

  const revision = doc.plan.revision + 1;
  const event = {
    event_id: buildEventId(planId, type, revision),
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
  doc.plan.revision = revision;
  doc.events.push(event);

  const target = lifecyclePathFor(specDir);
  writeFileAtomicSync(target, serializeDoc(doc));

  return { ok: true, event, revision };
}

module.exports = {
  LIFECYCLE_FILE,
  LIFECYCLE_SCHEMA,
  lifecyclePathFor,
  readLifecycleDoc,
  commitTransition,
};
