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

// Baseline content hash. Cycle 3 hardens this with stable-key ordering,
// LF normalization, and delivery-field exclusion.
function hashPayload(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateArtifactRefShallow(ref) {
  if (!isPlainObject(ref)) return false;
  for (const key of ARTIFACT_FIELDS) {
    if (!(key in ref)) return false;
  }
  if (!ARTIFACT_ROOTS.includes(ref.root)) return false;
  if (typeof ref.kind !== 'string' || ref.kind.length === 0) return false;
  if (typeof ref.path !== 'string' || ref.path.length === 0) return false;
  if (typeof ref.sha256 !== 'string' || ref.sha256.length === 0) return false;
  if (!Number.isInteger(ref.revision) || ref.revision < 0) return false;
  return true;
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
    if (!validateArtifactRefShallow(ref)) {
      return fail('LIFECYCLE_BAD_ARTIFACT', 'artifact ref must match { root, kind, path, sha256, revision }');
    }
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

module.exports = {
  EVENT_TYPES,
  DELIVERY_STATUSES,
  EVENT_FIELDS,
  ARTIFACT_ROOTS,
  MAX_EVENT_BYTES,
  buildEventId,
  hashPayload,
  validateEvent,
};
