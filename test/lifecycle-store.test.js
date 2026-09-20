'use strict';

// T2 lifecycle-store integration tests (real temporary filesystem).
// Cycle 1: a valid transition commits state and one event atomically.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
const { canonicalArtifactRef } = require('../cli/lib/lifecycle-contract');

const FIXED_CLOCK = '2026-09-19T12:00:00.000Z';

function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

test('CYCLE 1: a valid transition commits state and one event atomically', () => {
  const specDir = mkdtempSync(path.join(tmpdir(), 'lifecycle-spec-'));
  const content = 'lifecycle spec content\n';
  writeFileSync(path.join(specDir, 'spec-doc.md'), content);
  const sha = sha256Hex(content);
  const ref = { root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha, revision: 1 };

  const res = commitTransition({
    specDir,
    planDir: null,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [ref],
    deps: {
      now: () => FIXED_CLOCK,
      hashFile: () => sha,
    },
  });

  assert.equal(res.ok, true, `commit should succeed: ${JSON.stringify(res)}`);
  assert.equal(res.event.event_id, 'demo-plan:spec-approved:r1');
  assert.equal(res.event.revision, 1);
  assert.equal(res.revision, 1);
  assert.equal(res.event.occurred_at, FIXED_CLOCK);
  assert.deepEqual(res.event.delivery, { status: 'pending', attempts: 0 });
  assert.deepEqual(res.event.artifact_refs, [canonicalArtifactRef(ref)]);

  const raw = readFileSync(lifecyclePathFor(specDir), 'utf8');
  const doc = JSON.parse(raw);
  assert.equal(doc.schema, 1);
  assert.equal(doc.plan.plan_id, 'demo-plan');
  assert.equal(doc.plan.revision, 1);
  assert.equal(doc.plan.state.approval, 'APPROVED');
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].event_id, 'demo-plan:spec-approved:r1');
  assert.equal(doc.events[0].delivery.status, 'pending');

  // lifecycle.json is the single authoritative document: no second journal.
  const files = readdirSync(specDir);
  assert.ok(files.includes('lifecycle.json'));
  assert.ok(!files.includes('log.json'), 'store must not write log.json');
  assert.ok(!files.includes('.pocket-meta.json'), 'store must not write .pocket-meta.json');
});
