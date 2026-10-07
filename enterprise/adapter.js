'use strict';

// Enterprise adapter entry point + bounded response serializer (T7).
// The adapter is the sole v4 remote writer; its stdout protocol back to
// Core is the opaque T1 adapter response only. GitHub IDs, credentials,
// `gh` invocations, and ownership rules never appear in responses — only
// opaque proof refs plus redacted diagnostics.

const { validateEvent, validateAdapterResponse } = require('../cli/lib/lifecycle-contract');
const { PhaseHandlerError } = require('./phase-handler-errors');
const { redactSecrets } = require('./retry');

let CORE_VERSION = null;
try {
  CORE_VERSION = require('../cli/lib/version');
} catch {
  CORE_VERSION = null;
}

const ADAPTER_STATUSES = ['succeeded', 'retryable', 'terminal', 'reconciling'];

// Explicit handler dispatch table: exactly the three neutral lifecycle
// event types, each naming the Enterprise handler that owns it. The names
// are local handler keys — remote policy stays in the Phase 2 handlers.
const HANDLERS = {
  'spec-approved': 'handleSpecApproved',
  'phase-complete': 'handlePhaseComplete',
  'plan-closed': 'handlePlanClosed',
};

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

function invalidEventResponse(eventId, eventValidation) {
  const validationCode = typeof eventValidation.code === 'string' ? eventValidation.code : 'LIFECYCLE_INVALID_EVENT';
  return serializeResponse({
    event_id: eventId,
    status: 'terminal',
    error: {
      code: 'ADAPTER_PROTOCOL_INVALID_EVENT',
      retryable: false,
      message: `Lifecycle event violates the neutral schema (${validationCode}); no handler or GitHub call ran.`,
    },
  }, eventId === 'unknown-event' ? undefined : eventId);
}

function validateIncomingEvent(event, eventId) {
  let eventValidation;
  try {
    eventValidation = validateEvent(event);
  } catch {
    eventValidation = { ok: false, code: 'LIFECYCLE_INVALID_EVENT' };
  }
  return eventValidation.ok ? null : invalidEventResponse(eventId, eventValidation);
}

function registrationForProject(projectRoot, protocolError) {
  let registration;
  try {
    registration = require('./registration');
  } catch (err) {
    return { response: protocolError(
      'ADAPTER_PROTOCOL_ERROR',
      `Adapter registration boundary is unavailable: ${redactSecrets(err && err.message ? err.message : String(err))}`
    ) };
  }
  const loaded = registration.loadRegistration(projectRoot);
  if (!loaded.ok) {
    return { response: protocolError(
      loaded.code === 'ENTERPRISE_ADAPTER_CONTRACT_MISMATCH' ? 'ADAPTER_CONTRACT_MISMATCH' : 'ADAPTER_PROTOCOL_REGISTRATION',
      `${loaded.message} The event stays pending/retryable and no handler or GitHub call ran.`
    ) };
  }
  return { record: loaded.record };
}

function resolveEventHandler(eventType, record, opts, protocolError) {
  if (!record.events.includes(eventType)) {
    return { response: protocolError(
      'ADAPTER_EVENT_NOT_ALLOWED',
      `Event type "${eventType}" is not in the adapter registration allowlist. Update the registration; the event stays pending/retryable and no handler or GitHub call ran.`
    ) };
  }
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, eventType)) {
    return { response: protocolError(
      'ADAPTER_PROTOCOL_NO_HANDLER',
      `No Enterprise handler is registered for event type "${eventType}". The event stays pending and no GitHub call ran.`
    ) };
  }
  const handlers = opts.handlers || {};
  const handler = handlers[eventType];
  if (typeof handler !== 'function') {
    return { response: protocolError(
      'ADAPTER_PROTOCOL_NO_HANDLER',
      `Enterprise handler "${HANDLERS[eventType]}" is unavailable for event type "${eventType}". The event stays pending and no GitHub call ran.`
    ) };
  }
  return { handler };
}

function prepareLifecycleEvent(event, lifecycleDelivery) {
  let handlerEvent = event;
  let deliveryState = null;
  if (lifecycleDelivery && typeof lifecycleDelivery.prepare === 'function') {
    const prepared = lifecycleDelivery.prepare(event);
    if (prepared && prepared.response) return { response: prepared.response };
    if (prepared && prepared.event) handlerEvent = prepared.event;
    deliveryState = prepared && prepared.state;
  }
  return { handlerEvent, deliveryState };
}

