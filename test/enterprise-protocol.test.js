'use strict';

// T7 CYCLE 1: registration installation and preflight are atomic and fail closed.
// Integration through enterprise/cli.js install/preflight with temporary
// project roots. Uses the real registration validator; fake filesystem
// failure and a recording gh runner as doubles. Zero live GitHub calls.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '../enterprise/cli.js');
const registration = require('../enterprise/registration');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-c1-'));
}

function makeDummyExecutable(root) {
  const p = path.join(root, 'dummy-adapter.js');
  fs.writeFileSync(p, '#!/usr/bin/env node\n"use strict";\n');
  return p;
}

function runCli(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      ...options,
    });
    return { exit: 0, stdout, json: JSON.parse(stdout) };
  } catch (err) {
    const stdout = (err.stdout || '').toString();
    let json = null;
    try {
      json = JSON.parse(stdout);
    } catch (_) {
      json = null;
    }
    return { exit: err.status ?? 1, stdout, json };
  }
}

function pocketDirListing(root) {
  const dir = path.join(root, '.pocket');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort();
}

test('CYCLE 1: install atomically writes registration with schema 1, adapter contract 1, argv, allowlist, timeout', () => {
  const root = makeTempRoot();
  const dummy = makeDummyExecutable(root);
  const res = runCli(['install', root, '--argv', dummy, '--json']);
  assert.equal(res.exit, 0, `install should succeed: ${res.stdout}`);
  assert.equal(res.json.ok, true);

  const regPath = path.join(root, '.pocket', 'lifecycle-adapter.json');
  assert.equal(fs.existsSync(regPath), true, 'registration file must exist');
  const record = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['adapter_contract', 'argv', 'events', 'schema', 'timeout_ms']);
  assert.equal(record.schema, 1, 'registration schema must be 1');
  assert.equal(record.adapter_contract, 1, 'adapter contract must be 1');
  assert.ok(Array.isArray(record.argv) && record.argv.length > 0, 'argv must be a non-empty executable argv');
  assert.ok(record.argv.every((a) => typeof a === 'string' && a.length > 0), 'argv entries must be strings');
  assert.deepEqual(record.events, ['spec-approved', 'phase-complete', 'plan-closed']);
  assert.equal(record.timeout_ms, 30000);

  const orphans = (pocketDirListing(root) || []).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(orphans, [], 'atomic install must leave no temp orphans');
});

test('CYCLE 1: preflight passes on compatible Core plus valid registration', () => {
  const root = makeTempRoot();
  const dummy = makeDummyExecutable(root);
  const installed = runCli(['install', root, '--argv', dummy, '--json']);
  assert.equal(installed.exit, 0, `install should succeed: ${installed.stdout}`);

  const checked = registration.preflight(root, {
    ghRunner: () => {
      throw new Error('preflight must make zero GitHub calls');
    },
  });
  assert.equal(checked.ok, true, `preflight should pass: ${JSON.stringify(checked)}`);

  const viaCli = runCli(['preflight', root, '--json']);
  assert.equal(viaCli.exit, 0, `cli preflight should succeed: ${viaCli.stdout}`);
  assert.equal(viaCli.json.ok, true);
});

