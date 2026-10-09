'use strict';

// Neutral v4 lifecycle event contract (T1, Cycle 2).
//
// Allowlisted, versioned vocabulary shared by Core and Enterprise surfaces:
// event names plus opaque proof/artifact references only. Remote identity,
// secrets, and external commands are never accepted fields here.

const { createHash } = require('node:crypto');

const EVENT_TYPES = ['spec-approved', 'phase-complete', 'plan-closed'];

const DELIVERY_STATUSES = [
  'pending',
  'claimed',
  'succeeded',
  'retryable',
  'terminal',
  'reconciling',
];

const EVENT_FIELDS = [
  'event_id',
  'plan_id',
  'type',
  'revision',
  'occurred_at',
  'artifact_refs',
  'payload_hash',
  'proof_ref',
  'proof_hash',
  'delivery',
];

const ARTIFACT_ROOTS = ['spec', 'plan'];

const ARTIFACT_FIELDS = ['root', 'kind', 'path', 'sha256', 'revision'];

// One serialized event is limited to 64 KiB.
const MAX_EVENT_BYTES = 64 * 1024;

const PLAN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

function fail(code, message) {
  return { ok: false, code, message };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildEventId(planId, type, revision) {
  return `${planId}:${type}:r${revision}`;
}

// Volatile delivery/transport fields excluded from the canonical identity:
// they change as the event moves through the journal without changing
// what the event means.
const VOLATILE_FIELDS = ['delivery', 'occurred_at'];

function normalizeArtifactRef(ref) {
  if (!isPlainObject(ref)) return normalizeText(ref);
  const out = {};
  for (const key of Object.keys(ref).sort()) {
    if (VOLATILE_FIELDS.includes(key)) continue;
    out[key] = key === 'path' ? ref[key] : normalizeText(ref[key]);
  }
  return out;
}

function normalizeText(value) {
  if (typeof value === 'string') {
    // CRLF and lone-CR are equivalent to LF for identity purposes.
    return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }
  if (Array.isArray(value)) {
    return value.map(normalizeText);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_FIELDS.includes(key)) continue;
      out[key] = key === 'artifact_refs' && Array.isArray(value[key])
        ? value[key].map(normalizeArtifactRef)
        : normalizeText(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalizePayload(value) {
  return normalizeText(value);
}

function hashCanonicalPayload(value) {
  return createHash('sha256').update(JSON.stringify(canonicalizePayload(value))).digest('hex');
}

function checkEventSize(event) {
  const serializedBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
  if (serializedBytes > MAX_EVENT_BYTES) {
    return { ok: false, code: 'LIFECYCLE_EVENT_TOO_LARGE', bytes: serializedBytes, limit: MAX_EVENT_BYTES };
  }
  return { ok: true, code: null, bytes: serializedBytes, limit: MAX_EVENT_BYTES };
}

function isRootRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return false;
  const segments = value.split('/');
  for (const seg of segments) {
    if (seg === '..') return false;
  }
  if (segments.includes('..')) return false;
  // Reject `.`/`..` traversals that stay syntactically inside but escape the root.
  let depth = 0;
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return false;
    depth += 1;
    if (depth < 0) return false;
  }
  if (value === '..' || value.startsWith('../') || value.includes('/../') || value.endsWith('/..')) {
    return false;
  }
  return true;
}

// Pure root-specific artifact-reference validation. Filesystem-root
// existence and symlink-escape checks live at T2's store boundary —
// this only validates the serialized { root, kind, path, sha256, revision }
// shape with stable error codes.
function validateArtifactRef(ref) {
  if (!isPlainObject(ref)) {
    return fail('LIFECYCLE_BAD_ARTIFACT', 'artifact ref must be an object');
  }
  for (const key of Object.keys(ref)) {
    if (!ARTIFACT_FIELDS.includes(key)) {
      return fail('LIFECYCLE_BAD_ARTIFACT', `unsupported artifact field: ${key}`);
    }
  }
  for (const key of ARTIFACT_FIELDS) {
    if (!(key in ref)) {
      return fail('LIFECYCLE_BAD_ARTIFACT', `missing artifact field: ${key}`);
    }
  }
  if (!ARTIFACT_ROOTS.includes(ref.root)) {
    return fail('LIFECYCLE_BAD_ARTIFACT_ROOT', `unsupported artifact root: ${ref.root}`);
  }
  if (typeof ref.kind !== 'string' || ref.kind.length === 0) {
    return fail('LIFECYCLE_BAD_ARTIFACT', 'artifact kind must be a non-empty string');
  }
  if (!isRootRelativePath(ref.path)) {
    return fail('LIFECYCLE_BAD_ARTIFACT_PATH', `artifact path must be root-relative: ${ref.path}`);
  }
  if (typeof ref.sha256 !== 'string' || !HEX64_PATTERN.test(ref.sha256)) {
    return fail('LIFECYCLE_BAD_ARTIFACT_HASH', 'artifact sha256 must be a SHA-256 hex digest');
  }
  if (!Number.isInteger(ref.revision) || ref.revision < 0) {
    return fail('LIFECYCLE_BAD_ARTIFACT', 'artifact revision must be a non-negative integer');
  }
  return { ok: true, code: null, message: null };
}

function canonicalArtifactRef(ref) {
  return {
    root: ref.root,
    kind: ref.kind,
    // Filesystem paths are identities, so preserve their exact code points.
    // Text normalization remains in effect for hashes of other payload text.
    path: ref.path,
    sha256: String(ref.sha256).toLowerCase(),
    revision: ref.revision,
  };
}

function validateEvent(event) {
  if (!isPlainObject(event)) {
    return fail('LIFECYCLE_NOT_OBJECT', 'lifecycle event must be an object');
  }
  for (const key of Object.keys(event)) {
    if (!EVENT_FIELDS.includes(key)) {
      return fail('LIFECYCLE_UNKNOWN_FIELD', `unsupported lifecycle field: ${key}`);
    }
  }
  for (const key of EVENT_FIELDS) {
    if (!(key in event)) {
      return fail('LIFECYCLE_MISSING_FIELD', `missing lifecycle field: ${key}`);
    }
  }
  if (!EVENT_TYPES.includes(event.type)) {
    return fail('LIFECYCLE_UNKNOWN_TYPE', `unsupported lifecycle type: ${event.type}`);
  }
  if (typeof event.plan_id !== 'string' || !PLAN_ID_PATTERN.test(event.plan_id)) {
    return fail('LIFECYCLE_BAD_PLAN_ID', 'plan_id must be a kebab-slug');
  }
  if (!Number.isInteger(event.revision) || event.revision < 1) {
    return fail('LIFECYCLE_BAD_REVISION', 'revision must be a positive integer');
  }
  if (event.event_id !== buildEventId(event.plan_id, event.type, event.revision)) {
    return fail('LIFECYCLE_BAD_EVENT_ID', 'event_id must be <plan_id>:<type>:r<revision>');
  }
  if (typeof event.occurred_at !== 'string' || Number.isNaN(Date.parse(event.occurred_at))) {
    return fail('LIFECYCLE_BAD_TIMESTAMP', 'occurred_at must be a timestamp string');
  }
  if (!Array.isArray(event.artifact_refs) || event.artifact_refs.length === 0) {
    return fail('LIFECYCLE_BAD_ARTIFACT', 'artifact_refs must be a non-empty array');
  }
  for (const ref of event.artifact_refs) {
    const result = validateArtifactRef(ref);
    if (!result.ok) return result;
  }
  if (typeof event.payload_hash !== 'string' || !HEX64_PATTERN.test(event.payload_hash)) {
    return fail('LIFECYCLE_BAD_PAYLOAD_HASH', 'payload_hash must be a SHA-256 hex digest');
  }
  for (const key of ['proof_ref', 'proof_hash']) {
    if (event[key] !== null && typeof event[key] !== 'string') {
      return fail('LIFECYCLE_BAD_PROOF', `${key} must be null or an opaque string`);
    }
  }
  if (!isPlainObject(event.delivery)) {
    return fail('LIFECYCLE_BAD_DELIVERY', 'delivery must be an object');
  }
  if (!DELIVERY_STATUSES.includes(event.delivery.status)) {
    return fail('LIFECYCLE_BAD_DELIVERY', `unsupported delivery status: ${event.delivery.status}`);
  }
  if (!Number.isInteger(event.delivery.attempts) || event.delivery.attempts < 0) {
    return fail('LIFECYCLE_BAD_DELIVERY', 'delivery.attempts must be a non-negative integer');
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
  if (serializedBytes > MAX_EVENT_BYTES) {
    return fail('LIFECYCLE_EVENT_TOO_LARGE', `serialized event exceeds ${MAX_EVENT_BYTES} bytes`);
  }
  return { ok: true, code: null, message: null };
}

// Opaque adapter responses: the adapter reports an outcome for a known
// event ID plus optional opaque proof refs. No remote-identity, secret,
// or command field is ever accepted here — the handler owns those and
// writes them only to Enterprise-owned stores.
const ADAPTER_RESPONSE_STATUSES = ['succeeded', 'retryable', 'terminal', 'reconciling'];

const ADAPTER_RESPONSE_FIELDS = ['event_id', 'status', 'proof_ref', 'proof_hash', 'error'];

const ADAPTER_ERROR_CODES = {
  NOT_OBJECT: 'ADAPTER_NOT_OBJECT',
  UNKNOWN_FIELD: 'ADAPTER_UNKNOWN_FIELD',
  BAD_EVENT_ID: 'ADAPTER_BAD_EVENT_ID',
  BAD_STATUS: 'ADAPTER_BAD_STATUS',
  BAD_PROOF: 'ADAPTER_BAD_PROOF',
  BAD_ERROR: 'ADAPTER_BAD_ERROR',
};

function adapterFail(code, message) {
  return { ok: false, code, message };
}

function validateAdapterResponse(response, expectedEventId) {
  if (!isPlainObject(response)) {
    return adapterFail(ADAPTER_ERROR_CODES.NOT_OBJECT, 'adapter response must be an object');
  }
  for (const key of Object.keys(response)) {
    if (!ADAPTER_RESPONSE_FIELDS.includes(key)) {
      return adapterFail(ADAPTER_ERROR_CODES.UNKNOWN_FIELD, `unsupported adapter field: ${key}`);
    }
  }
  if (typeof response.event_id !== 'string' || response.event_id.length === 0) {
    return adapterFail(ADAPTER_ERROR_CODES.BAD_EVENT_ID, 'adapter response requires an event_id');
  }
  if (typeof expectedEventId === 'string' && response.event_id !== expectedEventId) {
    return adapterFail(ADAPTER_ERROR_CODES.BAD_EVENT_ID, 'adapter event_id must match the dispatched event');
  }
  if (!ADAPTER_RESPONSE_STATUSES.includes(response.status)) {
    return adapterFail(ADAPTER_ERROR_CODES.BAD_STATUS, `unsupported adapter status: ${response.status}`);
  }
  for (const key of ['proof_ref', 'proof_hash']) {
    if (key in response && response[key] !== undefined && response[key] !== null && typeof response[key] !== 'string') {
      return adapterFail(ADAPTER_ERROR_CODES.BAD_PROOF, `${key} must be an opaque string`);
    }
  }
  if ('error' in response && response.error !== undefined && response.error !== null) {
    if (!isPlainObject(response.error)) {
      return adapterFail(ADAPTER_ERROR_CODES.BAD_ERROR, 'adapter error must be an object');
    }
    for (const key of Object.keys(response.error)) {
      if (!['code', 'retryable', 'message'].includes(key)) {
        return adapterFail(ADAPTER_ERROR_CODES.BAD_ERROR, `unsupported adapter error field: ${key}`);
      }
    }
    if (typeof response.error.code !== 'string' || response.error.code.length === 0) {
      return adapterFail(ADAPTER_ERROR_CODES.BAD_ERROR, 'adapter error.code must be a non-empty string');
    }
    if (typeof response.error.retryable !== 'boolean') {
      return adapterFail(ADAPTER_ERROR_CODES.BAD_ERROR, 'adapter error.retryable must be a boolean');
    }
    if (typeof response.error.message !== 'string' || response.error.message.length === 0) {
      return adapterFail(ADAPTER_ERROR_CODES.BAD_ERROR, 'adapter error.message must be a non-empty string');
    }
  }
  return { ok: true, code: null, message: null };
}

module.exports = {
  EVENT_TYPES,
  DELIVERY_STATUSES,
  EVENT_FIELDS,
  ARTIFACT_ROOTS,
  MAX_EVENT_BYTES,
  VOLATILE_FIELDS,
  buildEventId,
  canonicalizePayload,
  hashCanonicalPayload,
  checkEventSize,
  validateArtifactRef,
  canonicalArtifactRef,
  validateEvent,
  ADAPTER_RESPONSE_STATUSES,
  ADAPTER_RESPONSE_FIELDS,
  ADAPTER_ERROR_CODES,
  validateAdapterResponse,
};
