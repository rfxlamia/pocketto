'use strict';

// Investigation regressions for issue #64 and adjacent structure defects.
// These tests intentionally remain RED until the confirmed causes are fixed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'pocketto-bug64-structure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePlan(root, packets) {
  const plan = path.join(root, 'execution-plan.md');
  writeFileSync(plan, [
    '# EXECUTION PLAN — Structure regression',
    '',
    '**Date:** 2026-10-09',
    '**Spec:** spec.md',
    '',
    '## Pocket Packets',
    '',
    ...packets,
    '',
    '## Plan Summary',
    '',
  ].join('\n'));
  return plan;
}

function structure(root, plan) {
  const result = spawnSync(process.execPath, [
    CLI, 'structure', plan, '--json', '--contract', '3',
  ], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const envelope = JSON.parse(result.stdout.trim());
  assert.equal(envelope.command, 'structure');
  assert.equal(envelope.contract, 3);
  return { status: result.status, envelope };
}

function assertNoGeneratedState(root) {
  assert.equal(existsSync(path.join(root, 'execution-plan')), false);
  assert.equal(existsSync(path.join(root, 'log.json')), false);
}

test('issue #64: structure reports FILE_NOT_FOUND when the source parent is missing', (t) => {
  const root = fixture(t);
  const missingParent = path.join(root, 'missing-parent');
  const { status, envelope } = structure(root, path.join(missingParent, 'plan.md'));

  assert.equal(status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'FILE_NOT_FOUND');
  assert.equal(existsSync(missingParent), false);
});

test('structure rejects duplicate task IDs before losing a packet or generating artifacts', (t) => {
  const root = fixture(t);
  const plan = writePlan(root, [
    '### Task 1: First required deliverable [prereq]',
    'Preserve the first required deliverable.',
    '',
    '### Task 1: Second required deliverable [prereq]',
    'Preserve the second required deliverable.',
  ]);
  const { status, envelope } = structure(root, plan);

  assert.equal(envelope.ok, false, 'Duplicate identities must not silently replace a required packet');
  assert.notEqual(status, 0);
  assertNoGeneratedState(root);
});

test('structure validates unknown dependencies even when a task has a parallel annotation', (t) => {
  const root = fixture(t);
  const plan = writePlan(root, [
    '### Task 1: Foundation [prereq]',
    'Provide the shared interface.',
    '',
    '### Task 2: Consumer [depends: T999] [parallel: T1]',
    'Consume a prerequisite that is absent from this plan.',
  ]);
  const { status, envelope } = structure(root, plan);

  assert.equal(envelope.ok, false, 'Parallel annotations must not bypass dependency validation');
  assert.notEqual(status, 0);
  assertNoGeneratedState(root);
});

test('structure rejects a dependency cycle that a parallel annotation would otherwise hide', (t) => {
  const root = fixture(t);
  const plan = writePlan(root, [
    '### Task 1: First cyclic task [depends: T2]',
    'Require the output of Task 2.',
    '',
    '### Task 2: Second cyclic task [depends: T1] [parallel: T3]',
    'Require the output of Task 1.',
    '',
    '### Task 3: Independent task [prereq]',
    'Provide an independent deliverable.',
  ]);
  const { status, envelope } = structure(root, plan);

  assert.equal(envelope.ok, false, 'T1 and T2 cannot satisfy their circular prerequisites');
  assert.notEqual(status, 0);
  assertNoGeneratedState(root);
});

test('structure schedules a valid parallel group after its shared prerequisite', (t) => {
  const root = fixture(t);
  const plan = writePlan(root, [
    '### Task 1: Shared interface [prereq]',
    'Define the contract used by both implementations.',
    '',
    '### Task 2: Backend implementation [depends: T1]',
    'Implement the backend using the shared contract.',
    '',
    '### Task 3: Frontend implementation [depends: T1] [parallel: T2]',
    'Implement the frontend using the shared contract.',
  ]);
  const { status, envelope } = structure(root, plan);

  assert.equal(status, 0);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.taskCount, 3);
  assert.equal(envelope.data.executionFlow, 'T1→T2,T3(PARALLEL)');
  assert.deepEqual(envelope.data.depthTable, { 0: ['T1'], 1: ['T2', 'T3'] });
  for (const file of [
    'execution-plan/index.md',
    'execution-plan/tasks/T1-shared-interface.md',
    'execution-plan/tasks/T2-backend-implementation.md',
    'execution-plan/tasks/T3-frontend-implementation.md',
  ]) {
    assert.equal(existsSync(path.join(root, file)), true, `Missing generated artifact: ${file}`);
  }
});
