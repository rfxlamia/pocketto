'use strict';

// Issue #64 artifact lifecycle regression coverage.
{

// Regression coverage for artifact validation, canonical hashing, and transition replay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateArtifactRef, validateEvent, hashCanonicalPayload } = require('../cli/lib/lifecycle-contract');
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

test('artifact replay identity distinguishes filesystem paths while normalizing other text', (t) => {
  const specDir = fixture(t);
  const crlfPath = 'spec\r\nnotes.md';
  const lfPath = 'spec\nnotes.md';
  fs.writeFileSync(path.join(specDir, crlfPath), CONTENT);
  fs.writeFileSync(path.join(specDir, lfPath), CONTENT);
  const crlfRef = artifact({ path: crlfPath });
  const lfRef = artifact({ path: lfPath });

  const first = commitTransition({ specDir, planId: 'demo-plan', type: 'spec-approved', artifacts: [crlfRef] });
  assert.equal(first.ok, true, JSON.stringify(first));
  const otherPath = commitTransition({ specDir, planId: 'demo-plan', type: 'spec-approved', artifacts: [lfRef] });
  assert.equal(otherPath.ok, false, 'a distinct filesystem path must not replay the first artifact event');
  assert.notEqual(otherPath.event && otherPath.event.event_id, first.event.event_id);

  const payload = (filename, text) => ({
    plan_id: 'demo-plan', type: 'spec-approved', artifact_refs: [{ ...artifact({ path: filename }) }],
    proof_ref: text, proof_hash: null,
  });
  assert.notEqual(hashCanonicalPayload(payload(crlfPath, 'line\r\nbreak')), hashCanonicalPayload(payload(lfPath, 'line\r\nbreak')));
  assert.equal(hashCanonicalPayload(payload('spec.md', 'line\r\nbreak')), hashCanonicalPayload(payload('spec.md', 'line\nbreak')));
});

}

