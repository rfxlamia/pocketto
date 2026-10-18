'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { loadContext } = require('../enterprise/phase-handler-context');
const CLI = path.resolve(__dirname, '../cli/index.js');

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-84-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/feature/test');
  git('config', 'user.name', 'Lifecycle test');
  git('config', 'user.email', 'lifecycle@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  write(path.join(root, 'README.md'), 'Fixture\n');
  git('add', '.');
  git('commit', '-qm', 'Initial fixture');
  const planDir = path.join(root, 'docs/pocket/plans/p');
  const specDir = path.join(root, 'docs/pocket/spec/p');
  write(path.join(specDir, 'approved-spec.md'), '# Approved spec\n');
  write(path.join(planDir, 'execution-plan/index.md'), '# Index\n\n**Spec:** ../../spec/p/approved-spec.md\n');
  write(path.join(planDir, 'execution-plan/phase-1.md'), '# Phase 1\n\n### Task 1: Example\n');
  function cli(...args) {
    const result = spawnSync(process.execPath, [CLI, ...args, '--json', '--contract', '3'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    return envelope.data;
  }
  return { root, planDir, specDir, cli };
}

function missing(data, specDir, actions = false) {
  const warnings = (data.warnings || []).filter(w => w.code === 'LIFECYCLE_DOCUMENT_MISSING');
  assert.equal(warnings.length, 1, JSON.stringify(data));
  assert.ok(warnings[0].message.includes(specDir));
  assert.match(warnings[0].message, /spec-approved/);
  assert.match(warnings[0].message, /lifecycle repair/);
  if (actions) assert.ok(data.next_actions.some(a => a.required && a.command.includes('spec-approved')));
  return warnings[0];
}

for (const absentSpec of [false, true]) {
  test(`Enterprise handler reports missing lifecycle distinctly (absent spec: ${absentSpec})`, t => {
    const f = fixture(t);
    if (absentSpec) fs.rmSync(f.specDir, { recursive: true });
    assert.throws(() => loadContext({ plan_id: 'p' }, { projectRoot: f.root }), error => {
      assert.equal(error.code, 'PHASE_LIFECYCLE_MISSING');
      assert.ok(error.message.includes(path.join(f.specDir, 'lifecycle.json')));
      assert.match(error.message, /spec-approved/);
      assert.match(error.message, /lifecycle repair/);
      assert.doesNotMatch(error.message, /Lifecycle lifecycle/);
      return true;
    });
  });
}

for (const dangling of [false, true]) {
  test(`Enterprise rejects escaping lifecycle symlink (dangling: ${dangling})`, t => {
    const f = fixture(t);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-84-external-'));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    const target = path.join(external, 'lifecycle.json');
    if (!dangling) write(target, '{}');
    fs.symlinkSync(target, path.join(f.specDir, 'lifecycle.json'));
    assert.throws(() => loadContext({ plan_id: 'p' }, { projectRoot: f.root }), error => {
      assert.equal(error.code, 'PHASE_LIFECYCLE_PATH_INVALID');
      assert.doesNotMatch(error.message, /Lifecycle lifecycle/);
      return true;
    });
  });
}

test('stacked missing lifecycle warns through init, repeated init, REVIEW, DONE, handoff and close', t => {
  const f = fixture(t);
  missing(f.cli('log', 'init', f.planDir, '--phase-branches', 'stacked'), f.specDir, true);
  missing(f.cli('log', 'init', f.planDir), f.specDir);
  missing(f.cli('log', 'update', f.planDir, 'phase-1.md', 'REVIEW'), f.specDir);
  missing(f.cli('log', 'update', f.planDir, 'phase-1.md', 'DONE'), f.specDir);
  write(path.join(f.planDir, 'closeout.md'), '# Closeout\n\n## Phase 1 of 1\n<!-- pocket-closeout:phase-1 -->\n\nCompleted.\n');
  const handoff = f.cli('log', 'handoff', f.planDir, 'phase-1.md');
  assert.match(missing(handoff, f.specDir, true).message, /phase-closed.*not recorded/i);
  assert.equal(handoff.event, null);
  missing(f.cli('log', 'close', f.planDir), f.specDir, true);
  assert.equal(fs.existsSync(path.join(f.specDir, 'lifecycle.json')), false);
});

test('valid lifecycle suppresses missing warning on stacked commands', t => {
  const f = fixture(t);
  const hash = createHash('sha256').update('# Approved spec\n').digest('hex');
  f.cli('lifecycle', 'transition', f.specDir, 'spec-approved', '--artifact', `spec:spec-doc:approved-spec.md:${hash}`);
  for (const data of [
    f.cli('log', 'init', f.planDir, '--phase-branches', 'stacked'),
    f.cli('log', 'update', f.planDir, 'phase-1.md', 'REVIEW'),
    f.cli('log', 'update', f.planDir, 'phase-1.md', 'DONE'),
  ]) assert.ok(!(data.warnings || []).some(w => w.code === 'LIFECYCLE_DOCUMENT_MISSING'));
});

test('non-stacked plan without adapter preserves output without missing warning', t => {
  const f = fixture(t);
  for (const data of [
    f.cli('log', 'init', f.planDir, '--phase-branches', 'none'),
    f.cli('log', 'update', f.planDir, 'phase-1.md', 'REVIEW'),
  ]) assert.ok(!(data.warnings || []).some(w => w.code === 'LIFECYCLE_DOCUMENT_MISSING'));
});

test('adapter-registered non-stacked plan warns when lifecycle is missing', t => {
  const f = fixture(t);
  write(path.join(f.root, '.pocket/lifecycle-adapter.json'), JSON.stringify({ schema: 1, adapter_contract: 2, argv: ['node', 'adapter.js'], events: ['phase-complete'], timeout_ms: 5000 }));
  missing(f.cli('log', 'init', f.planDir, '--phase-branches', 'none'), f.specDir, true);
  missing(f.cli('log', 'update', f.planDir, 'phase-1.md', 'REVIEW'), f.specDir);
});

test('publish-phase CLI reports PHASE_LIFECYCLE_MISSING on a stacked plan without lifecycle', t => {
  const f = fixture(t);
  f.cli('log', 'init', f.planDir, '--phase-branches', 'stacked');
  const enterpriseCli = path.resolve(__dirname, '../enterprise/cli.js');
  const install = spawnSync(process.execPath, [enterpriseCli, 'install', f.root, '--json'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const result = spawnSync(process.execPath, [enterpriseCli, 'publish-phase', f.root, f.specDir, 'phase-1', '--json'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'PHASE_LIFECYCLE_MISSING');
  assert.ok(envelope.error.message.includes(path.join(f.specDir, 'lifecycle.json')));
  assert.match(envelope.error.message, /spec-approved/);
  assert.doesNotMatch(envelope.error.message, /Lifecycle lifecycle/);
});
