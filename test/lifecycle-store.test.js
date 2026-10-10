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

test('CYCLE 6: same event ID with different canonical payload is a terminal integrity conflict', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-conflict-'));
  const specDir = path.join(root, 'spec');
  const planDir = path.join(root, 'plan');
  mkdirSync(specDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const specSha = writeArtifact(specDir, 'spec-doc.md', 'spec\n');
  const shaA = writeArtifact(planDir, 'phase-a.md', 'phase A\n');
  const shaB = writeArtifact(planDir, 'phase-b.md', 'phase B\n');

  const seed = commitTransition({
    specDir,
    planDir: null,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: specSha, revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(seed.ok, true, `seed commit should succeed: ${JSON.stringify(seed)}`);

  const phase = (file, sha) => commitTransition({
    specDir,
    planDir,
    planId: 'demo-plan',
    type: 'phase-complete',
    artifacts: [{ root: 'plan', kind: 'phase-evidence', path: file, sha256: sha, revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  const first = phase('phase-a.md', shaA);
  assert.equal(first.ok, true, `first phase commit should succeed: ${JSON.stringify(first)}`);
  assert.equal(first.event.event_id, 'demo-plan:phase-complete:r2');

  // A divergent writer rewinds the plan revision, so the next commit claims
  // the same deterministic event ID with a different canonical payload.
  const rewoundDoc = JSON.parse(readFileSync(lifecyclePathFor(specDir), 'utf8'));
  rewoundDoc.plan.revision = 1;
  writeFileSync(lifecyclePathFor(specDir), `${JSON.stringify(rewoundDoc, null, 2)}\n`);
  const before = readFileSync(lifecyclePathFor(specDir), 'utf8');
  const beforeDoc = JSON.parse(before);
  assert.equal(beforeDoc.events.length, 2);

  const res = phase('phase-b.md', shaB);
  assert.equal(res.ok, false, `conflicting payload must be rejected: ${JSON.stringify(res)}`);
  assert.equal(res.code, 'LIFECYCLE_INTEGRITY_CONFLICT');
  const after = readFileSync(lifecyclePathFor(specDir), 'utf8');
  assert.equal(after, before, 'conflict must leave the authoritative document byte-identical');
  const afterDoc = JSON.parse(after);
  assert.equal(afterDoc.events.length, 2, 'no event may be appended');
  assert.equal(afterDoc.plan.revision, 1, 'revision must not advance on conflict');
  assert.deepEqual(
    afterDoc.events.map((e) => e.delivery),
    beforeDoc.events.map((e) => e.delivery),
    'no delivery entry may be mutated',
  );
  assert.deepEqual(
    afterDoc.events.map((e) => e.payload_hash),
    beforeDoc.events.map((e) => e.payload_hash),
    'no journal payload may be mutated',
  );
  assert.deepEqual(tmpOrphans(specDir), [], 'no orphaned temporary file may remain');
  const files = readdirSync(specDir);
  assert.ok(!files.includes('log.json'), 'store must not write log.json');
  assert.ok(!files.includes('.pocket-meta.json'), 'store must not write .pocket-meta.json');

  // Identical replay of the original payload still resolves to the original
  // event without mutation.
  const replay = phase('phase-a.md', shaA);
  assert.equal(replay.ok, true, `identical replay should succeed: ${JSON.stringify(replay)}`);
  assert.equal(replay.event.event_id, first.event.event_id, 'replay must return original event ID');
  assert.equal(replay.revision, first.revision, 'replay must return original revision');
  assert.equal(
    readFileSync(lifecyclePathFor(specDir), 'utf8'),
    before,
    'replay must not rewrite the authoritative document',
  );
});

// T2 schema 2: phase-closed, per-phase replay/legality, planPatch, schema guard.
function seedPhaseOneComplete() {
  const fixture = seedApprovedWithPlanDirs();
  const complete = commitTransition(phaseCompleteInput(fixture));
  assert.equal(complete.ok, true, `phase-1 completion should succeed: ${JSON.stringify(complete)}`);
  return fixture;
}

function phaseClosedInput(fixture, phaseKey, extra = {}) {
  return {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: 'demo-plan',
    type: 'phase-closed',
    phaseKey,
    artifacts: [
      { root: 'plan', kind: 'phase-evidence', path: 'phase-1.md', sha256: fixture.planSha, revision: 1 },
    ],
    deps: { now: () => FIXED_CLOCK },
    ...extra,
  };
}

test('phase-closed commit: appends one event and adds no phase_status key', () => {
  const fixture = seedPhaseOneComplete();
  const before = JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'));

  const res = commitTransition(phaseClosedInput(fixture, 'phase-1'));
  assert.equal(res.ok, true, `phase-closed should commit: ${JSON.stringify(res)}`);
  assert.equal(res.event.type, 'phase-closed');
  assert.equal(res.event.event_id, 'demo-plan:phase-closed:r3');

  const doc = JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'));
  assert.equal(doc.events.length, before.events.length + 1, 'exactly one event must be appended');
  assert.deepEqual(
    doc.plan.state.phase_status,
    before.plan.state.phase_status,
    'phase_status keys must be unchanged by phase-closed',
  );
  assert.deepEqual(Object.keys(doc.plan.state.phase_status), ['phase-1']);
});

test('phase-closed replay: identical call replays and each phaseKey gets its own event', () => {
  const fixture = seedPhaseOneComplete();
  const first = commitTransition(phaseClosedInput(fixture, 'phase-1'));
  assert.equal(first.ok, true, `phase-1 phase-closed should commit: ${JSON.stringify(first)}`);
  const beforeReplay = readFileSync(lifecyclePathFor(fixture.specDir), 'utf8');

  const replay = commitTransition(phaseClosedInput(fixture, 'phase-1'));
  assert.equal(replay.ok, true, `identical phase-closed should replay: ${JSON.stringify(replay)}`);
  assert.equal(replay.event.event_id, first.event.event_id, 'replay must return the original event ID');
  assert.equal(replay.revision, first.revision, 'replay must return the original revision');
  assert.equal(
    readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'),
    beforeReplay,
    'replay must not append or rewrite the document',
  );

  const phase2Artifact = writeArtifact(fixture.planDir, 'phase-2.md', 'phase 2\n');
  const complete2 = commitTransition({
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: 'demo-plan',
    type: 'phase-complete',
    artifacts: [
      { root: 'plan', kind: 'phase-evidence', path: 'phase-2.md', sha256: phase2Artifact, revision: 1 },
    ],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(complete2.ok, true, `phase-2 completion should succeed: ${JSON.stringify(complete2)}`);

  const second = commitTransition(phaseClosedInput(fixture, 'phase-2'));
  assert.equal(second.ok, true, `phase-2 phase-closed should commit: ${JSON.stringify(second)}`);
  assert.notEqual(second.event.event_id, first.event.event_id, 'phase-2 must not replay phase-1 event');
  assert.notEqual(second.event.payload_hash, first.event.payload_hash, 'phaseKey must be part of the payload');
  const doc = JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'));
  assert.equal(doc.events.filter((e) => e.type === 'phase-closed').length, 2, 'one phase-closed per phaseKey');
});

test('phase-closed legality: non-COMPLETE phase, closed plan, and a second close are rejected with no mutation', () => {
  // (a) phase-2 has no phase-complete yet.
  {
    const fixture = seedPhaseOneComplete();
    const before = readFileSync(lifecyclePathFor(fixture.specDir), 'utf8');
    const res = commitTransition(phaseClosedInput(fixture, 'phase-2'));
    assert.equal(res.ok, false, `phase-2 is not COMPLETE: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'LIFECYCLE_BAD_STATE');
    assert.equal(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'), before, 'doc must be byte-identical');
  }

  // (b) plan already closed: phase-closed is never legal after plan-closed.
  {
    const fixture = seedPhaseOneComplete();
    const closed = commitTransition({
      specDir: fixture.specDir,
      planDir: fixture.planDir,
      planId: 'demo-plan',
      type: 'plan-closed',
      artifacts: [
        { root: 'plan', kind: 'phase-evidence', path: 'phase-1.md', sha256: fixture.planSha, revision: 1 },
      ],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(closed.ok, true, `plan-closed should commit: ${JSON.stringify(closed)}`);
    const before = readFileSync(lifecyclePathFor(fixture.specDir), 'utf8');
    const res = commitTransition(phaseClosedInput(fixture, 'phase-1'));
    assert.equal(res.ok, false, `closed plan must reject phase-closed: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'LIFECYCLE_BAD_STATE');
    assert.equal(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'), before, 'doc must be byte-identical');
  }

  // (c) at most once per phaseKey, even with different artifact refs.
  {
    const fixture = seedPhaseOneComplete();
    const first = commitTransition(phaseClosedInput(fixture, 'phase-1'));
    assert.equal(first.ok, true, `first phase-1 close should commit: ${JSON.stringify(first)}`);
    const otherSha = writeArtifact(fixture.planDir, 'phase-1-amended.md', 'amended phase 1\n');
    const before = readFileSync(lifecyclePathFor(fixture.specDir), 'utf8');
    const res = commitTransition(phaseClosedInput(fixture, 'phase-1', {
      artifacts: [
        { root: 'plan', kind: 'phase-evidence', path: 'phase-1-amended.md', sha256: otherSha, revision: 1 },
      ],
    }));
    assert.equal(res.ok, false, `second phase-1 close must be rejected: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'LIFECYCLE_BAD_STATE');
    assert.equal(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'), before, 'doc must be byte-identical');
  }
});

test('planPatch merge: phase-complete with planPatch writes plan.phases and bumps schema to 2', () => {
  const fixture = seedApprovedWithPlanDirs();
  const seeded = JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'));
  assert.equal(seeded.schema, 1, 'seed document must be schema 1');

  const res = commitTransition({
    ...phaseCompleteInput(fixture),
    planPatch: {
      phase_branches: { mode: 'stacked', root_base: 'feature/x' },
      phases: { 'phase-1': { branch: 'pocket/p/phase-1', base_branch: 'feature/x' } },
    },
  });
  assert.equal(res.ok, true, `phase-complete with planPatch should commit: ${JSON.stringify(res)}`);

  const doc = JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'));
  assert.equal(doc.schema, 2, 'an applied planPatch must bump the schema to 2');
  assert.deepEqual(doc.plan.phase_branches, { mode: 'stacked', root_base: 'feature/x' });
  assert.deepEqual(doc.plan.phases, {
    'phase-1': { branch: 'pocket/p/phase-1', base_branch: 'feature/x' },
  });
  assert.equal(doc.plan.plan_id, 'demo-plan', 'unrelated plan fields must survive the merge');
  assert.equal(doc.plan.spec_dir, seeded.plan.spec_dir);
  assert.equal(doc.plan.plan_dir, seeded.plan.plan_dir);
  assert.equal(doc.plan.revision, 2);
  assert.equal(doc.plan.state.approval, 'APPROVED');
  assert.deepEqual(doc.plan.state.phase_status, { 'phase-1': 'COMPLETE' });
});

test('unpatched schema 1: commit without planPatch writes the schema-1 bytes with no phases key', () => {
  const specDir = mkdtempSync(path.join(tmpdir(), 'lifecycle-guard-'));
  const content = 'spec content\n';
  writeFileSync(path.join(specDir, 'spec-doc.md'), content);
  const sha = sha256Hex(content);

  const res = commitTransition({
    specDir,
    planDir: null,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha, revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(res.ok, true, `unpatched commit should succeed: ${JSON.stringify(res)}`);

  // Literal canonical 5-key payload (no phase_key, no planPatch-derived fields),
  // hashed independently of the store so the guard cannot follow the code under test.
  const literalPayload = `{"artifact_refs":[{"kind":"spec-doc","path":"spec-doc.md","revision":1,"root":"spec","sha256":"${sha}"}],"plan_id":"demo-plan","proof_hash":null,"proof_ref":null,"type":"spec-approved"}`;
  const literalPayloadHash = createHash('sha256').update(literalPayload).digest('hex');
  const expected = {
    schema: 1,
    plan: {
      plan_id: 'demo-plan',
      spec_dir: specDir,
      plan_dir: null,
      branch: null,
      state: { approval: 'APPROVED', phase_status: {}, status: 'IN_PROGRESS' },
      revision: 1,
    },
    events: [{
      event_id: 'demo-plan:spec-approved:r1',
      plan_id: 'demo-plan',
      type: 'spec-approved',
      revision: 1,
      occurred_at: FIXED_CLOCK,
      artifact_refs: [{ root: 'spec', kind: 'spec-doc', path: 'spec-doc.md', sha256: sha, revision: 1 }],
      payload_hash: literalPayloadHash,
      proof_ref: null,
      proof_hash: null,
      delivery: { status: 'pending', attempts: 0 },
    }],
  };
  assert.equal(
    readFileSync(lifecyclePathFor(specDir), 'utf8'),
    `${JSON.stringify(expected, null, 2)}\n`,
    'unpatched document must be byte-identical to the schema-1 literal',
  );
});

test('schema 3 rejected: future schema fails closed with LIFECYCLE_SCHEMA_UNSUPPORTED and no mutation', () => {
  const fixture = seedPhaseOneComplete();
  const doc = JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'));
  doc.schema = 3;
  writeFileSync(lifecyclePathFor(fixture.specDir), `${JSON.stringify(doc, null, 2)}\n`);
  const before = readFileSync(lifecyclePathFor(fixture.specDir), 'utf8');

  const attempts = [
    ['phase-closed', phaseClosedInput(fixture, 'phase-1')],
    // Identical to the committed phase-1 completion: must still fail closed, not replay.
    ['phase-complete replay', phaseCompleteInput(fixture)],
    ['planPatch commit', { ...phaseCompleteInput(fixture), planPatch: { phases: { 'phase-2': { branch: 'b', base_branch: 'a' } } } }],
  ];
  for (const [label, input] of attempts) {
    const res = commitTransition(input);
    assert.equal(res.ok, false, `${label} must be rejected for schema 3: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'LIFECYCLE_SCHEMA_UNSUPPORTED', `${label} needs the stable schema code`);
    assert.equal(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'), before, `${label} must leave the doc byte-identical`);
  }
});

test('phase-closed requires phaseKey: a missing phaseKey fails with LIFECYCLE_PHASE_KEY_REQUIRED and no mutation', () => {
  const fixture = seedPhaseOneComplete();
  const before = readFileSync(lifecyclePathFor(fixture.specDir), 'utf8');
  for (const phaseKey of [undefined, '']) {
    const res = commitTransition(phaseClosedInput(fixture, phaseKey));
    assert.equal(res.ok, false, `phaseKey ${JSON.stringify(phaseKey)} must be rejected: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'LIFECYCLE_PHASE_KEY_REQUIRED', 'missing phaseKey needs the stable code');
    assert.equal(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'), before, 'doc must be byte-identical');
  }
});

test('planPatch rejects malformed input with LIFECYCLE_BAD_PLAN_PATCH and no mutation', () => {
  const fixture = seedApprovedWithPlanDirs();
  const before = readFileSync(lifecyclePathFor(fixture.specDir), 'utf8');
  const malformed = [
    ['a string', 'nope'],
    ['an array', []],
    ['an empty object', {}],
    ['an unknown top-level field', { unknown: {} }],
    ['phase_branches as a string', { phase_branches: 'x' }],
    ['phases as a string', { phases: 'x' }],
    ['a non-phase-N key', { phases: { 'phase-x': { branch: 'b', base_branch: 'a' } } }],
    ['a non-object phase entry', { phases: { 'phase-1': 'x' } }],
    ['a phase entry missing branch', { phases: { 'phase-1': { base_branch: 'a' } } }],
    ['a phase entry missing base_branch', { phases: { 'phase-1': { branch: 'b' } } }],
    ['an empty branch', { phases: { 'phase-1': { branch: '', base_branch: 'a' } } }],
    ['a non-string branch', { phases: { 'phase-1': { branch: 5, base_branch: 'a' } } }],
    ['an unknown phase entry field', { phases: { 'phase-1': { branch: 'b', base_branch: 'a', extra: 1 } } }],
  ];
  assert.ok(malformed.length >= 11, 'must cover at least 11 invalid patches');
  for (const [label, patch] of malformed) {
    const res = commitTransition({ ...phaseCompleteInput(fixture), planPatch: patch });
    assert.equal(res.ok, false, `${label} must be rejected: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'LIFECYCLE_BAD_PLAN_PATCH', `${label} needs the stable code`);
    assert.equal(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'), before, `${label} must leave the doc byte-identical`);
  }
});

test('planPatch merges into existing phase entry without dropping branch', () => {
  const fixture = seedApprovedWithPlanDirs();
  const first = commitTransition({
    ...phaseCompleteInput(fixture),
    planPatch: { phases: { 'phase-1': { branch: 'pocket/p/phase-1', base_branch: 'feature/x' } } },
  });
  assert.equal(first.ok, true, `first patch should commit: ${JSON.stringify(first)}`);

  const second = commitTransition({
    ...phaseClosedInput(fixture, 'phase-1'),
    planPatch: { phases: { 'phase-1': { branch: 'pocket/p/phase-1', base_branch: 'main' } } },
  });
  assert.equal(second.ok, true, `second patch should commit: ${JSON.stringify(second)}`);

  const doc = JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8'));
  assert.deepEqual(doc.plan.phases, {
    'phase-1': { branch: 'pocket/p/phase-1', base_branch: 'main' },
  }, 'the patched phase must keep branch and take the new base_branch');
  assert.equal(doc.schema, 2);
});

test('planPatch never downgrades schema', () => {
  const fixture = seedApprovedWithPlanDirs();
  const patched = commitTransition({
    ...phaseCompleteInput(fixture),
    planPatch: { phases: { 'phase-1': { branch: 'pocket/p/phase-1', base_branch: 'feature/x' } } },
  });
  assert.equal(patched.ok, true, `first patch should commit: ${JSON.stringify(patched)}`);
  assert.equal(JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8')).schema, 2);

  const again = commitTransition({
    ...phaseClosedInput(fixture, 'phase-1'),
    planPatch: { phases: { 'phase-1': { branch: 'pocket/p/phase-1', base_branch: 'main' } } },
  });
  assert.equal(again.ok, true, `second patch should commit: ${JSON.stringify(again)}`);
  assert.equal(JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8')).schema, 2, 'a patch on a schema-2 doc stays 2');

  const unpatched = commitTransition({
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    planId: 'demo-plan',
    type: 'plan-closed',
    artifacts: [{ root: 'plan', kind: 'phase-evidence', path: 'phase-1.md', sha256: fixture.planSha, revision: 1 }],
    deps: { now: () => FIXED_CLOCK },
  });
  assert.equal(unpatched.ok, true, `unpatched plan-closed should commit: ${JSON.stringify(unpatched)}`);
  assert.equal(JSON.parse(readFileSync(lifecyclePathFor(fixture.specDir), 'utf8')).schema, 2, 'schema 2 must not be downgraded by an unpatched commit');
});

test('planPatch null is a no-op: schema stays 1 and bytes match the unpatched commit', () => {
  const absent = seedApprovedWithPlanDirs();
  const nulled = seedApprovedWithPlanDirs();
  assert.equal(commitTransition(phaseCompleteInput(absent)).ok, true);
  assert.equal(commitTransition({ ...phaseCompleteInput(nulled), planPatch: null }).ok, true);

  const normalize = (f) => readFileSync(lifecyclePathFor(f.specDir), 'utf8')
    .replaceAll(f.specDir, '<SPEC_DIR>')
    .replaceAll(f.planDir, '<PLAN_DIR>');
  const doc = JSON.parse(readFileSync(lifecyclePathFor(nulled.specDir), 'utf8'));
  assert.equal(doc.schema, 1, 'a null planPatch must not bump the schema');
  assert.equal('phases' in doc.plan, false, 'a null planPatch must not add plan.phases');
  assert.equal('phase_branches' in doc.plan, false, 'a null planPatch must not add plan.phase_branches');
  assert.equal(normalize(nulled), normalize(absent), 'null planPatch bytes must equal the absent planPatch bytes');
});
