'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '../cli/index.js');

function reconcile(t, prior, next) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketto-64-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const priorPath = path.join(root, 'prior.json');
  const nextPath = path.join(root, 'new.json');
  fs.writeFileSync(priorPath, JSON.stringify(prior));
  fs.writeFileSync(nextPath, JSON.stringify(next));
  const result = spawnSync(process.execPath, [
    cliPath, 'reconcile', '--prior', priorPath, '--new', nextPath,
    '--json', '--contract', '3',
  ], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  return { status: result.status, envelope: JSON.parse(result.stdout) };
}

test('audit #64: reconcile rejects findings without fingerprints instead of keeping unrelated findings', (t) => {
  const { status, envelope } = reconcile(t, [{ file: 'old.js' }], [{ file: 'new.js' }]);
  assert.equal(envelope.ok, false, 'missing identity must not equate unrelated findings');
  assert.equal(status, 1);
  assert.equal(envelope.error.code, 'BAD_INPUT');
});

test('audit #64: reconcile reports null findings as BAD_INPUT instead of INTERNAL_ERROR', (t) => {
  const { status, envelope } = reconcile(t, [null], [{ fingerprint: 'new-finding' }]);
  assert.equal(envelope.ok, false);
  assert.equal(status, 1);
  assert.equal(envelope.error.code, 'BAD_INPUT');
});

test('audit #64 control: reconcile partitions valid identities across changed files', (t) => {
  const old = { fingerprint: 'old-finding', file: 'old.js' };
  const sharedPrior = { fingerprint: 'shared-finding', file: 'before.js' };
  const sharedNext = { fingerprint: 'shared-finding', file: 'after.js' };
  const added = { fingerprint: 'new-finding', file: 'new.js' };
  const { status, envelope } = reconcile(t, [old, sharedPrior], [sharedNext, added]);
  assert.equal(status, 0);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, { resolve: [old], post: [added], keep: [sharedNext] });
});
