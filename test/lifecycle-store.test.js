'use strict';

// T2 lifecycle-store integration tests (real temporary filesystem).
// Cycle 1: a valid transition commits state and one event atomically.
// Cycle 2: root-specific artifact validation rejects invalid commit references.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, symlinkSync } = require('node:fs');
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

function makeRoots() {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-roots-'));
  const specDir = path.join(root, 'spec');
  const planDir = path.join(root, 'plan');
  const otherDir = path.join(root, 'other');
  mkdirSync(specDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  const specContent = 'spec content\n';
  writeFileSync(path.join(specDir, 'spec-doc.md'), specContent);
  const planContent = 'plan content\n';
  writeFileSync(path.join(planDir, 'phase-1.md'), planContent);
  const outsideContent = 'outside content\n';
  writeFileSync(path.join(otherDir, 'secret.md'), outsideContent);
  return {
    root,
    specDir,
    planDir,
    otherDir,
    specSha: sha256Hex(specContent),
    planSha: sha256Hex(planContent),
  };
}

function commitOk(roots, overrides = {}) {
  return commitTransition({
    specDir: roots.specDir,
    planDir: roots.planDir,
    planId: 'demo-plan',
    type: 'phase-complete',
    artifacts: [
      { root: 'plan', kind: 'phase-evidence', path: 'phase-1.md', sha256: roots.planSha, revision: 1 },
    ],
    deps: { now: () => FIXED_CLOCK },
    ...overrides,
  });
}

test('CYCLE 2: invalid artifact references are rejected with no mutation', () => {
  const cases = {};
  {
    const r = makeRoots();
    cases['plan-root with null plan_dir'] = {
      roots: r,
      input: {
        specDir: r.specDir, planDir: null, planId: 'demo-plan', type: 'spec-approved',
        artifacts: [{ root: 'plan', kind: 'x', path: 'phase-1.md', sha256: r.planSha, revision: 1 }],
        deps: { now: () => FIXED_CLOCK },
      },
    };
    cases['absolute path'] = {
      roots: r,
      input: {
        specDir: r.specDir, planDir: r.planDir, planId: 'demo-plan', type: 'phase-complete',
        artifacts: [{ root: 'plan', kind: 'x', path: '/etc/passwd', sha256: r.planSha, revision: 1 }],
        deps: { now: () => FIXED_CLOCK },
      },
    };
    cases['escaping path'] = {
      roots: r,
      input: {
        specDir: r.specDir, planDir: r.planDir, planId: 'demo-plan', type: 'phase-complete',
        artifacts: [{ root: 'plan', kind: 'x', path: '../spec/spec-doc.md', sha256: r.specSha, revision: 1 }],
        deps: { now: () => FIXED_CLOCK },
      },
    };
    cases['missing file'] = {
      roots: r,
      input: {
        specDir: r.specDir, planDir: r.planDir, planId: 'demo-plan', type: 'phase-complete',
        artifacts: [{ root: 'plan', kind: 'x', path: 'nope.md', sha256: r.planSha, revision: 1 }],
        deps: { now: () => FIXED_CLOCK },
      },
    };
    cases['cross-plan path'] = {
      roots: r,
      input: {
        specDir: r.specDir, planDir: r.planDir, planId: 'demo-plan', type: 'phase-complete',
        artifacts: [{ root: 'plan', kind: 'x', path: '../other/secret.md', sha256: r.planSha, revision: 1 }],
        deps: { now: () => FIXED_CLOCK },
      },
    };
    cases['hash mismatch'] = {
      roots: r,
      input: {
        specDir: r.specDir, planDir: r.planDir, planId: 'demo-plan', type: 'phase-complete',
        artifacts: [{ root: 'plan', kind: 'x', path: 'phase-1.md', sha256: '0'.repeat(64), revision: 1 }],
        deps: { now: () => FIXED_CLOCK },
      },
    };
    cases['phase-complete without plan_dir'] = {
      roots: r,
      input: {
        specDir: r.specDir, planDir: null, planId: 'demo-plan', type: 'phase-complete',
        artifacts: [{ root: 'spec', kind: 'x', path: 'spec-doc.md', sha256: r.specSha, revision: 1 }],
        deps: { now: () => FIXED_CLOCK },
      },
    };
    cases['plan-closed without plan_dir'] = {
      roots: r,
      input: {
        specDir: r.specDir, planDir: null, planId: 'demo-plan', type: 'plan-closed',
        artifacts: [{ root: 'spec', kind: 'x', path: 'spec-doc.md', sha256: r.specSha, revision: 1 }],
        deps: { now: () => FIXED_CLOCK },
      },
    };
  }
  try {
    symlinkSync(path.join(cases['cross-plan path'].roots.otherDir, 'secret.md'),
      path.join(cases['cross-plan path'].roots.planDir, 'link.md'));
    cases['symlink escape'] = {
      roots: cases['cross-plan path'].roots,
      input: {
        specDir: cases['cross-plan path'].roots.specDir,
        planDir: cases['cross-plan path'].roots.planDir,
        planId: 'demo-plan', type: 'phase-complete',
        artifacts: [{ root: 'plan', kind: 'x', path: 'link.md', sha256: cases['cross-plan path'].roots.planSha, revision: 1 }],
        deps: { now: () => FIXED_CLOCK },
      },
    };
  } catch (_) {
    // Symlinks unsupported on this platform: skip that case.
  }

  for (const [name, c] of Object.entries(cases)) {
    const before = fs.existsSync(lifecyclePathFor(c.input.specDir))
      ? readFileSync(lifecyclePathFor(c.input.specDir), 'utf8')
      : null;
    const res = commitTransition(c.input);
    assert.equal(res.ok, false, `${name} must be rejected: ${JSON.stringify(res)}`);
    assert.ok(typeof res.code === 'string' && res.code.length > 0, `${name} needs a stable code`);
    const after = fs.existsSync(lifecyclePathFor(c.input.specDir))
      ? readFileSync(lifecyclePathFor(c.input.specDir), 'utf8')
      : null;
    assert.equal(after, before, `${name} must leave state byte-identical with no event`);
  }
});

test('CYCLE 2: deterministic I/O error maps to retryable with no mutation', () => {
  const roots = makeRoots();
  const boom = new Error('EIO: i/o error');
  boom.code = 'EIO';
  const res = commitTransition({
    specDir: roots.specDir,
    planDir: roots.planDir,
    planId: 'demo-plan',
    type: 'phase-complete',
    artifacts: [
      { root: 'plan', kind: 'phase-evidence', path: 'phase-1.md', sha256: roots.planSha, revision: 1 },
    ],
    deps: { now: () => FIXED_CLOCK, hashFile: () => { throw boom; } },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LIFECYCLE_ARTIFACT_IO');
  assert.ok(!fs.existsSync(lifecyclePathFor(roots.specDir)), 'no event may be appended');
});

function writeArtifact(dir, name, content) {
  writeFileSync(path.join(dir, name), content);
  return sha256Hex(content);
}

test('CYCLE 3: invalid state transition emits no event and leaves file byte-identical', () => {
  const specDir = mkdtempSync(path.join(tmpdir(), 'lifecycle-state-'));
  const shaA = writeArtifact(specDir, 'spec-a.md', 'spec A\n');
  const first = commitTransition({
    specDir,
    planDir: null,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-a.md', sha256: shaA, revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(first.ok, true, `seed commit should succeed: ${JSON.stringify(first)}`);
  assert.equal(first.event.event_id, 'demo-plan:spec-approved:r1');
  const before = readFileSync(lifecyclePathFor(specDir), 'utf8');

  // Same type but a different canonical payload: not a replay, and the
  // already-APPROVED plan cannot legally accept another spec-approved.
  const shaB = writeArtifact(specDir, 'spec-b.md', 'spec B\n');
  const res = commitTransition({
    specDir,
    planDir: null,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-b.md', sha256: shaB, revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(res.ok, false, `invalid transition must be rejected: ${JSON.stringify(res)}`);
  assert.equal(res.code, 'LIFECYCLE_BAD_STATE');
  assert.equal(readFileSync(lifecyclePathFor(specDir), 'utf8'), before, 'state must remain byte-identical');
  const doc = JSON.parse(before);
  assert.equal(doc.events.length, 1, 'no event may be appended');
  assert.deepEqual(
    doc.events.map((e) => e.delivery),
    [{ status: 'pending', attempts: 0 }],
    'no new delivery entry may become processable',
  );
  const files = readdirSync(specDir);
  assert.ok(!files.includes('log.json'), 'store must not write log.json');
  assert.ok(!files.includes('.pocket-meta.json'), 'store must not write .pocket-meta.json');
});

test('CYCLE 3: closed plan rejects further transitions with no mutation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-closed-'));
  const specDir = path.join(root, 'spec');
  const planDir = path.join(root, 'plan');
  mkdirSync(specDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const specSha = writeArtifact(specDir, 'spec-doc.md', 'spec\n');
  const p1 = writeArtifact(planDir, 'p1.md', 'phase 1\n');
  const p2 = writeArtifact(planDir, 'p2.md', 'phase 2\n');
  const p3 = writeArtifact(planDir, 'p3.md', 'phase 3\n');
  const submit = (type, artifacts, planDirArg) => commitTransition({
    specDir,
    planDir: planDirArg,
    planId: 'demo-plan',
    type,
    artifacts,
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(submit('spec-approved',
    [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: specSha, revision: 1 }], null).ok, true);
  assert.equal(submit('phase-complete',
    [{ root: 'plan', kind: 'phase-evidence', path: 'p1.md', sha256: p1, revision: 1 }], planDir).ok, true);
  assert.equal(submit('plan-closed',
    [{ root: 'plan', kind: 'closeout', path: 'p2.md', sha256: p2, revision: 1 }], planDir).ok, true);
  const before = readFileSync(lifecyclePathFor(specDir), 'utf8');
  assert.equal(JSON.parse(before).plan.state.status, 'DONE');

  const res = submit('phase-complete',
    [{ root: 'plan', kind: 'phase-evidence', path: 'p3.md', sha256: p3, revision: 1 }], planDir);
  assert.equal(res.ok, false, `transition on closed plan must be rejected: ${JSON.stringify(res)}`);
  assert.equal(res.code, 'LIFECYCLE_BAD_STATE');
  assert.equal(readFileSync(lifecyclePathFor(specDir), 'utf8'), before, 'state must remain byte-identical');
  assert.equal(JSON.parse(before).events.length, 3, 'no event may be appended');
});

function tmpOrphans(dir) {
  return readdirSync(dir).filter((f) => f.startsWith('.lifecycle.json.tmp-'));
}

function seedApprovedWithPlanDirs() {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-persist-'));
  const specDir = path.join(root, 'spec');
  const planDir = path.join(root, 'plan');
  mkdirSync(specDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const specSha = writeArtifact(specDir, 'spec-doc.md', 'spec\n');
  const planSha = writeArtifact(planDir, 'phase-1.md', 'phase 1\n');
  const seed = commitTransition({
    specDir,
    planDir: null,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: specSha, revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(seed.ok, true, `seed commit should succeed: ${JSON.stringify(seed)}`);
  return { root, specDir, planDir, planSha };
}

function phaseCompleteInput(fixture, atomic) {
  return {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: 'demo-plan',
    type: 'phase-complete',
    artifacts: [
      { root: 'plan', kind: 'phase-evidence', path: 'phase-1.md', sha256: fixture.planSha, revision: 1 },
    ],
    deps: { now: () => FIXED_CLOCK, atomic },
  };
}

function assertPersistFailureAtomic(fixture, res, before) {
  assert.equal(res.ok, false, `failed commit must be unsuccessful: ${JSON.stringify(res)}`);
  assert.equal(res.code, 'LIFECYCLE_PERSISTENCE');
  assert.equal(
    readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'),
    before,
    'previous lifecycle document must remain byte-identical',
  );
  const doc = JSON.parse(before);
  assert.equal(doc.plan.revision, 1, 'no new state may become visible');
  assert.equal(doc.events.length, 1, 'no event may become visible');
  assert.deepEqual(tmpOrphans(fixture.specDir), [], 'no orphaned temporary file may remain');
  const files = readdirSync(fixture.specDir);
  assert.ok(!files.includes('log.json'), 'store must not write log.json');
  assert.ok(!files.includes('.pocket-meta.json'), 'store must not write .pocket-meta.json');
}

test('CYCLE 4: temp-write failure leaves previous document byte-identical with no orphan temp', () => {
  const fixture = seedApprovedWithPlanDirs();
  const before = readFileSync(lifecyclePathFor(fixture.specDir), 'utf8');
  const boom = new Error('ENOSPC: no space left on device');
  boom.code = 'ENOSPC';
  const res = commitTransition(
    phaseCompleteInput(fixture, { writeFile: () => { throw boom; } }),
  );
  assertPersistFailureAtomic(fixture, res, before);
});

test('CYCLE 4: rename failure leaves previous document byte-identical with no orphan temp', () => {
  const fixture = seedApprovedWithPlanDirs();
  const before = readFileSync(lifecyclePathFor(fixture.specDir), 'utf8');
  const boom = new Error('EXDEV: cross-device link not permitted');
  boom.code = 'EXDEV';
  const res = commitTransition(
    phaseCompleteInput(fixture, { rename: () => { throw boom; } }),
  );
  assertPersistFailureAtomic(fixture, res, before);
});

test('CYCLE 5: identical replay returns original event without appending', () => {
  const specDir = mkdtempSync(path.join(tmpdir(), 'lifecycle-replay-'));
  const sha = writeArtifact(specDir, 'spec-doc.md', 'spec content\n');
  const input = {
    specDir,
    planDir: null,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha, revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  };
  const first = commitTransition(input);
  assert.equal(first.ok, true, `first commit should succeed: ${JSON.stringify(first)}`);
  assert.equal(first.event.event_id, 'demo-plan:spec-approved:r1');
  assert.equal(first.revision, 1);
  const before = readFileSync(lifecyclePathFor(specDir), 'utf8');

  // Same logical transition again — even under a later clock — must be a
  // no-op replay: canonical payload identity ignores volatile timestamps.
  const replay = commitTransition({
    ...input,
    deps: { now: () => '2026-09-20T00:00:00.000Z' },
  });
  assert.equal(replay.ok, true, `replay should succeed as no-op: ${JSON.stringify(replay)}`);
  assert.equal(replay.event.event_id, first.event.event_id, 'replay must return original event ID');
  assert.equal(replay.revision, first.revision, 'replay must return original revision');
  assert.equal(replay.event.payload_hash, first.event.payload_hash);
  assert.equal(
    readFileSync(lifecyclePathFor(specDir), 'utf8'),
    before,
    'replay must not rewrite the authoritative document',
  );
  const doc = JSON.parse(before);
  assert.equal(doc.events.length, 1, 'no second event may be appended');
  assert.equal(doc.plan.revision, 1, 'revision must not advance on replay');
});