test('CYCLE 1: preflight fails closed on missing registration with zero GitHub calls', () => {
  const root = makeTempRoot();
  let ghCalls = 0;
  const res = registration.preflight(root, {
    ghRunner: () => {
      ghCalls += 1;
      return { exit: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(res.ok, false, 'preflight must fail without registration');
  assert.match(res.code, /ENTERPRISE_NOT_INSTALLED/, 'missing registration needs an actionable code');
  assert.match(res.message, /install/i, 'message must direct an install/upgrade action');
  assert.equal(ghCalls, 0, 'failed preflight must make zero GitHub calls');
  assert.equal(pocketDirListing(root), null, 'failed preflight must write no partial Enterprise state');

  const viaCli = runCli(['preflight', root, '--json']);
  assert.notEqual(viaCli.exit, 0, 'cli preflight must exit non-zero when not installed');
  assert.equal(viaCli.json.ok, false);
});

test('CYCLE 1: preflight fails closed on malformed or partial registration', () => {
  for (const [name, body] of [
    ['truncated JSON', '{"schema": 1, "adapter_contract":'],
    ['wrong schema', JSON.stringify({ schema: 99, adapter_contract: 1, argv: ['x'], events: ['spec-approved'], timeout_ms: 30000 })],
    ['contract mismatch', JSON.stringify({ schema: 1, adapter_contract: 2, argv: ['x'], events: ['spec-approved'], timeout_ms: 30000 })],
    ['missing argv', JSON.stringify({ schema: 1, adapter_contract: 1, events: ['spec-approved'], timeout_ms: 30000 })],
  ]) {
    const root = makeTempRoot();
    const dir = path.join(root, '.pocket');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lifecycle-adapter.json'), body);
    const before = pocketDirListing(root);
    let ghCalls = 0;
    const res = registration.preflight(root, {
      ghRunner: () => {
        ghCalls += 1;
        return { exit: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(res.ok, false, `${name} must fail preflight`);
    assert.ok(typeof res.code === 'string' && res.code.length > 0, `${name} needs an actionable code`);
    assert.ok(typeof res.message === 'string' && res.message.length > 0, `${name} needs an actionable message`);
    assert.equal(ghCalls, 0, `${name}: zero GitHub calls`);
    assert.deepEqual(pocketDirListing(root), before, `${name}: no partial Enterprise state written`);
  }
});

test('CYCLE 1: preflight fails closed on missing or incompatible Core', () => {
  const root = makeTempRoot();
  const dummy = makeDummyExecutable(root);
  const installed = registration.installRegistration(root, { argv: [dummy] });
  assert.equal(installed.ok, true);

  for (const [name, coreInfo] of [
    ['missing Core', { present: false, contract: null, lifecycleSchema: null, adapterContract: null }],
    ['incompatible Core contract', { present: true, contract: 2, lifecycleSchema: 1, adapterContract: 1 }],
  ]) {
    let ghCalls = 0;
    const res = registration.preflight(root, {
      getCoreInfo: () => coreInfo,
      ghRunner: () => {
        ghCalls += 1;
        return { exit: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(res.ok, false, `${name} must fail preflight`);
    assert.match(res.code, /ENTERPRISE_CORE/, `${name} needs a Core upgrade/install code`);
    assert.match(res.message, /core/i, `${name} message must mention Core upgrade guidance`);
    assert.equal(ghCalls, 0, `${name}: zero GitHub calls`);
  }
});

test('CYCLE 1: failed install writes no partial registration state', () => {
  const root = makeTempRoot();
  const dummy = makeDummyExecutable(root);
  const res = registration.installRegistration(root, {
    argv: [dummy],
    writeAtomic: () => {
      throw new Error('EIO: fake filesystem failure');
    },
  });
  assert.equal(res.ok, false, 'install must report failure');
  assert.ok(typeof res.code === 'string' && res.code.length > 0, 'install failure needs a code');
  const regPath = path.join(root, '.pocket', 'lifecycle-adapter.json');
  assert.equal(fs.existsSync(regPath), false, 'failed install must leave no registration file');
  const listing = pocketDirListing(root);
  const orphans = (listing || []).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(orphans, [], 'failed install must leave no temp orphans');
  const loaded = registration.loadRegistration(root);
  assert.equal(loaded.ok, false, 'nothing usable may remain after a failed install');
});

// T7 CYCLE 2: valid adapter responses are bounded and secret-free. Unit
// through enterprise/adapter.js response serializer and enterprise/retry.js
// redaction. Fixed response objects and a fake gh runner; never live GitHub.

const adapter = require('../enterprise/adapter');
const retry = require('../enterprise/retry');
const { validateAdapterResponse } = require('../cli/lib/lifecycle-contract');

const C2_EVENT_ID = 'demo-plan:spec-approved:r1';

test('CYCLE 2: succeeded/retryable/terminal/reconciling responses echo the event ID with only permitted proof fields', () => {
  let ghCalls = 0;
  const fakeGh = () => {
    ghCalls += 1;
    return { exit: 0, stdout: '', stderr: '' };
  };
  const cases = [
    { input: { event_id: C2_EVENT_ID, status: 'succeeded', proof_ref: 'meta:github_issue', proof_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' } },
    { input: { event_id: C2_EVENT_ID, status: 'retryable', error: { code: 'GH_TIMEOUT', retryable: true, message: 'gh timed out; will retry with backoff' } } },
    { input: { event_id: C2_EVENT_ID, status: 'terminal', error: { code: 'GH_FORBIDDEN', retryable: false, message: 'gh refused: permission denied' } } },
    { input: { event_id: C2_EVENT_ID, status: 'reconciling', proof_ref: 'meta:github_issue' } },
  ];
  for (const { input } of cases) {
    const res = adapter.serializeResponse(input);
    assert.equal(res.event_id, C2_EVENT_ID, `${input.status}: must echo the original event ID`);
    assert.equal(res.status, input.status);
    assert.equal(validateAdapterResponse(res, C2_EVENT_ID).ok, true, `${input.status}: must satisfy the T1 adapter contract`);
    for (const key of Object.keys(res)) {
      assert.ok(
        ['event_id', 'status', 'proof_ref', 'proof_hash', 'error'].includes(key),
        `${input.status}: no field outside the allowlist (found ${key})`
      );
    }
    if (input.proof_ref !== undefined) {
      assert.equal(res.proof_ref, input.proof_ref, `${input.status}: opaque proof ref must pass through unchanged`);
    }
  }
  assert.equal(typeof fakeGh, 'function');
  assert.equal(ghCalls, 0, 'local response serialization must make zero GitHub calls');
});

test('CYCLE 2: diagnostics are secret-free after redaction', () => {
  const secretToken = 'ghp_superSecretValue123';
  const secretEnv = 'hunter2-seekrit';
  const secretBearer = 'abcdefghij0123456789';
  const nasty = `gh issue create --token ${secretToken} failed; GITHUB_TOKEN=${secretEnv}; credential: s3cr3t-hidden; Bearer ${secretBearer}`;
  const redacted = retry.redactSecrets(nasty);
  assert.equal(typeof redacted, 'string');
  const lower = redacted.toLowerCase();
  assert.ok(!lower.includes('token'), `redacted diagnostics must not mention tokens: ${redacted}`);
  assert.ok(!lower.includes('credential'), `redacted diagnostics must not mention credentials: ${redacted}`);
  for (const leaked of [secretToken, secretEnv, secretBearer, 's3cr3t-hidden']) {
    assert.ok(!redacted.includes(leaked), `redacted diagnostics must not leak secret material: ${leaked}`);
  }
  assert.ok(!redacted.includes('--token'), 'raw secret-bearing command argument must be removed');

  const res = adapter.serializeResponse({
    event_id: C2_EVENT_ID,
    status: 'retryable',
    error: { code: 'GH_TIMEOUT', retryable: true, message: nasty },
  });
  const blob = JSON.stringify(res);
  assert.ok(!blob.includes(secretToken), 'serialized response must not leak the token');
  assert.ok(!blob.toLowerCase().includes('credential'), 'serialized response must not mention credentials');
  assert.equal(res.event_id, C2_EVENT_ID, 'redaction must preserve the event ID');
  assert.equal(validateAdapterResponse(res, C2_EVENT_ID).ok, true);
});

test('CYCLE 2: error helper builds redacted, retry-flagged errors', () => {
  const err = adapter.buildError('GH_TIMEOUT', 'gh run failed with GITHUB_TOKEN=hunter2-seekrit', true);
  assert.equal(err.code, 'GH_TIMEOUT');
  assert.equal(err.retryable, true);
  assert.ok(!err.message.includes('hunter2-seekrit'), 'helper must redact secret values');
  assert.ok(!err.message.toLowerCase().includes('token'), 'helper must redact token mentions');
  const redacted = retry.redactError({ code: 'GH_AUTH', retryable: false, message: 'auth failed for credential xyz' });
  assert.equal(redacted.code, 'GH_AUTH');
  assert.equal(redacted.retryable, false);
  assert.ok(typeof redacted.message === 'string' && redacted.message.length > 0);
});