function hasValidTypedHandlerClassification(error) {
  return error instanceof PhaseHandlerError
    && typeof error.code === 'string'
    && error.code.length > 0
    && ((error.status === 'terminal' && error.retryable === false)
      || (error.status === 'retryable' && error.retryable === true));
}

function invokeHandler(handler, handlerEvent, projectRoot, record, ghRunner, eventId, protocolError) {
  try {
    return { produced: handler(handlerEvent, { projectRoot, record, ghRunner }) };
  } catch (err) {
    if (hasValidTypedHandlerClassification(err)) {
      return { response: serializeResponse({
        event_id: eventId,
        status: err.status,
        error: {
          code: err.code,
          retryable: err.retryable,
          message: `Enterprise context validation failed before remote mutation: ${redactSecrets(err.message)}`,
        },
      }, eventId) };
    }
    return { response: protocolError(
      'ADAPTER_PROTOCOL_HANDLER_FAILED',
      `Enterprise handler failed before remote mutation completed: ${redactSecrets(err && err.message ? err.message : String(err))}`
    ) };
  }
}

function completeHandlerResponse(produced, event, eventId, lifecycleDelivery, deliveryState, protocolError) {
  // Serialize through the response boundary: malformed handler output can
  // never leak as success — it throws, which the caller treats as retryable.
  try {
    const response = serializeResponse(produced, eventId);
    if (lifecycleDelivery && typeof lifecycleDelivery.complete === 'function') {
      const completed = lifecycleDelivery.complete(event, response, deliveryState);
      return serializeResponse(completed || response, eventId);
    }
    return response;
  } catch (err) {
    return protocolError(
      'ADAPTER_PROTOCOL_MALFORMED_RESPONSE',
      `Enterprise handler returned a malformed response: ${redactSecrets(err && err.message ? err.message : String(err))}`
    );
  }
}

// Compatibility boundary + explicit dispatch.
//
// Mirrors Core's registered-executable invocation contract: before any
// handler or GitHub call, verifies (1) the Core envelope contract is the
// supported major, (2) the registration record exists and declares a
// compatible adapter contract, and (3) the event type is in the
// registration allowlist and the dispatch table. Any mismatch returns an
// actionable retryable protocol result carrying the original event ID —
// the event stays pending/retryable for Core replay, and no handler or
// GitHub runner is invoked. The boundary itself performs no GitHub calls.
function dispatchEvent(event, opts = {}) {
  const eventId = event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event';
  const protocolError = (code, message) => serializeResponse({
    event_id: eventId,
    status: 'retryable',
    error: { code, retryable: true, message },
  }, eventId === 'unknown-event' ? undefined : eventId);

  const invalidEvent = validateIncomingEvent(event, eventId);
  if (invalidEvent) return invalidEvent;

  const expectedCoreContract = CORE_VERSION ? CORE_VERSION.CONTRACT : 3;
  const coreContract = opts.coreContract !== undefined ? opts.coreContract : expectedCoreContract;
  if (coreContract !== expectedCoreContract) {
    return protocolError(
      'ADAPTER_PROTOCOL_CORE_MISMATCH',
      `Core contract ${coreContract} is incompatible with Enterprise adapter boundary (expected ${expectedCoreContract}). Upgrade Core; the event stays pending and no handler or GitHub call ran.`
    );
  }

  const projectRoot = opts.projectRoot;
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return protocolError(
      'ADAPTER_PROTOCOL_NO_PROJECT',
      'Adapter dispatch requires a project root. The event stays pending and no handler or GitHub call ran.'
    );
  }

  const registration = registrationForProject(projectRoot, protocolError);
  if (registration.response) return registration.response;
  const eventType = event && typeof event.type === 'string' ? event.type : null;
  const selected = resolveEventHandler(eventType, registration.record, opts, protocolError);
  if (selected.response) return selected.response;

  const lifecycleDelivery = opts.lifecycleDelivery;
  const prepared = prepareLifecycleEvent(event, lifecycleDelivery);
  if (prepared.response) return prepared.response;
  const invocation = invokeHandler(selected.handler, prepared.handlerEvent, projectRoot,
    registration.record, opts.ghRunner, eventId, protocolError);
  if (invocation.response) return invocation.response;
  return completeHandlerResponse(invocation.produced, event, eventId, lifecycleDelivery,
    prepared.deliveryState, protocolError);
}

module.exports = { serializeResponse, buildError, ADAPTER_STATUSES, HANDLERS, dispatchEvent };
