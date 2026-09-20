'use strict';

// T1 CYCLE 1: lifecycle protocol constants are independently versioned.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const version = require('../cli/lib/version');

test('v4 protocol constants are independently versioned', () => {
  assert.equal(version.CONTRACT, 3, 'CONTRACT must be 3');
  assert.equal(version.PIPELINE, 5, 'PIPELINE must be 5');
  assert.equal(version.LIFECYCLE_SCHEMA, 1, 'LIFECYCLE_SCHEMA must be 1');
  assert.equal(version.ADAPTER_CONTRACT, 1, 'ADAPTER_CONTRACT must be 1');
  assert.equal(version.SURFACE_MANIFEST, 1, 'SURFACE_MANIFEST must be 1');
});

// T1 CYCLE 2: lifecycle events accept only the neutral schema.
const {
  EVENT_TYPES,
  DELIVERY_STATUSES,
  validateEvent,
  buildEventId,
} = require('../cli/lib/lifecycle-contract');

const FIXED_CLOCK = '2026-09-19T12:00:00.000Z';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const PAYLOAD_SHA256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

function makeValidEvent(overrides = {}) {
  const planId = 'demo-plan';
  const type = 'spec-approved';
  const revision = 1;
  return {
    event_id: `${planId}:${type}:r${revision}`,
    plan_id: planId,
    type,
    revision,
    occurred_at: FIXED_CLOCK,
    artifact_refs: [
      {
        root: 'spec',
        kind: 'spec-doc',
        path: 'core-enterprise-agent-surfaces.md',
        sha256: EMPTY_SHA256,
        revision: 1,
      },
    ],
    payload_hash: PAYLOAD_SHA256,
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 0 },
    ...overrides,
  };
}

test('accepts an allowlisted event with deterministic ID, revision, artifacts, opaque proof, delivery', () => {
  for (const type of EVENT_TYPES) {
    const planId = 'demo-plan';
    const revision = 2;
    const ev = makeValidEvent({
      type,
      revision,
      event_id: `${planId}:${type}:r${revision}`,
      occurred_at: FIXED_CLOCK,
    });
    const res = validateEvent(ev);
    assert.equal(res.ok, true, `type ${type} should validate: ${JSON.stringify(res)}`);
  }
  const res = validateEvent(makeValidEvent());
  assert.equal(res.ok, true);
  assert.equal(buildEventId('demo-plan', 'spec-approved', 1), 'demo-plan:spec-approved:r1');
});

test('rejects unsupported type with stable code', () => {
  const ev = makeValidEvent({ type: 'plan-published', event_id: 'demo-plan:plan-published:r1' });
  const res = validateEvent(ev);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LIFECYCLE_UNKNOWN_TYPE');
});

test('rejects unknown top-level fields with stable code', () => {
  const ev = makeValidEvent({ extra_field: 'nope' });
  const res = validateEvent(ev);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LIFECYCLE_UNKNOWN_FIELD');
});

test('rejects remote-identity top-level field with stable code', () => {
  const ev = makeValidEvent({ github_issue_number: 50 });
  const res = validateEvent(ev);
  assert.equal(res.ok, false);
  assert.ok(typeof res.code === 'string' && res.code.length > 0);
  assert.equal(res.code, 'LIFECYCLE_UNKNOWN_FIELD');
});

test('rejects secret top-level field with stable code', () => {
  const ev = makeValidEvent({ token: 'placeholder-secret-value' });
  const res = validateEvent(ev);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LIFECYCLE_UNKNOWN_FIELD');
});

test('rejects external-command top-level field with stable code', () => {
  const ev = makeValidEvent({ argv: ['remote', 'sync'] });
  const res = validateEvent(ev);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LIFECYCLE_UNKNOWN_FIELD');
});

test('rejects non-deterministic event ID with stable code', () => {
  const ev = makeValidEvent({ event_id: 'demo-plan:spec-approved:r999' });
  const res = validateEvent(ev);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LIFECYCLE_BAD_EVENT_ID');
});

test('delivery statuses are the neutral allowlist', () => {
  assert.deepEqual([...DELIVERY_STATUSES].sort(), ['claimed', 'pending', 'reconciling', 'retryable', 'succeeded', 'terminal']);
});

