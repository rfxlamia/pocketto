'use strict';

const { validateEvent } = require('./lifecycle-contract');

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function normalizeDeliveryPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return fail('LIFECYCLE_BAD_DELIVERY', 'delivery update must be an object');
  }

  const deliveryPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (['status', 'attempts', 'error', 'next_attempt_at', 'manual_resolution', 'proof_ref', 'proof_hash'].includes(key)) {
      deliveryPatch[key] = value;
    } else {
      return fail('LIFECYCLE_BAD_DELIVERY', `unsupported delivery update field: ${key}`);
    }
  }
  return { ok: true, deliveryPatch };
}

function validateDeliveryError(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return fail('LIFECYCLE_BAD_DELIVERY', 'delivery.error must be an object or null');
  }

  const errorFields = ['code', 'retryable', 'message', 'attempts'];
  if (Object.keys(error).some((key) => !errorFields.includes(key))) {
    return fail('LIFECYCLE_BAD_DELIVERY', 'delivery.error has unsupported fields');
  }
  if (typeof error.code !== 'string' || error.code.length === 0 || error.code.length > 128) {
    return fail('LIFECYCLE_BAD_DELIVERY', 'delivery.error.code must be a bounded non-empty string');
  }
  if (typeof error.retryable !== 'boolean' || typeof error.message !== 'string' || error.message.length === 0 || error.message.length > 256) {
    return fail('LIFECYCLE_BAD_DELIVERY', 'delivery.error must include a retryable flag and bounded message');
  }
  if ('attempts' in error && (!Number.isInteger(error.attempts) || error.attempts < 1 || error.attempts > 6)) {
    return fail('LIFECYCLE_BAD_DELIVERY', 'delivery.error.attempts must be between 1 and 6');
  }
  return null;
}

function validateDeliveryTimingAndResolution(deliveryPatch) {
  if ('next_attempt_at' in deliveryPatch && deliveryPatch.next_attempt_at !== null) {
    if (typeof deliveryPatch.next_attempt_at !== 'string' || Number.isNaN(Date.parse(deliveryPatch.next_attempt_at))) {
      return fail('LIFECYCLE_BAD_DELIVERY', 'delivery.next_attempt_at must be a timestamp or null');
    }
  }
  if ('manual_resolution' in deliveryPatch && typeof deliveryPatch.manual_resolution !== 'boolean') {
    return fail('LIFECYCLE_BAD_DELIVERY', 'delivery.manual_resolution must be a boolean');
  }
  return null;
}

function validateDeliveryProofs(deliveryPatch) {
  // Adapter proofs belong to delivery metadata, preserving the committed event payload hash.
  for (const key of ['proof_ref', 'proof_hash']) {
    if (key in deliveryPatch && deliveryPatch[key] !== null && typeof deliveryPatch[key] !== 'string') {
      return fail('LIFECYCLE_BAD_DELIVERY', `delivery.${key} must be an opaque string or null`);
    }
  }
  return null;
}

// Pure validation: returns the replacement delivery record without mutating or persisting the event.
function validateDeliveryPatch(event, patch) {
  const normalized = normalizeDeliveryPatch(patch);
  if (!normalized.ok) return normalized;
  const deliveryPatch = normalized.deliveryPatch;

  if ('error' in deliveryPatch && deliveryPatch.error !== null) {
    const errorValidation = validateDeliveryError(deliveryPatch.error);
    if (errorValidation) return errorValidation;
  }
  const timingValidation = validateDeliveryTimingAndResolution(deliveryPatch);
  if (timingValidation) return timingValidation;
  const proofValidation = validateDeliveryProofs(deliveryPatch);
  if (proofValidation) return proofValidation;

  const updated = { ...event, delivery: { ...event.delivery, ...deliveryPatch } };
  const validation = validateEvent(updated);
  if (!validation.ok) return fail(validation.code, validation.message);
  return { ok: true, delivery: updated.delivery };
}

module.exports = { validateDeliveryPatch };
