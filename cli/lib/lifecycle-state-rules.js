'use strict';

// Lifecycle state rules (T2): the logical payload identity, the snapshot
// derived from each transition, and the current-state legality gate. Pure
// functions only; the store owns every read and write.

const { hashCanonicalPayload } = require('./lifecycle-contract');

function fail(code, message) {
  return { ok: false, code, message };
}

// Logical payload: everything that defines what the event means, minus
// revision (assigned by the journal) and volatile delivery fields.
// Identical logical transitions share one payload hash → replay-safe.
// phase-closed carries its phaseKey in the payload (never as an event field),
// so closing two phases with identical artifact refs cannot collide on replay.
// Other types omit phase_key entirely, keeping their payload hashes unchanged.
function logicalPayload({ planId, type, artifactRefs, proofRef, proofHash, phaseKey }) {
  const payload = {
    plan_id: planId,
    type,
    artifact_refs: artifactRefs,
    proof_ref: proofRef === undefined ? null : proofRef,
    proof_hash: proofHash === undefined ? null : proofHash,
  };
  if (type === 'phase-closed') payload.phase_key = phaseKey;
  return payload;
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

// Current-state gate: the plan's committed state must legally accept the
// requested event type. `spec-approved` fires once (PENDING → APPROVED);
// once the plan is closed (DONE) no further transition is legal. Rejection
// happens before any journal mutation, so an invalid transition emits no
// event and leaves the document byte-identical.
//
// phase-closed is legal once per phase, and only after that phase's
// phase-complete. Events never store phaseKey (EVENT_FIELDS is closed), so a
// prior close for this phaseKey is found by recomputing each stored
// phase-closed payload hash with the candidate phaseKey.
function phaseAlreadyClosed(doc, phaseKey) {
  return doc.events.some((event) => event.type === 'phase-closed'
    && hashCanonicalPayload(logicalPayload({
      planId: event.plan_id,
      type: 'phase-closed',
      artifactRefs: event.artifact_refs,
      proofRef: event.proof_ref,
      proofHash: event.proof_hash,
      phaseKey,
    })) === event.payload_hash);
}

function checkStateAllowsTransition(doc, type, phaseKey) {
  const state = (doc.plan && doc.plan.state) || {};
  if (state.status === 'DONE') {
    return fail('LIFECYCLE_BAD_STATE', `plan is closed; ${type} is not allowed`);
  }
  if (type === 'spec-approved' && state.approval === 'APPROVED') {
    return fail('LIFECYCLE_BAD_STATE', 'spec has already been approved');
  }
  if (type === 'phase-closed') {
    if ((state.phase_status || {})[phaseKey] !== 'COMPLETE') {
      return fail('LIFECYCLE_BAD_STATE', `${phaseKey} is not COMPLETE; phase-closed is not allowed`);
    }
    if (phaseAlreadyClosed(doc, phaseKey)) {
      return fail('LIFECYCLE_BAD_STATE', `${phaseKey} has already been closed`);
    }
  }
  return { ok: true, code: null, message: null };
}

module.exports = {
  logicalPayload,
  applyStateSnapshot,
  checkStateAllowsTransition,
};