// T1 CYCLE 3: canonical payload hashing is stable and bounded.
const {
  canonicalizePayload,
  hashCanonicalPayload,
  checkEventSize,
  MAX_EVENT_BYTES,
} = require('../cli/lib/lifecycle-contract');

test('equivalent payloads with reordered keys share the same hash', () => {
  const a = { beta: 2, alpha: 1, nested: { z: 1, a: 2 } };
  const b = { alpha: 1, nested: { a: 2, z: 1 }, beta: 2 };
  assert.equal(hashCanonicalPayload(a), hashCanonicalPayload(b));
  assert.match(hashCanonicalPayload(a), /^[0-9a-f]{64}$/);
});

test('CRLF and LF text produce the same canonical hash', () => {
  const lf = { body: 'First line\nSecond line\n', title: 'demo' };
  const crlf = { body: 'First line\r\nSecond line\r\n', title: 'demo' };
  assert.equal(hashCanonicalPayload(lf), hashCanonicalPayload(crlf));
  assert.equal(canonicalizePayload({ body: 'a\r\nb' }).body, 'a\nb');
});

test('volatile delivery fields do not affect the canonical hash', () => {
  const base = makeValidEvent();
  const claimed = makeValidEvent({
    delivery: { status: 'claimed', attempts: 3 },
    occurred_at: '2026-09-19T13:00:00.000Z',
  });
  assert.equal(hashCanonicalPayload(base), hashCanonicalPayload(claimed));
});

test('semantic content changes affect the canonical hash', () => {
  const base = makeValidEvent();
  const changed = makeValidEvent({ proof_ref: 'meta:github_issue' });
  assert.notEqual(hashCanonicalPayload(base), hashCanonicalPayload(changed));
});

test('exactly-at and over 64 KiB serialized events produce the boundary result', () => {
  assert.equal(MAX_EVENT_BYTES, 64 * 1024);
  const base = makeValidEvent();
  // proof_ref is ASCII so 1 char = 1 byte; serialized size grows linearly
  // with its length: size(null) has 4 chars `null`, size(str n) has n + 2.
  const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
  assert.ok(baseBytes < MAX_EVENT_BYTES, 'fixture must start under the bound');
  const nExact = MAX_EVENT_BYTES - baseBytes + 2 - 4 + 4 - 2; // == MAX - baseBytes + 2
  const atLimit = { ...base, proof_ref: 'x'.repeat(MAX_EVENT_BYTES - baseBytes + 2) };
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit), 'utf8'), MAX_EVENT_BYTES);
  assert.equal(checkEventSize(atLimit).ok, true);
  const over = { ...base, proof_ref: 'x'.repeat(MAX_EVENT_BYTES - baseBytes + 3) };
  assert.equal(Buffer.byteLength(JSON.stringify(over), 'utf8'), MAX_EVENT_BYTES + 1);
  assert.equal(checkEventSize(over).ok, false);
  assert.equal(checkEventSize(over).code, 'LIFECYCLE_EVENT_TOO_LARGE');
  void nExact;
});

// T1 CYCLE 4: artifact references are root-relative and hash-bounded.
const {
  validateArtifactRef,
  canonicalArtifactRef,
} = require('../cli/lib/lifecycle-contract');

const GOOD_SHA = EMPTY_SHA256;

function makeRef(overrides = {}) {
  return {
    root: 'spec',
    kind: 'spec-doc',
    path: 'core-enterprise-agent-surfaces.md',
    sha256: GOOD_SHA,
    revision: 1,
    ...overrides,
  };
}

test('accepts allowlisted spec and plan root shapes', () => {
  assert.equal(validateArtifactRef(makeRef()).ok, true);
  assert.equal(validateArtifactRef(makeRef({ root: 'plan', path: 'execution-plan/phase-1.md' })).ok, true);
  const canon = canonicalArtifactRef(makeRef({ path: 'b.md' }));
  assert.equal(canon.path, 'b.md');
  assert.equal(canon.sha256, GOOD_SHA);
});

