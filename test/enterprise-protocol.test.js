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
  assert.deepEqual(record.argv, [dummy], 'an explicit custom --argv override must be registered verbatim');
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

// T7 CYCLE 3: remote failure classes map to bounded outcomes. Unit through
// enterprise/retry.js and the injectable enterprise/github.js runner.
// Fake gh exit/status responses and clock; no live network.

const github = require('../enterprise/github');
const enterpriseMeta = require('../enterprise/meta');

function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('CYCLE 3: timeout and rate-limit classify as retryable within the configured bound', () => {
  const clock = fakeClock();
  const timeoutRes = { exit: 1, stdout: '', stderr: 'gh: operation timed out after 30s', timedOut: true };
  const classifiedTimeout = retry.classifyGhResult(timeoutRes, { now: clock.now });
  assert.equal(classifiedTimeout.status, 'retryable');
  assert.equal(classifiedTimeout.error.retryable, true);
  assert.match(classifiedTimeout.error.code, /GH_(TIMEOUT|RATE_LIMITED)/);

  const rateRes = { exit: 1, stdout: '', stderr: 'API rate limit exceeded for installation (HTTP 429)', timedOut: false };
  const classifiedRate = retry.classifyGhResult(rateRes, { now: clock.now });
  assert.equal(classifiedRate.status, 'retryable');
  assert.equal(classifiedRate.error.retryable, true);
  assert.equal(classifiedRate.error.code, 'GH_RATE_LIMITED');

  // Bounded: five retries with 1s/5s/30s/120s/600s delays, then terminal.
  assert.deepEqual(retry.RETRY_DELAYS_MS, [1000, 5000, 30000, 120000, 600000]);
  for (let attemptsMade = 1; attemptsMade <= 5; attemptsMade += 1) {
    const outcome = retry.boundOutcome(classifiedTimeout, attemptsMade);
    assert.equal(outcome.status, 'retryable', `attempt ${attemptsMade} must stay retryable`);
    assert.equal(outcome.nextAttemptMs, retry.RETRY_DELAYS_MS[attemptsMade - 1]);
  }
  const exhausted = retry.boundOutcome(classifiedTimeout, 6);
  assert.equal(exhausted.status, 'terminal', 'after the fifth retry the event must be terminal/manual resolution');
  assert.match(exhausted.error.message, /manual/i);
});

test('CYCLE 3: auth/permission/validation/integrity classify as terminal with no implied mutation', () => {
  const cases = [
    [{ exit: 1, stdout: '', stderr: 'Bad credentials (HTTP 401)', timedOut: false }, 'GH_AUTH'],
    [{ exit: 1, stdout: '', stderr: 'Forbidden: permission denied to write issues', timedOut: false }, 'GH_FORBIDDEN'],
    [{ exit: 1, stdout: '', stderr: 'Unprocessable (HTTP 422): Validation Failed', timedOut: false }, 'GH_VALIDATION'],
    [{ exit: 1, stdout: '', stderr: 'payload hash mismatch: integrity check failed', timedOut: false }, 'GH_INTEGRITY'],
  ];
  for (const [result, code] of cases) {
    let ghCalls = 0;
    const before = { ...result };
    const classified = retry.classifyGhResult(result, {});
    assert.equal(classified.status, 'terminal', `${code} must be terminal`);
    assert.equal(classified.error.retryable, false);
    assert.equal(classified.error.code, code);
    assert.ok(typeof classified.error.message === 'string' && classified.error.message.length > 0, `${code} needs an actionable message`);
    assert.deepEqual(result, before, `${code}: classification must not mutate its input`);
    assert.equal(ghCalls, 0, `${code}: classification implies no remote call`);
    const bounded = retry.boundOutcome(classified, 1);
    assert.equal(bounded.status, 'terminal', `${code} stays terminal under the bound`);
  }
});

test('CYCLE 3: malformed output and generic non-zero exit are retryable until the bound, never success', () => {
  const malformed = retry.classifyGhResult({ exit: 0, stdout: 'not-json{{{', stderr: '', timedOut: false }, { expectJson: true });
  assert.equal(malformed.status, 'retryable', 'malformed output must never be success');
  assert.equal(malformed.error.code, 'GH_MALFORMED_OUTPUT');

  const nonzero = retry.classifyGhResult({ exit: 1, stdout: '', stderr: 'some unfamiliar failure', timedOut: false }, {});
  assert.equal(nonzero.status, 'retryable', 'unknown non-zero exit must be retryable until the bound');
  assert.equal(nonzero.error.retryable, true);

  const exhausted = retry.boundOutcome(nonzero, 6);
  assert.equal(exhausted.status, 'terminal', 'unknown failures still terminate after the bound');
  assert.notEqual(malformed.status, 'succeeded');
  assert.notEqual(nonzero.status, 'succeeded');
});

