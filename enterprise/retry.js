'use strict';

// Enterprise-only secret redaction plus bounded retry policy (T7).
// All diagnostics leaving the adapter must be secret-free: no token,
// credential, bearer material, or raw secret-bearing command argument.
// Classification never implies a remote mutation — it only maps an
// observed local result to a bounded outcome.

const REDACTED = '[redacted]';
const SECRET_FLAG_NAME = /(?:token|secret|password|auth|credential)/i;

function isFlagNameCharacter(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 45
    || code === 95;
}

function isFlagWhitespace(code) {
  return /\s/.test(String.fromCharCode(code));
}

function secretFlagValueEnd(input, nameEnd) {
  let separatorEnd = nameEnd;
  while (isFlagWhitespace(input.charCodeAt(separatorEnd))) separatorEnd += 1;

  if (input[separatorEnd] === '=' || input[separatorEnd] === ':') {
    while (input[separatorEnd] === '=' || input[separatorEnd] === ':') separatorEnd += 1;
    while (isFlagWhitespace(input.charCodeAt(separatorEnd))) separatorEnd += 1;
  } else if (separatorEnd === nameEnd) {
    return null;
  }

  const first = input[separatorEnd];
  if (first === '"' || first === "'") {
    const quote = first;
    let cursor = separatorEnd + 1;
    while (cursor < input.length) {
      if (input[cursor] === '\\') {
        cursor += 2;
      } else if (input[cursor] === quote) {
        return { separatorEnd, valueEnd: cursor + 1 };
      } else {
        cursor += 1;
      }
    }
    return { separatorEnd, valueEnd: input.length };
  }

  let valueEnd = separatorEnd;
  while (valueEnd < input.length) {
    const character = input[valueEnd];
    if (isFlagWhitespace(input.charCodeAt(valueEnd)) || character === ',' || character === ';' || character === '}' || character === '"' || character === "'") break;
    valueEnd += 1;
  }
  return valueEnd > separatorEnd ? { separatorEnd, valueEnd } : null;
}

function redactSecretFlags(input) {
  const chunks = [];
  let copyFrom = 0;
  let cursor = 0;

  while (cursor + 1 < input.length) {
    if (input.charCodeAt(cursor) !== 45 || input.charCodeAt(cursor + 1) !== 45) {
      cursor += 1;
      continue;
    }
    if (cursor > 0 && isFlagNameCharacter(input.charCodeAt(cursor - 1))) {
      cursor += 2;
      continue;
    }

    let nameEnd = cursor + 2;
    while (nameEnd < input.length && isFlagNameCharacter(input.charCodeAt(nameEnd))) nameEnd += 1;
    if (nameEnd === cursor + 2) {
      cursor += 2;
      continue;
    }

    const flagName = input.slice(cursor, nameEnd);
    if (!SECRET_FLAG_NAME.test(flagName)) {
      cursor = nameEnd;
      continue;
    }

    const parsedValue = secretFlagValueEnd(input, nameEnd);
    if (!parsedValue) {
      cursor = nameEnd;
      continue;
    }

    chunks.push(
      input.slice(copyFrom, cursor),
      `--${REDACTED}`,
      input.slice(nameEnd, parsedValue.separatorEnd),
      REDACTED
    );
    copyFrom = parsedValue.valueEnd;
    cursor = parsedValue.valueEnd;
  }

  if (copyFrom === 0) return input;
  chunks.push(input.slice(copyFrom));
  return chunks.join('');
}

function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  // Strip secret-bearing CLI flags with their values first (raw argument
  // must not survive in any diagnostic).
  out = redactSecretFlags(out);
  // Authorization headers carry a scheme followed by its credential, so
  // redact the whole value for standard and custom schemes alike.
  out = out.replace(
    /(^|[^A-Za-z0-9_])((?:\\{0,2}["']?AUTHORIZATION\\{0,2}["']?\s*[:=]\s*))(?:\\{0,2}"(?:\\.|[^"\\])*\\{0,2}"|\\{0,2}'(?:\\.|[^'\\])*\\{0,2}'|\\{0,2}[-!#$%&'*+.^_`|~0-9A-Za-z]+\s+(?:\\{0,2}"(?:\\.|[^"\\])*\\{0,2}"|\\{0,2}'(?:\\.|[^'\\])*\\{0,2}'|[^\s,;}]+)|\\{0,2}[^\s,;}]+)/gi,
    `$1$2${REDACTED}`
  );
  // Bearer tokens.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  // Named and generic token assignments, including quoted values.
  out = out.replace(
    /\\{0,2}["']?(?:GITHUB_TOKEN|GH_TOKEN|AUTHORIZATION|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|CREDENTIAL|SECRET|PASSWORD)\\{0,2}["']?\s*([=:])\s*(?:\\{0,2}"(?:\\.|[^"\\])*\\{0,2}"|\\{0,2}'(?:\\.|[^'\\])*\\{0,2}'|[^\s,;}]+)/gi,
    `${REDACTED}=${REDACTED}`
  );
  // gh-style issued tokens.
  out = out.replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_.-]+/gi, REDACTED);
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
