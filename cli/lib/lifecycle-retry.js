'use strict';

const MAX_DELIVERY_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

function protocolFailure(code, message, retryable = true) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function safeErrorCode(code, fallback = 'ADAPTER_PROTOCOL_ERROR') {
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : fallback;
}

function failureDeliveryPatch(error, attempts, nowMs) {
  const retryable = error.retryable !== false;
  const canRetry = retryable && attempts < MAX_DELIVERY_ATTEMPTS;
  const code = safeErrorCode(error.code);
  if (canRetry) {
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    return {
      status: 'retryable',
      next_attempt_at: new Date(nowMs + delay).toISOString(),
      manual_resolution: false,
      error: {
        code,
        retryable: true,
        message: 'registered lifecycle adapter returned a retryable protocol failure',
        attempts,
      },
    };
  }
  return {
    status: 'terminal',
    next_attempt_at: null,
    manual_resolution: true,
    error: {
      code: attempts >= MAX_DELIVERY_ATTEMPTS ? 'MAX_ADAPTER_ATTEMPTS_EXCEEDED' : code,
      retryable: false,
      message: attempts >= MAX_DELIVERY_ATTEMPTS
        ? 'maximum lifecycle adapter attempts reached; manual resolution required'
        : 'registered lifecycle adapter requires manual resolution',
      attempts,
    },
  };
}

function responseProof(response) {
  const proof = {};
  for (const key of ['proof_ref', 'proof_hash']) {
    if (Object.prototype.hasOwnProperty.call(response, key)) proof[key] = response[key];
  }
  return proof;
}

function retryableResponsePatch(response, attempts, nowMs) {
  const adapterError = response.error || {
    code: 'ADAPTER_RETRYABLE',
    retryable: true,
    message: 'adapter requested a retry',
  };
  const outcome = failureDeliveryPatch(
    protocolFailure(
      safeErrorCode(adapterError.code),
      'registered lifecycle adapter reported a retryable outcome',
      adapterError.retryable,
    ),
    attempts,
    nowMs,
  );
  return outcome;
}

function terminalResponsePatch(response, attempts, nowMs) {
  const adapterError = response.error || {
    code: 'ADAPTER_TERMINAL',
    retryable: false,
    message: 'adapter requested manual resolution',
  };
  return failureDeliveryPatch(
    protocolFailure(
      safeErrorCode(adapterError.code, 'ADAPTER_TERMINAL'),
      'registered lifecycle adapter requires manual resolution',
      false,
    ),
    attempts,
    nowMs,
  );
}

function reconciliationResponsePatch(response, attempts, nowMs) {
  const reconciliationError = response.error || {
    code: 'ADAPTER_RECONCILIATION_LIMIT',
    retryable: false,
    message: 'adapter requires manual reconciliation',
  };
  return failureDeliveryPatch(
    protocolFailure(
      safeErrorCode(reconciliationError.code, 'ADAPTER_RECONCILIATION_LIMIT'),
      'adapter requires manual resolution after bounded reconciliation attempts',
      false,
    ),
    attempts,
    nowMs,
  );
}

function responseDeliveryPatch(response, attempts, nowMs) {
  const proof = responseProof(response);
  if (response.status === 'succeeded') {
    return {
      ...proof,
      status: 'succeeded',
      error: null,
      next_attempt_at: null,
      manual_resolution: false,
    };
  }
  if (response.status === 'retryable') {
    return { ...proof, ...retryableResponsePatch(response, attempts, nowMs) };
  }
  if (response.status === 'terminal') {
    return { ...proof, ...terminalResponsePatch(response, attempts, nowMs) };
  }
  if (attempts >= MAX_DELIVERY_ATTEMPTS || (response.error && response.error.retryable === false)) {
    return { ...proof, ...reconciliationResponsePatch(response, attempts, nowMs) };
  }
  return {
    ...proof,
    status: 'reconciling',
    error: response.error ? {
      code: safeErrorCode(response.error.code),
      retryable: response.error.retryable,
      message: 'registered lifecycle adapter reported an outcome requiring reconciliation',
      attempts,
    } : null,
    next_attempt_at: null,
    manual_resolution: false,
  };
}

module.exports = {
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_MS,
  failureDeliveryPatch,
  protocolFailure,
  responseDeliveryPatch,
  safeErrorCode,
};
