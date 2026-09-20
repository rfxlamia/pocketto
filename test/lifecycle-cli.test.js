'use strict';

// T3 lifecycle CLI integration tests (child-process CLI + real temp layout).
// Cycle 1: CLI transition emits a valid spec-approved event.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');

function run(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
    assert.ok(!expectFail, `expected failure but succeeded: ${args.join(' ')}`);
    return { stdout, code: 0 };
  } catch (err) {
    assert.ok(expectFail, `command failed unexpectedly: ${args.join(' ')}\n${err.stdout || ''}${err.stderr || ''}`);
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status };
  }
}

function json(args, opts) {
  return JSON.parse(run(args, opts).stdout.trim());
}

function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

test('CYCLE 1: CLI transition emits a valid spec-approved event', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-cli-'));
  const specDir = path.join(root, 'demo-plan');
  mkdirSync(specDir, { recursive: true });
  const content = 'approved spec content\n';
  writeFileSync(path.join(specDir, 'spec-doc.md'), content);
  const sha = sha256Hex(content);

  const env = json([
    'lifecycle', 'transition', specDir, 'spec-approved',
    '--artifact', `spec:spec-doc:spec-doc.md:${sha}`,
    '--json', '--contract', '3',
  ]);
  assert.equal(env.ok, true);
  assert.equal(env.command, 'lifecycle transition');
  assert.equal(env.contract, 3);
  const d = env.data;
  assert.equal(d.event_id, 'demo-plan:spec-approved:r1');
  assert.equal(d.revision, 1);
  assert.equal(d.status, 'pending');
  assert.equal(d.plan_dir, null);

  const doc = JSON.parse(readFileSync(path.join(specDir, 'lifecycle.json'), 'utf8'));
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].event_id, 'demo-plan:spec-approved:r1');
  assert.equal(doc.events[0].revision, 1);
  assert.equal(doc.plan.plan_dir, null);
});
