'use strict';

const { redactSecrets } = require('./retry');

class PhaseHandlerError extends Error {
  constructor(code, message, { status = 'terminal', retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function phaseFailure(eventId, code, message, status, retryable) {
  return {
    event_id: eventId,
    status,
    error: { code, retryable, message: redactSecrets(String(message || code)) },
  };
}

function safeMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error ?? 'unknown error');
}


module.exports = { PhaseHandlerError, phaseFailure, safeMessage };