test('rejects absolute artifact paths', () => {
  const res = validateArtifactRef(makeRef({ path: '/etc/passwd' }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LIFECYCLE_BAD_ARTIFACT_PATH');
});

test('rejects escaping artifact paths', () => {
  for (const bad of ['../outside.md', 'a/../../outside.md', 'a/./../..', '..']) {
    const res = validateArtifactRef(makeRef({ path: bad }));
    assert.equal(res.ok, false, `path ${bad} should be rejected`);
    assert.equal(res.code, 'LIFECYCLE_BAD_ARTIFACT_PATH');
  }
});

test('rejects wrong artifact root', () => {
  const res = validateArtifactRef(makeRef({ root: 'remote' }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LIFECYCLE_BAD_ARTIFACT_ROOT');
});

test('rejects malformed artifact fields', () => {
  const malformed = validateArtifactRef({ root: 'spec', kind: 'x' });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'LIFECYCLE_BAD_ARTIFACT');
  const emptyKind = validateArtifactRef(makeRef({ kind: '' }));
  assert.equal(emptyKind.ok, false);
  assert.equal(emptyKind.code, 'LIFECYCLE_BAD_ARTIFACT');
});

test('rejects mismatched artifact hash fields', () => {
  const res = validateArtifactRef(makeRef({ sha256: 'not-a-hash' }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LIFECYCLE_BAD_ARTIFACT_HASH');
});

// T1 CYCLE 5: adapter responses remain opaque and version-bounded.
const {
  ADAPTER_RESPONSE_STATUSES,
  ADAPTER_ERROR_CODES,
  validateAdapterResponse,
} = require('../cli/lib/lifecycle-contract');

const KNOWN_EVENT_ID = 'demo-plan:spec-approved:r1';

function makeResponse(overrides = {}) {
  return {
    event_id: KNOWN_EVENT_ID,
    status: 'succeeded',
    ...overrides,
  };
}

test('accepts a supported opaque outcome with matching event ID', () => {
  for (const status of ADAPTER_RESPONSE_STATUSES) {
    const res = validateAdapterResponse(makeResponse({ status }), KNOWN_EVENT_ID);
    assert.equal(res.ok, true, `status ${status} should validate: ${JSON.stringify(res)}`);
  }
  const withProof = validateAdapterResponse(
    makeResponse({ proof_ref: 'meta:github_issue', proof_hash: PAYLOAD_SHA256 }),
    KNOWN_EVENT_ID,
  );
  assert.equal(withProof.ok, true);
});

test('accepts opaque response without remote-identity fields', () => {
  const res = validateAdapterResponse(makeResponse(), KNOWN_EVENT_ID);
  assert.equal(res.ok, true);
  assert.ok(!('github_issue_number' in makeResponse()));
});

test('rejects malformed adapter status with stable code', () => {
  const res = validateAdapterResponse(makeResponse({ status: 'done' }), KNOWN_EVENT_ID);
  assert.equal(res.ok, false);
  assert.equal(res.code, ADAPTER_ERROR_CODES.BAD_STATUS);
});

test('rejects missing event ID with stable code', () => {
  const { event_id: _dropped, ...noId } = makeResponse();
  void _dropped;
  const res = validateAdapterResponse(noId, KNOWN_EVENT_ID);
  assert.equal(res.ok, false);
  assert.equal(res.code, ADAPTER_ERROR_CODES.BAD_EVENT_ID);
});

test('rejects secret-bearing response with stable code', () => {
  const res = validateAdapterResponse(
    makeResponse({ token: 'placeholder-secret-value' }),
    KNOWN_EVENT_ID,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, ADAPTER_ERROR_CODES.UNKNOWN_FIELD);
});

test('rejects remote-identifier response with stable code', () => {
  const res = validateAdapterResponse(
    makeResponse({ github_issue_number: 50 }),
    KNOWN_EVENT_ID,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, ADAPTER_ERROR_CODES.UNKNOWN_FIELD);
});

test('rejects unknown response field with stable code', () => {
  const res = validateAdapterResponse(makeResponse({ frobnicate: true }), KNOWN_EVENT_ID);
  assert.equal(res.ok, false);
  assert.equal(res.code, ADAPTER_ERROR_CODES.UNKNOWN_FIELD);
});