test('CYCLE 3: safe gh runner enforces timeout, parses JSON safely, and redacts diagnostics', () => {
  const seen = [];
  const recordingRunner = (args, opts) => {
    seen.push({ args: args.slice(), timeoutMs: opts.timeoutMs });
    if (args.includes('rate-limited')) return { exit: 1, stdout: '', stderr: 'API rate limit exceeded', timedOut: false };
    if (args.includes('auth-fail')) return { exit: 1, stdout: '', stderr: 'Bad credentials GITHUB_TOKEN=hunter2-seekrit', timedOut: false };
    return { exit: 0, stdout: JSON.stringify({ number: 50 }), stderr: '', timedOut: false };
  };

  const okRes = github.runGh(['issue', 'view', '50', '--json', 'number'], {
    runner: recordingRunner,
    timeoutMs: 30000,
    expectJson: true,
  });
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.data, { number: 50 });

  const rateRes = github.runGh(['issue', 'view', 'rate-limited'], {
    runner: recordingRunner,
    timeoutMs: 30000,
  });
  assert.equal(rateRes.ok, false);
  assert.equal(rateRes.classification.status, 'retryable');

  const authRes = github.runGh(['issue', 'view', 'auth-fail'], {
    runner: recordingRunner,
    timeoutMs: 30000,
  });
  assert.equal(authRes.ok, false);
  assert.equal(authRes.classification.status, 'terminal');
  const blob = JSON.stringify(authRes);
  assert.ok(!blob.includes('hunter2-seekrit'), 'runner diagnostics must redact secret values');
  assert.ok(!blob.toLowerCase().includes('token'), 'runner diagnostics must not mention tokens');

  const timeoutRes = github.runGh(['issue', 'list'], {
    runner: () => ({ exit: 1, stdout: '', stderr: 'hung', timedOut: true }),
    timeoutMs: 1000,
  });
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.classification.error.code, 'GH_TIMEOUT');

  const malformedRes = github.runGh(['issue', 'view', '1', '--json', 'number'], {
    runner: () => ({ exit: 0, stdout: 'oops-not-json', stderr: '', timedOut: false }),
    timeoutMs: 30000,
    expectJson: true,
  });
  assert.equal(malformedRes.ok, false, 'malformed JSON output must fail, never succeed');
  assert.equal(malformedRes.classification.error.code, 'GH_MALFORMED_OUTPUT');

  assert.ok(seen.length >= 3, 'injectable runner must observe every call');
  assert.ok(seen.every((c) => typeof c.timeoutMs === 'number'), 'timeout policy must reach the runner');
});

test('CYCLE 3: metadata seam round-trips GitHub IDs through the Enterprise wrapper only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-c3-'));
  const specDir = path.join(root, 'spec');
  fs.mkdirSync(specDir, { recursive: true });

  enterpriseMeta.setIssueIdentity(specDir, { number: 50, url: 'https://example.invalid/owner/repo/issues/50' });
  assert.deepEqual(enterpriseMeta.getIssueIdentity(specDir), {
    number: 50,
    url: 'https://example.invalid/owner/repo/issues/50',
  });

  enterpriseMeta.setPrIdentity(specDir, 'phase-1', { number: 51, url: 'https://example.invalid/owner/repo/pull/51' });
  assert.deepEqual(enterpriseMeta.getPrIdentity(specDir, 'phase-1'), {
    number: 51,
    url: 'https://example.invalid/owner/repo/pull/51',
  });

  const raw = JSON.parse(fs.readFileSync(path.join(specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(raw.github_issue.number, 50);
  assert.equal(raw.phases['phase-1'].github_pr.number, 51);

  const bodyPath = github.writeBodyFile('hello **world**', { dir: root });
  assert.equal(fs.readFileSync(bodyPath, 'utf8'), 'hello **world**');
  assert.ok(bodyPath.startsWith(root), 'body-file transport must stay local');
});

// T7 CYCLE 4: adapter contract mismatch prevents handler dispatch.
// Integration through Core's registered executable invocation plus the
// Enterprise preflight/allowlist boundary. Recording adapter/GitHub
// runner; real process protocol and temporary registration files.

function makeC4Event(overrides = {}) {
  const planId = 'demo-plan';
  const type = overrides.type || 'spec-approved';
  const revision = overrides.revision || 1;
  return {
    event_id: `${planId}:${type}:r${revision}`,
    plan_id: planId,
    type,
    revision,
    occurred_at: '2026-09-19T12:00:00.000Z',
    artifact_refs: [
      {
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec-doc.md',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        revision: 1,
      },
    ],
    payload_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 0 },
    ...overrides,
  };
}

