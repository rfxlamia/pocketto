'use strict';

// Enterprise-only secret redaction plus bounded retry policy (T7).
// All diagnostics leaving the adapter must be secret-free: no token,
// credential, bearer material, or raw secret-bearing command argument.
// Classification never implies a remote mutation — it only maps an
// observed local result to a bounded outcome.

const REDACTED = '[redacted]';

function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  // Strip secret-bearing CLI flags with their values first (raw argument
  // must not survive in any diagnostic).
  out = out.replace(
    /--[A-Za-z0-9_-]*(token|secret|password|auth|credential)[A-Za-z0-9_-]*([=\s:]+)([^\s,;}"']+)/gi,
    `--${REDACTED}$2${REDACTED}`
  );
  // Key=value / key: value assignments carrying secret material.
  out = out.replace(
    /\b(GITHUB_TOKEN|GH_TOKEN|AUTHORIZATION)\b\s*[:=]\s*([^\s,;}"']+)/gi,
    `${REDACTED}=$2`.replace(/\$2$/, REDACTED)
  );
  // Bearer tokens.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  // gh-style issued tokens.
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, REDACTED);
  // Generic secret-ish assignments: credential/secret/password/token keys.
  out = out.replace(
    /\b(credential|secret|password)\b\s*[:=]\s*([^\s,;}"']+)/gi,
    `${REDACTED} ${REDACTED}`
  );
  // Final sweep: the words themselves must not appear in diagnostics.
  out = out.replace(/\bcredentials?\b/gi, REDACTED);
  out = out.replace(/\btokens?\b/gi, REDACTED);
  return out;
}

function redactError(error) {
  if (error === null || error === undefined) return error;
  if (typeof error !== 'object' || Array.isArray(error)) return { code: 'GH_UNKNOWN', retryable: true, message: redactSecrets(String(error)) };
  return {
    code: typeof error.code === 'string' && error.code.length > 0 ? error.code : 'GH_UNKNOWN',
    retryable: error.retryable === true,
    message: typeof error.message === 'string' ? redactSecrets(error.message) : redactSecrets(String(error.message ?? '')),
  };
}

module.exports = { redactSecrets, redactError, REDACTED };
