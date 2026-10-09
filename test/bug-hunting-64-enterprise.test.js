'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const github = require('../enterprise/github');
const phaseGithub = require('../enterprise/phase-handler-github');

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
