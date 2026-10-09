'use strict';

// Investigation-only regressions: keep the confirmed failures RED until fixes are authorized.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateArtifactRef, validateEvent } = require('../cli/lib/lifecycle-contract');
const { commitTransition } = require('../cli/lib/lifecycle-store');

const CONTENT = Buffer.from('Approved specification evidence.\n');
const SHA = createHash('sha256').update(CONTENT).digest('hex');
const CLI = path.resolve(__dirname, '../cli/index.js');

function artifact(overrides = {}) {
  return { root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: SHA, revision: 1, ...overrides };
}

function eventWith(ref) {
  return {
    event_id: 'demo-plan:spec-approved:r1',
    plan_id: 'demo-plan',
    type: 'spec-approved',
    revision: 1,
    occurred_at: '2026-10-09T00:00:00.000Z',
    artifact_refs: [ref],
    payload_hash: SHA,
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 0 },
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-bug-64-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const specDir = path.join(root, 'demo-plan');
  fs.mkdirSync(specDir);
  return specDir;
}

const INVALID_REFS = [
  { name: 'root', overrides: { root: 'remote' }, code: 'LIFECYCLE_BAD_ARTIFACT_ROOT' },
  { name: 'path', overrides: { path: '../outside.md' }, code: 'LIFECYCLE_BAD_ARTIFACT_PATH' },
  { name: 'hash', overrides: { sha256: 'not-a-hash' }, code: 'LIFECYCLE_BAD_ARTIFACT_HASH' },
];

for (const { name, overrides, code } of INVALID_REFS) {
  test(`issue #64: event validation preserves the nested artifact ${name} error`, () => {
    const ref = artifact(overrides);
    assert.equal(validateArtifactRef(ref).code, code);
    const result = validateEvent(eventWith(ref));
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  });
}

for (const { name, overrides, code } of [
  ...INVALID_REFS,
  { name: 'stale digest', overrides: { sha256: '0'.repeat(64) }, code: 'LIFECYCLE_ARTIFACT_STALE' },
]) {
  test(`issue #64 control: CLI transition preserves the artifact ${name} error`, (t) => {
    const specDir = fixture(t);
    fs.writeFileSync(path.join(specDir, 'spec.md'), CONTENT);
    const ref = artifact(overrides);
    const result = spawnSync(process.execPath, [
      CLI, 'lifecycle', 'transition', specDir, 'spec-approved',
      '--artifact', `${ref.root}:${ref.kind}:${ref.path}:${ref.sha256}`,
      '--json', '--contract', '3',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, code);
    assert.equal(fs.existsSync(path.join(specDir, 'lifecycle.json')), false);
  });
}

for (const filename of ['..evidence.md', '..notes/spec.md']) {
  test(`artifact containment accepts the in-root file ${filename}`, (t) => {
    const specDir = fixture(t);
    const target = path.join(specDir, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, CONTENT);
    const ref = artifact({ path: filename });
    assert.equal(validateArtifactRef(ref).ok, true);
    const result = commitTransition({ specDir, planId: 'demo-plan', type: 'spec-approved', artifacts: [ref] });
    assert.equal(result.ok, true, JSON.stringify(result));
    const doc = JSON.parse(fs.readFileSync(path.join(specDir, 'lifecycle.json'), 'utf8'));
    assert.equal(doc.events[0].artifact_refs[0].path, filename);
    assert.equal(doc.events[0].artifact_refs[0].sha256, SHA);
  });
}

test('artifact containment accepts a symlink to an in-root file whose name starts with two dots', (t) => {
  const specDir = fixture(t);
  fs.writeFileSync(path.join(specDir, '..evidence.md'), CONTENT);
  fs.symlinkSync('..evidence.md', path.join(specDir, 'evidence-link.md'));
  const result = commitTransition({
    specDir, planId: 'demo-plan', type: 'spec-approved',
    artifacts: [artifact({ path: 'evidence-link.md' })],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const doc = JSON.parse(fs.readFileSync(path.join(specDir, 'lifecycle.json'), 'utf8'));
  assert.equal(doc.events[0].artifact_refs[0].path, 'evidence-link.md');
});

test('artifact journal preserves the exact filesystem path when CRLF and LF filenames both exist', (t) => {
  const specDir = fixture(t);
  const requestedPath = 'spec\r\nnotes.md';
  fs.writeFileSync(path.join(specDir, requestedPath), CONTENT);
  fs.writeFileSync(path.join(specDir, 'spec\nnotes.md'), CONTENT);
  const result = commitTransition({
    specDir, planId: 'demo-plan', type: 'spec-approved',
    artifacts: [artifact({ path: requestedPath })],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const doc = JSON.parse(fs.readFileSync(path.join(specDir, 'lifecycle.json'), 'utf8'));
  assert.equal(doc.events[0].artifact_refs[0].path, requestedPath);
});