function installC4Root(events, argv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-c4-'));
  const res = registration.installRegistration(root, { argv, events });
  assert.equal(res.ok, true, `c4 install should succeed: ${JSON.stringify(res)}`);
  return root;
}

test('CYCLE 4: Core contract 3 plus adapter registration contract 2 fails closed before any handler or GitHub call', () => {
  const root = installC4Root(['spec-approved'], [process.execPath, 'adapter-stub.js']);
  const dir = path.join(root, '.pocket');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'lifecycle-adapter.json'), 'utf8'));
  raw.adapter_contract = 2;
  fs.writeFileSync(path.join(dir, 'lifecycle-adapter.json'), JSON.stringify(raw, null, 2) + '\n');

  let handlerCalls = 0;
  let ghCalls = 0;
  const res = adapter.dispatchEvent(makeC4Event(), {
    projectRoot: root,
    coreContract: 3,
    handlers: {
      'spec-approved': () => {
        handlerCalls += 1;
        return { event_id: 'demo-plan:spec-approved:r1', status: 'succeeded' };
      },
    },
    ghRunner: () => {
      ghCalls += 1;
      return { exit: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(res.status, 'retryable', 'mixed-major mismatch must leave the event pending/retryable for Core replay');
  assert.equal(res.error.retryable, true, 'contract mismatch must remain explicitly retryable');
  assert.match(res.error.code, /ADAPTER_CONTRACT|ADAPTER_PROTOCOL/, 'mismatch needs an actionable protocol code');
  assert.equal(res.event_id, 'demo-plan:spec-approved:r1', 'protocol result must carry the original event ID');
  assert.equal(handlerCalls, 0, 'no handler may run on contract mismatch');
  assert.equal(ghCalls, 0, 'no GitHub call may run on contract mismatch');
});

test('CYCLE 4: event allowlist omission fails closed before any handler or GitHub call', () => {
  const root = installC4Root(['spec-approved'], [process.execPath, 'adapter-stub.js']);
  let handlerCalls = 0;
  let ghCalls = 0;
  const res = adapter.dispatchEvent(makeC4Event({ type: 'phase-complete' }), {
    projectRoot: root,
    coreContract: 3,
    handlers: {
      'phase-complete': () => {
        handlerCalls += 1;
        return { event_id: 'demo-plan:phase-complete:r1', status: 'succeeded' };
      },
    },
    ghRunner: () => {
      ghCalls += 1;
      return { exit: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(res.status, 'retryable', 'allowlist omission must leave the event pending/retryable for Core replay');
  assert.equal(res.error.retryable, true, 'event allowlist mismatch must remain explicitly retryable');
  assert.match(res.error.code, /ADAPTER_EVENT_NOT_ALLOWED|ADAPTER_PROTOCOL/, 'omission needs an actionable protocol code');
  assert.equal(res.event_id, 'demo-plan:phase-complete:r1');
  assert.equal(handlerCalls, 0, 'no handler may run when the event is not allowlisted');
  assert.equal(ghCalls, 0, 'no GitHub call may run when the event is not allowlisted');
});

test('CYCLE 4: the handler dispatch table covers exactly the three lifecycle event types', () => {
  assert.deepEqual(Object.keys(adapter.HANDLERS).sort(), ['phase-complete', 'plan-closed', 'spec-approved']);
  for (const type of ['spec-approved', 'phase-complete', 'plan-closed']) {
    assert.equal(typeof adapter.HANDLERS[type], 'string', `${type} must map to an explicit named handler`);
    assert.ok(adapter.HANDLERS[type].length > 0, `${type} handler name must be non-empty`);
  }
});

test('CYCLE 4: compatible registration dispatches to the handler with zero GitHub calls from the boundary', () => {
  const root = installC4Root(['spec-approved'], [process.execPath, 'adapter-stub.js']);
  const seen = [];
  let ghCalls = 0;
  const res = adapter.dispatchEvent(makeC4Event(), {
    projectRoot: root,
    coreContract: 3,
    handlers: {
      'spec-approved': (event) => {
        seen.push(event.event_id);
        return { event_id: event.event_id, status: 'succeeded', proof_ref: 'meta:github_issue' };
      },
    },
    ghRunner: () => {
      ghCalls += 1;
      return { exit: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(res.status, 'succeeded');
  assert.equal(res.event_id, 'demo-plan:spec-approved:r1');
  assert.equal(res.proof_ref, 'meta:github_issue');
  assert.deepEqual(seen, ['demo-plan:spec-approved:r1'], 'compatible dispatch must reach exactly one handler');
  assert.equal(ghCalls, 0, 'the boundary itself performs no GitHub call');
});

test('SUP-3 unknown type: terminal before handler or transport dispatch', () => {
  const root = installC4Root(['spec-approved'], [process.execPath, 'adapter-stub.js']);
  let handlerCalls = 0;
  let transportCalls = 0;
  const event = makeC4Event({ type: 'future-event' });
  const res = adapter.dispatchEvent(event, {
    projectRoot: root,
    coreContract: 3,
    handlers: {
      'future-event': (receivedEvent, { ghRunner }) => {
        handlerCalls += 1;
        ghRunner(['unexpected', 'transport']);
        return { event_id: receivedEvent.event_id, status: 'succeeded' };
      },
    },
    ghRunner: () => {
      transportCalls += 1;
      return { exit: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(res.event_id, 'demo-plan:future-event:r1');
  assert.equal(res.status, 'terminal', 'an unknown type rejected by validateEvent must be terminal');
  assert.equal(res.error.retryable, false, 'an unknown type must not be retried');
  assert.equal(res.error.code, 'ADAPTER_PROTOCOL_INVALID_EVENT');
  assert.equal(handlerCalls, 0, 'schema-invalid events must not reach a handler');
  assert.equal(transportCalls, 0, 'schema-invalid events must not reach transport');
});

test('SUP-3: malformed allowlisted lifecycle events fail before handler or transport dispatch', () => {
  const root = installC4Root(['spec-approved'], [process.execPath, 'adapter-stub.js']);
  const invalidEvents = [
    makeC4Event({ unexpected: 'not part of the neutral event contract' }),
    makeC4Event({
      artifact_refs: [{
        root: 'spec',
        kind: 'spec-doc',
        path: '../outside-root.md',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        revision: 1,
      }],
    }),
  ];
  const seen = [];
  let handlerCalls = 0;
  let transportCalls = 0;
  const dispatch = (event) => adapter.dispatchEvent(event, {
    projectRoot: root,
    coreContract: 3,
    handlers: {
      'spec-approved': (receivedEvent, { ghRunner }) => {
        handlerCalls += 1;
        seen.push(receivedEvent.event_id);
        ghRunner(['issue', 'create']);
        return { event_id: receivedEvent.event_id, status: 'succeeded' };
      },
    },
    ghRunner: () => {
      transportCalls += 1;
      return { exit: 0, stdout: '', stderr: '' };
    },
  });

  const invalidResults = invalidEvents.map(dispatch);
  assert.deepEqual({
    outcomes: invalidResults.map(({ status, error }) => [status, error && error.retryable, error && error.code]),
    handlerCalls,
    transportCalls,
  }, {
    outcomes: [
      ['terminal', false, 'ADAPTER_PROTOCOL_INVALID_EVENT'],
      ['terminal', false, 'ADAPTER_PROTOCOL_INVALID_EVENT'],
    ],
    handlerCalls: 0,
    transportCalls: 0,
  }, 'malformed allowlisted events must fail stably before either side-effect boundary');

  const validResult = dispatch(makeC4Event());
  assert.equal(validResult.status, 'succeeded', 'a valid event must keep the supported handler path');
  assert.equal(validResult.event_id, 'demo-plan:spec-approved:r1');
  assert.deepEqual(seen, ['demo-plan:spec-approved:r1']);
  assert.equal(handlerCalls, 1);
  assert.equal(transportCalls, 1);
});