// Issue #64 Enterprise CLI and transport regression coverage.
{

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const github = require('../enterprise/github');
const phaseGithub = require('../enterprise/phase-handler-github');
const retry = require('../enterprise/retry');

const CLI = path.resolve(__dirname, '../enterprise/cli.js');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketto-issue64-enterprise-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('issue #64: install keeps --argv values separate from the project root', (t) => {
  const root = temporaryRoot(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const result = spawnSync(process.execPath, [CLI, 'install', '--argv', 'node', project, '--json'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const registrationPath = path.join(project, '.pocket', 'lifecycle-adapter.json');
  assert.equal(fs.existsSync(registrationPath), true, 'install must write to the supplied project root');
  assert.deepEqual(JSON.parse(fs.readFileSync(registrationPath, 'utf8')).argv, ['node']);
  assert.equal(fs.existsSync(path.join(root, 'node', '.pocket')), false, 'the runner executable must not become a project');
});

test('Enterprise install returns JSON errors for a missing root and unknown flags', (t) => {
  const root = temporaryRoot(t);
  for (const args of [['install', '--json'], ['install', root, '--unknown', '--json']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, 'enterprise-install');
    assert.equal(envelope.error.code, 'ENTERPRISE_INSTALL_FAILED');
  }
});

test('Enterprise CLI reports unknown and missing commands without crashing', (t) => {
  const root = temporaryRoot(t);
  for (const args of [['unknown'], [], ['unknown', '--json'], ['--json']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes('ReferenceError'), false);
    if (args.includes('--json')) {
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.command, 'enterprise');
      assert.equal(envelope.error.code, 'ENTERPRISE_UNKNOWN_COMMAND');
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Usage: enterprise\/cli\.js/);
    }
  }
});

test('Enterprise commands explain when more than one project root is supplied', (t) => {
  const root = temporaryRoot(t);
  for (const command of ['install', 'preflight']) {
    const result = spawnSync(process.execPath, [CLI, command, root, 'extra-root', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.match(envelope.error.message, /exactly one project root/i);
  }
});

for (const expectJson of [false, true]) {
  for (const channel of ['stdout', 'stderr']) {
    test(`issue #64: successful ${expectJson ? 'JSON' : 'plain'} transport redacts raw ${channel} while preserving data`, () => {
      const secret = 'ghp_issue64_success_fake_secret';
      const payload = channel === 'stdout' ? secret : 'normal output';
      const stdout = expectJson ? JSON.stringify({ number: 64, body: payload }) : payload;
      const result = github.runGh(['fake-command'], {
        expectJson,
        runner: () => ({
          exit: 0,
          stdout,
          stderr: channel === 'stderr' ? `GITHUB_TOKEN=${secret}` : '',
          timedOut: false,
        }),
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.data, expectJson ? { number: 64, body: payload } : payload);
      assert.equal(result.raw[channel].includes(secret), false, 'raw diagnostics must not expose fake secret material');
    });
  }
}

test('issue #64: body files in a caller directory preserve both requests within one clock tick', (t) => {
  const root = temporaryRoot(t);
  const originalNow = Date.now;
  let first;
  let second;
  try {
    Date.now = () => 1700000000000;
    first = github.writeBodyFile('first request body', { dir: root });
    second = github.writeBodyFile('second request body', { dir: root });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(fs.readFileSync(first, 'utf8'), 'first request body', 'the second request must not overwrite the first payload');
  assert.equal(fs.readFileSync(second, 'utf8'), 'second request body');
  assert.notEqual(first, second, 'each request needs an exclusive file');
});

for (const [name, diagnostic, secret] of [
  ['bare token assignment', 'token=FAKE_BARE_SECRET', 'FAKE_BARE_SECRET'],
  ['quoted environment token', 'GITHUB_TOKEN="FAKE_QUOTED_SECRET"', 'FAKE_QUOTED_SECRET'],
  ['Authorization Bearer header', 'Authorization: Bearer FAKE_HEADER_SECRET', 'FAKE_HEADER_SECRET'],
]) {
  test(`bug hunt: failed transport redacts ${name} from raw and classified diagnostics`, () => {
    const result = github.runGh(['fake-command'], {
      runner: () => ({ exit: 1, stdout: '', stderr: diagnostic, timedOut: false }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.equal(result.raw.stderr.includes(secret), false, 'raw failure diagnostics must redact the secret value');
    assert.equal(result.classification.error.message.includes(secret), false, 'classified failure diagnostics must redact the secret value');
  });
}

for (const [name, diagnostic, secrets] of [
  ['double-quoted spaced flag', 'gh api --token "FAKE_DOUBLE FLAG_SECRET"', ['FAKE_DOUBLE FLAG_SECRET']],
  ['single-quoted spaced flag', "gh api --password 'FAKE_SINGLE FLAG_SECRET'", ['FAKE_SINGLE FLAG_SECRET']],
  ['escaped quotes inside a flag value', 'gh api --secret "FAKE \\"ESCAPED\\" FLAG_SECRET"', ['FAKE \\"ESCAPED\\" FLAG_SECRET', 'ESCAPED']],
]) {
  test(`bug hunt: failed transport redacts ${name} from raw and classified diagnostics`, () => {
    const result = github.runGh(['fake-command'], {
      runner: () => ({ exit: 1, stdout: '', stderr: diagnostic, timedOut: false }),
    });
    assert.equal(result.ok, false);
    for (const secret of secrets) {
      assert.equal(result.raw.stderr.includes(secret), false, `raw diagnostics leaked ${secret}`);
      assert.equal(result.classification.error.message.includes(secret), false, `classification leaked ${secret}`);
    }
  });
}

for (const [name, diagnostic, secret] of [
  ['double-quoted value of an ordinary flag', '--verbose "--client-secret-value=FAKE_NESTED_FLAG_SECRET"', 'FAKE_NESTED_FLAG_SECRET'],
  ['inline-quoted value of an ordinary flag', '--output="--custom-password-key=FAKE_QUOTED_FLAG_SECRET"', 'FAKE_QUOTED_FLAG_SECRET'],
]) {
  test(`failed transport redacts a secret flag nested in the ${name}`, () => {
    const result = github.runGh(['fake-command'], {
      runner: () => ({ exit: 1, stdout: '', stderr: diagnostic, timedOut: false }),
    });

    assert.equal(result.ok, false);
    assert.deepEqual({
      rawLeaks: result.raw.stderr.includes(secret),
      classifiedLeaks: result.classification.error.message.includes(secret),
      helperLeaks: retry.redactError({ message: diagnostic }).message.includes(secret),
    }, { rawLeaks: false, classifiedLeaks: false, helperLeaks: false });
  });
}

for (const [name, diagnostic, secret, suffix] of [
  ['vertical tab separator', '--client-secret-value\vFAKE_VERTICAL_TAB_SECRET', 'FAKE_VERTICAL_TAB_SECRET', ''],
  ['form feed separator', '--client-secret-value\fFAKE_FORM_FEED_SECRET', 'FAKE_FORM_FEED_SECRET', ''],
  ['non-breaking space separator', '--client-secret-value\u00a0FAKE_NBSP_SECRET', 'FAKE_NBSP_SECRET', ''],
  ['non-breaking space value boundary', '--client-secret-value=FAKE_NBSP_VALUE_SECRET\u00a0public-suffix', 'FAKE_NBSP_VALUE_SECRET', 'public-suffix'],
]) {
  test(`failed transport redacts a secret separated by ${name}`, () => {
    const result = github.runGh(['fake-command'], {
      runner: () => ({ exit: 1, stdout: '', stderr: diagnostic, timedOut: false }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.raw.stderr.includes(secret), false, 'raw diagnostics must redact the secret value');
    assert.equal(result.classification.error.message.includes(secret), false, 'classified diagnostics must redact the secret value');
    assert.equal(retry.redactError({ message: diagnostic }).message.includes(secret), false, 'the shared error helper must redact the secret value');
    if (suffix) {
      assert.equal(result.raw.stderr.includes(suffix), true, 'text after the whitespace boundary must be preserved');
      assert.equal(result.classification.error.message.includes(suffix), true, 'classified text after the boundary must be preserved');
    }
  });
}

test('failed transport redacts dash-prefixed secret flag values in every diagnostic boundary', () => {
  const leaks = [];
  for (const [diagnostic, secret] of [
    ['--token -FAKE_DASH_SECRET', 'FAKE_DASH_SECRET'],
    ['--token --FAKE_DOUBLE_DASH_SECRET', 'FAKE_DOUBLE_DASH_SECRET'],
  ]) {
    const result = github.runGh(['fake-command'], {
      runner: () => ({ exit: 1, stdout: '', stderr: diagnostic, timedOut: false }),
    });

    assert.equal(result.ok, false);
    leaks.push({
      raw: result.raw.stderr.includes(secret),
      classification: result.classification.error.message.includes(secret),
      helper: retry.redactError({ message: diagnostic }).message.includes(secret),
    });
  }
  assert.deepEqual(leaks, [
    { raw: false, classification: false, helper: false },
    { raw: false, classification: false, helper: false },
  ]);
});

test('successful transport redacts dash-prefixed secret flag values without changing application data', () => {
  const leaks = [];
  for (const [stdout, secret] of [
    ['--token -FAKE_DASH_SECRET', 'FAKE_DASH_SECRET'],
    ['--token --FAKE_DOUBLE_DASH_SECRET', 'FAKE_DOUBLE_DASH_SECRET'],
  ]) {
    const result = github.runGh(['fake-command'], {
      runner: () => ({ exit: 0, stdout, stderr: '', timedOut: false }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.data, stdout, 'successful application output must remain exact');
    leaks.push(result.raw.stdout.includes(secret));
  }
  assert.deepEqual(leaks, [false, false]);
});

test('successful JSON transport redacts nested secret flags while preserving parsed data', () => {
  const body = [
    '--verbose "--client-secret-value=FAKE_NESTED_FLAG_SECRET"',
    '--output="--custom-password-key=FAKE_QUOTED_FLAG_SECRET"',
  ].join(' ; ');
  const success = github.runGh(['fake-command'], {
    expectJson: true,
    runner: () => ({ exit: 0, stdout: JSON.stringify({ body }), stderr: '', timedOut: false }),
  });

  assert.equal(success.ok, true);
  assert.equal(success.data.body, body, 'parsed application content must remain exact');
  assert.equal(success.raw.stdout.includes('FAKE_NESTED_FLAG_SECRET'), false);
  assert.equal(success.raw.stdout.includes('FAKE_QUOTED_FLAG_SECRET'), false);
});

test('successful plain transport redacts a secret flag nested in an ordinary quoted value', () => {
  const stdout = '--verbose "--client-secret-value=FAKE_NESTED_FLAG_SECRET"';
  const success = github.runGh(['fake-command'], {
    runner: () => ({ exit: 0, stdout, stderr: '', timedOut: false }),
  });

  assert.equal(success.ok, true);
  assert.equal(success.data, stdout, 'successful application output must remain unchanged');
  assert.equal(success.raw.stdout.includes('FAKE_NESTED_FLAG_SECRET'), false);
});

test('successful JSON redaction stays bounded for long ordinary nested flag content', () => {
  const githubPath = path.resolve(__dirname, '../enterprise/github.js');
  const childSource = `
    const github = require(${JSON.stringify(githubPath)});
    const ordinaryFlags = '--label=value '.repeat(8192);
    const body = '--verbose "' + ordinaryFlags + '"';
    const stdout = JSON.stringify({ body });
    const result = github.runGh(['fake-command'], {
      expectJson: true,
      runner: () => ({ exit: 0, stdout, stderr: '', timedOut: false }),
    });
    if (!result.ok || result.data.body !== body || result.raw.stdout !== stdout) process.exit(2);
  `;
  const child = spawnSync(process.execPath, ['-e', childSource], {
    encoding: 'utf8',
    timeout: 2000,
  });

  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || 'long ordinary flag content must remain unchanged and bounded');
});

test('successful JSON transport redacts raw quoted diagnostics while preserving application data', () => {
  const nestedBody = JSON.stringify({ token: 'FAKE_NESTED_SECRET' });
  const payload = { token: 'FAKE_SUCCESS_JSON_SECRET', body: nestedBody };
  const success = github.runGh(['fake-command'], {
    expectJson: true,
    runner: () => ({
      exit: 0,
      stdout: JSON.stringify(payload),
      stderr: JSON.stringify({ GITHUB_TOKEN: 'FAKE_SUCCESS_DIAGNOSTIC SECRET' }),
      timedOut: false,
    }),
  });
  assert.equal(success.ok, true);
  assert.deepEqual(success.data, payload, 'parsed application data must remain unchanged');
  assert.equal(success.raw.stdout.includes('FAKE_SUCCESS_JSON_SECRET'), false);
  assert.equal(success.raw.stdout.includes('FAKE_NESTED_SECRET'), false, 'escaped JSON nested in the body must also be redacted');
  assert.equal(success.raw.stderr.includes('FAKE_SUCCESS_DIAGNOSTIC'), false);
  assert.equal(success.data.body, nestedBody, 'nested application data must remain byte-for-byte intact');
});

test('successful JSON redaction stays bounded for long escaped comment content', () => {
  const githubPath = path.resolve(__dirname, '../enterprise/github.js');
  const childSource = `
    const github = require(${JSON.stringify(githubPath)});
    const backslashes = String.fromCharCode(92).repeat(65536);
    const body = backslashes + JSON.stringify({ token: 'FAKE_LONG_BACKSLASH_SECRET' }) + backslashes;
    const result = github.runGh(['fake-command'], {
      expectJson: true,
      runner: () => ({ exit: 0, stdout: JSON.stringify({ body }), stderr: '', timedOut: false }),
    });
    if (!result.ok || result.data.body !== body || result.raw.stdout.includes('FAKE_LONG_BACKSLASH_SECRET')) process.exit(2);
  `;
  const child = spawnSync(process.execPath, ['-e', childSource], {
    encoding: 'utf8',
    timeout: 2000,
  });

  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || 'long escaped content should be redacted without changing parsed data');
});

test('successful JSON redaction stays bounded for long untrusted hyphen runs', () => {
  const githubPath = path.resolve(__dirname, '../enterprise/github.js');
  const childSource = `
    const github = require(${JSON.stringify(githubPath)});
    const body = '-'.repeat(65536);
    const stdout = JSON.stringify({ body });
    const result = github.runGh(['fake-command'], {
      expectJson: true,
      runner: () => ({ exit: 0, stdout, stderr: '', timedOut: false }),
    });
    if (!result.ok || result.data.body !== body || result.raw.stdout !== stdout) process.exit(2);
  `;
  const child = spawnSync(process.execPath, ['-e', childSource], {
    encoding: 'utf8',
    timeout: 2000,
  });

  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || 'ordinary hyphen runs must remain unchanged and bounded');
});

test('successful JSON redaction stays bounded for an unterminated repeated-token flag name', () => {
  const githubPath = path.resolve(__dirname, '../enterprise/github.js');
  const childSource = `
    const github = require(${JSON.stringify(githubPath)});
    const body = '--' + 'token'.repeat(16384);
    const stdout = JSON.stringify({ body });
    const result = github.runGh(['fake-command'], {
      expectJson: true,
      runner: () => ({ exit: 0, stdout, stderr: '', timedOut: false }),
    });
    if (!result.ok || result.data.body !== body || result.raw.stdout !== stdout) process.exit(2);
  `;
  const child = spawnSync(process.execPath, ['-e', childSource], {
    encoding: 'utf8',
    timeout: 2000,
  });

  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || 'an unseparated flag name must remain unchanged and bounded');
});

for (const [name, diagnostic, secret] of [
  ['lowercase token scheme', 'Authorization: token FAKE_AUTH_TOKEN_SECRET', 'FAKE_AUTH_TOKEN_SECRET'],
  ['mixed-case bearer scheme', 'authorization: bEaReR FAKE_AUTH_BEARER_SECRET', 'FAKE_AUTH_BEARER_SECRET'],
  ['basic scheme', 'Authorization: Basic FAKE_AUTH_BASIC_SECRET', 'FAKE_AUTH_BASIC_SECRET'],
  ['negotiate scheme', 'Authorization: Negotiate FAKE_AUTH_NEGOTIATE_SECRET', 'FAKE_AUTH_NEGOTIATE_SECRET'],
  ['custom scheme', 'Authorization: Custom-Scheme FAKE_AUTH_CUSTOM_SECRET', 'FAKE_AUTH_CUSTOM_SECRET'],
  ['quoted authorization header', 'Authorization: "Token FAKE_AUTH_QUOTED_SECRET"', 'FAKE_AUTH_QUOTED_SECRET'],
]) {
  test(`transport redaction consumes the credential in ${name}`, () => {
    const result = github.runGh(['fake-command'], {
      runner: () => ({ exit: 1, stdout: '', stderr: diagnostic, timedOut: false }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.raw.stderr.includes(secret), false, 'raw diagnostics must not expose authorization credentials');
    assert.equal(result.classification.error.message.includes(secret), false, 'classified diagnostics must not expose authorization credentials');
    assert.equal(retry.redactError({ message: diagnostic }).message.includes(secret), false, 'redacted errors must not expose authorization credentials');
  });
}

test('successful JSON redaction covers authorization in a nested JSON string and preserves data', () => {
  const body = JSON.stringify({ Authorization: 'token FAKE_NESTED_AUTH_SECRET' });
  const success = github.runGh(['fake-command'], {
    expectJson: true,
    runner: () => ({ exit: 0, stdout: JSON.stringify({ body }), stderr: '', timedOut: false }),
  });

  assert.equal(success.ok, true);
  assert.equal(success.data.body, body);
  assert.equal(success.raw.stdout.includes('FAKE_NESTED_AUTH_SECRET'), false);
});

const REDACTION_DIAGNOSTICS = [
  ['JSON token key', JSON.stringify({ token: 'FAKE_JSON_TOKEN_SECRET' }), ['FAKE_JSON_TOKEN_SECRET']],
  ['JSON GITHUB_TOKEN key with spaces', JSON.stringify({ GITHUB_TOKEN: 'FAKE_JSON_SPACE SECRET' }), ['FAKE_JSON_SPACE SECRET']],
  ['JSON password with escaped quotes', JSON.stringify({ password: 'FAKE_ESCAPED " QUOTE SECRET' }), ['FAKE_ESCAPED', 'QUOTE SECRET']],
  ['classic personal token', 'ghp_FAKE_CLASSIC_SECRET', ['ghp_FAKE_CLASSIC_SECRET']],
  ['fine-grained personal token', 'github_pat_FAKE_FINE_GRAINED_SECRET', ['github_pat_FAKE_FINE_GRAINED_SECRET']],
  ['OAuth token', 'gho_FAKE_OAUTH_SECRET', ['gho_FAKE_OAUTH_SECRET']],
  ['user-to-server token', 'ghu_FAKE_USER_TO_SERVER_SECRET', ['ghu_FAKE_USER_TO_SERVER_SECRET']],
  ['stateless app installation token', 'ghs_1234_FAKE_HEADER.FAKE_PAYLOAD.FAKE_SIGNATURE', ['FAKE_HEADER', 'FAKE_PAYLOAD', 'FAKE_SIGNATURE']],
  ['refresh token', 'ghr_FAKE_REFRESH_SECRET', ['ghr_FAKE_REFRESH_SECRET']],
];

for (const [name, diagnostic, secrets] of REDACTION_DIAGNOSTICS) {
  test(`failed transport redacts ${name} from raw and classified diagnostics`, () => {
    const result = github.runGh(['fake-command'], {
      runner: () => ({ exit: 1, stdout: '', stderr: diagnostic, timedOut: false }),
    });
    assert.equal(result.ok, false, name);
    for (const secret of secrets) {
      assert.equal(result.raw.stderr.includes(secret), false, `${name}: raw diagnostics leaked ${secret}`);
      assert.equal(result.classification.error.message.includes(secret), false, `${name}: classified diagnostics leaked ${secret}`);
    }
  });
}

for (const command of ['install', 'preflight']) {
  for (const json of [false, true]) {
    test(`unknown inline secret flag is redacted from ${command} ${json ? 'JSON' : 'human'} errors`, (t) => {
      const root = temporaryRoot(t);
      const args = [CLI, command, root, '--token=FAKE_CLI_SECRET', ...(json ? ['--json'] : [])];
      const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 1);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(output.includes('FAKE_CLI_SECRET'), false, `${command} ${json ? 'JSON' : 'human'} error leaked its inline option value`);
      assert.match(output, /Unknown option: --token/i, 'the error should retain the sanitized option name');
      if (json) {
        const envelope = JSON.parse(result.stdout);
        assert.equal(envelope.ok, false);
        assert.match(envelope.error.message, /Unknown option: --token/i);
      }
    });
  }
}

test('failed body writes remove owned temp directories but preserve caller directories', (t) => {
  const root = temporaryRoot(t);
  const ownedMkdtemp = fs.mkdtempSync;
  const ownedWrite = fs.writeFileSync;
  let createdTempDir;
  fs.mkdtempSync = function (prefix, ...args) {
    const dir = ownedMkdtemp.call(fs, prefix, ...args);
    if (String(prefix).includes('enterprise-body-')) createdTempDir = dir;
    return dir;
  };
  fs.writeFileSync = function (file, ...args) {
    if (typeof file === 'number') {
      const error = new Error('injected body write failure');
      error.code = 'EIO';
      throw error;
    }
    return ownedWrite.call(fs, file, ...args);
  };

  try {
    assert.throws(() => github.writeBodyFile('body that cannot be written'), { code: 'EIO' });
    assert.equal(fs.existsSync(createdTempDir), false, 'an automatically-created directory must be removed after write failure');
    fs.writeFileSync(path.join(root, 'sentinel.txt'), 'keep');
    assert.throws(() => github.writeBodyFile('body that cannot be written', { dir: root }), { code: 'EIO' });
    assert.equal(fs.readFileSync(path.join(root, 'sentinel.txt'), 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(root), ['sentinel.txt'], 'caller-owned directories and files must remain untouched');
  } finally {
    fs.mkdtempSync = ownedMkdtemp;
    fs.writeFileSync = ownedWrite;
  }
});

test('bug hunt: PR comment lookup combines all gh API pagination pages', () => {
  const endpoint = 'repos/example/project/issues/64/comments';
  const first = { id: 101, body: 'first page comment', user: { login: 'example' } };
  const second = { id: 102, body: '<!-- phase marker on second page -->', user: { login: 'example' } };
  const comments = phaseGithub.listComments(endpoint, {
    ghRunner: (args) => {
      assert.equal(args[0], 'api');
      assert.equal(args[1], endpoint);
      // gh emits one document per page unless --slurp wraps them together.
      const pages = args.includes('--paginate') ? [[first], [second]] : [[first]];
      const stdout = args.includes('--slurp')
        ? JSON.stringify(pages)
        : pages.map((page) => JSON.stringify(page)).join('\n');
      return { exit: 0, stdout, stderr: '', timedOut: false };
    },
  });

  assert.deepEqual(comments, [first, second], 'later-page ownership markers must remain available to PR resolution');
});

test('issue #64 control: default body directories isolate requests in the same clock tick', () => {
  const originalNow = Date.now;
  const files = [];
  try {
    Date.now = () => 1700000000000;
    files.push(github.writeBodyFile('first default body'));
    files.push(github.writeBodyFile('second default body'));
    assert.notEqual(files[0], files[1]);
    assert.equal(fs.readFileSync(files[0], 'utf8'), 'first default body');
    assert.equal(fs.readFileSync(files[1], 'utf8'), 'second default body');
  } finally {
    Date.now = originalNow;
    for (const file of files) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

for (const exit of [0, 1]) {
  test(`issue #64 control: summary transport cleans body files after ${exit === 0 ? 'success' : 'failure'}`, (t) => {
    let bodyFile;
    t.after(() => {
      if (bodyFile) fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true });
    });
    const run = () => phaseGithub.upsertSummary('repos/example/project/issues/64/comments', [],
      '<!-- summary marker -->', 'summary body', {
        ghRunner: (args) => {
          bodyFile = args.find((arg) => arg.startsWith('body=@')).slice('body=@'.length);
          assert.equal(fs.readFileSync(bodyFile, 'utf8'), 'summary body');
          return { exit, stdout: exit === 0 ? '{"id":101}' : '', stderr: exit === 0 ? '' : 'HTTP 403 Forbidden', timedOut: false };
        },
      });

    if (exit === 0) run();
    else assert.throws(run, { code: 'GH_FORBIDDEN' });
    assert.equal(typeof bodyFile, 'string');
    assert.equal(fs.existsSync(bodyFile), false);
    assert.equal(fs.existsSync(path.dirname(bodyFile)), false);
  });
}

}

// Issue #64 reconcile fingerprint regression coverage.
{

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

for (const [label, record] of [
  ['non-string', { fingerprint: 64 }],
  ['empty', { fingerprint: '' }],
  ['whitespace-only', { fingerprint: '  ' }],
]) {
  test(`audit #64: reconcile reports ${label} fingerprints as BAD_INPUT`, (t) => {
    const { status, envelope } = reconcile(t, [record], [{ fingerprint: 'new-finding' }]);
    assert.equal(status, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'BAD_INPUT');
  });
}

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

}

// Issue #64 task graph regression coverage.
{

// Regression coverage for task graph validation and valid parallel scheduling.

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

for (const reference of ['toString', 'constructor', '__proto__']) {
  test(`structure rejects prototype property ${reference} as an unknown dependency`, (t) => {
    const root = fixture(t);
    const plan = writePlan(root, [
      '### Task 1: Consumer [depends: ' + reference + ']',
      'This prerequisite does not exist in the plan.',
    ]);
    const { status, envelope } = structure(root, plan);
    assert.equal(status, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'UNKNOWN_TASK_REF');
    assertNoGeneratedState(root);
  });
}

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

for (const [name, packets, taskId, dependencyId] of [
  ['same-depth dependency', [
    '### Task 1: First prerequisite [prereq]',
    'Provide the first prerequisite.',
    '',
    '### Task 2: Parallel prerequisite [prereq]',
    'Provide the parallel prerequisite.',
    '',
    '### Task 3: Consumer [depends: T1] [parallel: T2]',
    'A parallel placement cannot satisfy a same-depth dependency.',
  ], 'T3', 'T1'],
  ['earlier-depth dependency', [
    '### Task 1: Foundation [prereq]',
    'Provide the foundation.',
    '',
    '### Task 2: Intermediate output [depends: T1]',
    'Produce the required intermediate output.',
    '',
    '### Task 3: Independent prerequisite [prereq]',
    'Provide an independent parallel target.',
    '',
    '### Task 4: Final consumer [depends: T2] [parallel: T3]',
    'A parallel placement cannot precede a dependency.',
  ], 'T4', 'T2'],
]) {
  test(`structure rejects a ${name} introduced by parallel placement before writing artifacts`, (t) => {
    const root = fixture(t);
    const plan = writePlan(root, packets);
    const { status, envelope } = structure(root, plan);

    assert.equal(status, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'DEPENDENCY_ORDER');
    assert.match(envelope.error.message, new RegExp(`${taskId}.*${dependencyId}`));
    assertNoGeneratedState(root);
  });
}

test('structure preserves valid mixed parallel and dependency annotations', (t) => {
  const root = fixture(t);
  const plan = writePlan(root, [
    '### Task 1: Shared contract [prereq]',
    'Define the shared contract.',
    '',
    '### Task 2: Backend [depends: T1]',
    'Implement the backend.',
    '',
    '### Task 3: Frontend [depends: T1] [parallel: T2]',
    'Implement the frontend in parallel with the backend.',
    '',
    '### Task 4: Integration [depends: T2, T3]',
    'Integrate both implementations.',
  ]);
  const { status, envelope } = structure(root, plan);

  assert.equal(status, 0);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.executionFlow, 'T1→T2,T3(PARALLEL)→T4');
  assert.deepEqual(envelope.data.depthTable, { 0: ['T1'], 1: ['T2', 'T3'], 2: ['T4'] });
});

}
