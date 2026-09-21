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

// Bounded retry policy (spec-normative): one initial invocation plus at
// most five retries, delayed 1s, 5s, 30s, 120s, and 600s after failures.
// After the fifth retry the event is terminal/manual resolution.
const RETRY_DELAYS_MS = [1000, 5000, 30000, 120000, 600000];
const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;

// Explicit failure taxonomy. Timeout/rate-limit (transient transport
// pressure) is retryable; auth/permission/validation/integrity (the remote
// side refused or the data is unusable) is terminal with an actionable
// message. Malformed output and unknown non-zero exits are retryable until
// the bound — never success. Classification is a pure local mapping: it
// performs no I/O and implies no remote mutation.
function classifyGhResult(result, opts = {}) {
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const exit = typeof result.exit === 'number' ? result.exit : 1;
  const timedOut = result.timedOut === true;
  const combined = `${stderr}\n${stdout}`;

  const redacted = (message) => redactSecrets(message);

  if (timedOut || /\btimed?\s?out\b/i.test(combined) || /\bETIMEDOUT\b/.test(combined)) {
    return {
      status: 'retryable',
      error: { code: 'GH_TIMEOUT', retryable: true, message: redacted(`gh timed out: ${stderr || 'no output'}`) },
    };
  }
  if (/\brate[\s-]?limit/i.test(combined) || /\bHTTP\s+429\b/.test(combined)) {
    return {
      status: 'retryable',
      error: { code: 'GH_RATE_LIMITED', retryable: true, message: redacted(`gh rate-limited: ${stderr || stdout || 'no output'}`) },
    };
  }
  if (/\bHTTP\s+401\b/.test(combined) || /\bBad credentials\b/i.test(combined) || /\bauthentication\b/i.test(combined)) {
    return {
      status: 'terminal',
      error: { code: 'GH_AUTH', retryable: false, message: redacted(`gh authentication failed: ${stderr || stdout || 'no output'}`) },
    };
  }
  if (/\bHTTP\s+403\b/.test(combined) || /\bForbidden\b/.test(combined) || /\bpermission denied\b/i.test(combined) || /\bnot authorized\b/i.test(combined)) {
    return {
      status: 'terminal',
      error: { code: 'GH_FORBIDDEN', retryable: false, message: redacted(`gh refused (permission): ${stderr || stdout || 'no output'}`) },
    };
  }
  if (/\bHTTP\s+422\b/.test(combined) || /\bValidation Failed\b/i.test(combined) || /\bvalidation\b/i.test(combined)) {
    return {
      status: 'terminal',
      error: { code: 'GH_VALIDATION', retryable: false, message: redacted(`gh validation failed: ${stderr || stdout || 'no output'}`) },
    };
  }
  if (/\bintegrity\b/i.test(combined) || /\bhash mismatch\b/i.test(combined) || /\bchecksum\b/i.test(combined)) {
    return {
      status: 'terminal',
      error: { code: 'GH_INTEGRITY', retryable: false, message: redacted(`gh integrity failure: ${stderr || stdout || 'no output'}`) },
    };
  }
  if (opts.expectJson === true && exit === 0) {
    // exit 0 with unparseable JSON: the transport lied or truncated.
    return {
      status: 'retryable',
      error: { code: 'GH_MALFORMED_OUTPUT', retryable: true, message: redacted(`gh returned malformed output: ${(stdout || '').slice(0, 200)}`) },
    };
  }
  if (exit === 0) {
    return { status: 'succeeded', error: null };
  }
  return {
    status: 'retryable',
    error: { code: 'GH_UNKNOWN', retryable: true, message: redacted(`gh failed (exit ${exit}): ${stderr || stdout || 'no output'}`) },
  };
}

// Applies the retry bound to an already-classified outcome. Terminal stays
// terminal; retryable stays retryable with its scheduled delay while
// attempts remain, then becomes terminal/manual resolution. Pure mapping —
// no I/O, no mutation.
function boundOutcome(classified, attemptsMade) {
  if (!classified || classified.status !== 'retryable') return classified;
  if (attemptsMade <= MAX_RETRY_ATTEMPTS) {
    return {
      status: 'retryable',
      error: classified.error,
      nextAttemptMs: RETRY_DELAYS_MS[attemptsMade - 1],
    };
  }
  return {
    status: 'terminal',
    error: {
      code: classified.error && classified.error.code ? classified.error.code : 'GH_UNKNOWN',
      retryable: false,
      message: redactSecrets(
        `${classified.error && classified.error.message ? classified.error.message : 'gh failed'} (retry budget exhausted after ${MAX_RETRY_ATTEMPTS} retries; manual resolution required)`
      ),
    },
  };
}

module.exports = {
  redactSecrets,
  redactError,
  REDACTED,
  RETRY_DELAYS_MS,
  MAX_RETRY_ATTEMPTS,
  classifyGhResult,
  boundOutcome,
};
