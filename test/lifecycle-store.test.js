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
