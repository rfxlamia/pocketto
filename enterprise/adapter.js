'use strict';

// Enterprise adapter entry point + bounded response serializer (T7).
// The adapter is the sole v4 remote writer; its stdout protocol back to
// Core is the opaque T1 adapter response only. GitHub IDs, credentials,
// `gh` invocations, and ownership rules never appear in responses — only
// opaque proof refs plus redacted diagnostics.

const { validateAdapterResponse } = require('../cli/lib/lifecycle-contract');
const { redactSecrets } = require('./retry');

const ADAPTER_STATUSES = ['succeeded', 'retryable', 'terminal', 'reconciling'];

function buildError(code, message, retryable) {
  return {
    code: typeof code === 'string' && code.length > 0 ? code : 'GH_UNKNOWN',
    retryable: retryable === true,
    message: redactSecrets(typeof message === 'string' ? message : String(message ?? '')),
  };
}

// Builds the bounded stdout protocol object. Drops every field outside the
// T1 allowlist, echoes the original event ID, passes opaque proof refs
// through unchanged, and redacts the diagnostic message. Throws on a
// response that cannot satisfy the T1 contract (never emit malformed).
function serializeResponse(input, expectedEventId) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('ADAPTER_NOT_OBJECT: adapter response must be an object');
  }
  const expected = typeof expectedEventId === 'string'
    ? expectedEventId
    : (typeof input.event_id === 'string' ? input.event_id : undefined);
  if (typeof input.event_id !== 'string' || input.event_id.length === 0) {
    throw new Error('ADAPTER_BAD_EVENT_ID: adapter response requires an event_id');
  }
  if (!ADAPTER_STATUSES.includes(input.status)) {
    throw new Error(`ADAPTER_BAD_STATUS: unsupported adapter status: ${input.status}`);
  }
  const out = { event_id: input.event_id, status: input.status };
  if (input.proof_ref !== undefined && input.proof_ref !== null) {
    if (typeof input.proof_ref !== 'string') {
      throw new Error('ADAPTER_BAD_PROOF: proof_ref must be an opaque string');
    }
    out.proof_ref = input.proof_ref;
  }
  if (input.proof_hash !== undefined && input.proof_hash !== null) {
    if (typeof input.proof_hash !== 'string') {
      throw new Error('ADAPTER_BAD_PROOF: proof_hash must be an opaque string');
    }
    out.proof_hash = input.proof_hash;
  }
  if (input.error !== undefined && input.error !== null) {
    if (typeof input.error !== 'object' || Array.isArray(input.error)) {
      throw new Error('ADAPTER_BAD_ERROR: adapter error must be an object');
    }
    const { code, retryable, message } = input.error;
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('ADAPTER_BAD_ERROR: adapter error.code must be a non-empty string');
    }
    if (typeof retryable !== 'boolean') {
      throw new Error('ADAPTER_BAD_ERROR: adapter error.retryable must be a boolean');
    }
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('ADAPTER_BAD_ERROR: adapter error.message must be a non-empty string');
    }
    out.error = { code, retryable, message: redactSecrets(message) };
  }
  const checked = validateAdapterResponse(out, expected);
  if (!checked.ok) {
    throw new Error(`${checked.code}: ${checked.message}`);
  }
  return out;
}

module.exports = { serializeResponse, buildError, ADAPTER_STATUSES };
