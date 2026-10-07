const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { BUILDER, EXPECTED_ROLES, ROOT, makeFixtureSource } = require('./shared');

const exec = execFileSync;

function assertBuilderValidatesCompleteFixture() {
  const src = makeFixtureSource();
  try {
    const out = exec('node', [BUILDER, '--validate', '--source', src], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    for (const name of EXPECTED_ROLES) {
      assert.ok(out.includes(name), `builder validation output must mention ${name}`);
    }
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function stageExpectFail(role, src, output, frag) {
  let failed = null;
  try {
    exec('node', [BUILDER, '--role', role, '--output', output, '--source', src], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    failed = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`;
  }
  assert.ok(failed, `staging ${role} should fail`);
  assert.ok(
    failed.includes(frag),
    `staging failure for ${role} must report the offending role/path/content (expected ${frag})`,
  );
  return failed;
}

function assertMissingIncludeDoesNotReplaceTarget() {
  const src = makeFixtureSource();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 't5-stage-missing-'));
  const roleDir = path.join(target, 'role');
  fs.rmSync(target, { recursive: true, force: true });
  try {
    fs.rmSync(path.join(src, 'cli/commands/log.js'));
    const before = fs.existsSync(roleDir) ? fs.readdirSync(roleDir) : null;
    stageExpectFail('pi/core', src, roleDir, 'pi/core');
    assert.ok(
      !fs.existsSync(roleDir) || JSON.stringify(fs.readdirSync(roleDir)) === JSON.stringify(before),
      'target role directory must not be partially replaced after missing-include failure',
    );
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function assertDuplicateOwnershipFailsBeforeOutput() {
  const src = makeFixtureSource();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 't5-stage-dup-'));
  try {
    // Plant the Core-owned cli/commands/log.js into the enterprise include tree
    // via a synthetic manifest that double-owns it.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'surfaces.json'), 'utf8'));
    const dup = path.join(os.tmpdir(), `t5-manifest-dup-${process.pid}.json`);
    manifest.roles['pi/enterprise'].includes = [...manifest.roles['pi/enterprise'].includes, 'cli/commands/log.js'];
    fs.writeFileSync(dup, JSON.stringify(manifest), 'utf8');
    let failed = null;
    try {
      exec(
        'node',
        [BUILDER, '--validate', '--source', src, '--manifest', dup],
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      failed = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`;
    }
    assert.ok(failed, 'duplicate ownership should fail validation');
    assert.ok(
      failed.includes('cli/commands/log.js'),
      'duplicate-ownership failure must report the offending path',
    );
    assert.ok(
      !fs.existsSync(path.join(target, 'role')),
      'no partial output may be written on duplicate-ownership failure',
    );
    fs.rmSync(dup, { force: true });
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function assertForbiddenContentFailsBeforeOutput() {
  const src = makeFixtureSource();
  const roleDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't5-stage-forbid-')), 'role');
  try {
    fs.appendFileSync(
      path.join(src, 'skills/pocket-help/SKILL.md'),
      '\nENTERPRISE_ONLY_SURFACE\n',
      'utf8',
    );
    stageExpectFail('pi/core', src, roleDir, 'ENTERPRISE_ONLY_SURFACE');
    assert.ok(
      !fs.existsSync(roleDir),
      'target role directory must not exist after forbidden-content failure',
    );
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(path.dirname(roleDir), { recursive: true, force: true });
  }
}

function assertValidRestagingIsDeterministic() {
  const src = makeFixtureSource();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't5-stage-ok-'));
  try {
    const out1 = path.join(parent, 'role');
    exec('node', [BUILDER, '--role', 'pi/core', '--output', out1, '--source', src], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const list1 = exec('find', [out1, '-type', 'f'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((p) => path.relative(out1, p).split(path.sep).join('/'))
      .sort();
    assert.ok(list1.length > 0, 'staged role must contain files');
    assert.ok(!list1.some((p) => p.startsWith('skills/create-pr/')), 'core staging must exclude enterprise skill');
    assert.ok(
      list1.includes('cli/commands/log.js'),
      'core staging must include core-owned CLI modules',
    );
    assert.ok(
      list1.includes('cli/commands/lifecycle.js'),
      'core staging must include the lifecycle command module',
    );
    assert.ok(
      list1.includes('cli/lib/lifecycle-transition.js'),
      'core staging must include the lifecycle transition module',
    );
    // Restaging over an existing target replaces it atomically, same file set.
    exec('node', [BUILDER, '--role', 'pi/core', '--output', out1, '--source', src], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const list2 = exec('find', [out1, '-type', 'f'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((p) => path.relative(out1, p).split(path.sep).join('/'))
      .sort();
    assert.deepEqual(list2, list1, 'restaging must be deterministic');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function assertManifestStagingFailuresAreAtomic() {
  assertMissingIncludeDoesNotReplaceTarget();
  assertDuplicateOwnershipFailsBeforeOutput();
  assertForbiddenContentFailsBeforeOutput();
  assertValidRestagingIsDeterministic();
}

test('scripts/build-surfaces.js validates the manifest against a fixture source tree', () => {
  assertBuilderValidatesCompleteFixture();
});

test('manifest staging rejects missing, duplicate, or forbidden fixture entries before partial output', () => {
  assertManifestStagingFailuresAreAtomic();
});

test('expandIncludes rejects absolute and parent-directory includes', () => {
  const { expandIncludes } = require('../../cli/lib/surface-manifest');
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-include-escape-'));
  try {
    fs.writeFileSync(path.join(source, 'inside.txt'), 'ok\n');
    assert.throws(
      () => expandIncludes(['../outside.txt'], source),
      /SURFACE_INCLUDE_ESCAPE/,
    );
    assert.throws(
      () => expandIncludes([path.resolve(source, 'inside.txt')], source),
      /SURFACE_INCLUDE_ESCAPE/,
    );
    assert.deepEqual(expandIncludes(['inside.txt'], source), ['inside.txt']);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('expandIncludes rejects symlinks that resolve outside the source root', () => {
  const { expandIncludes } = require('../../cli/lib/surface-manifest');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-symlink-escape-'));
  const source = path.join(parent, 'source');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    fs.writeFileSync(path.join(source, 'nested', 'real.txt'), 'ok\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(source, 'linked.txt'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(source, 'nested', 'via-glob.txt'));
    fs.symlinkSync(outside, path.join(source, 'outside-dir'));
    fs.symlinkSync(path.join(source, 'nested', 'real.txt'), path.join(source, 'inside-link.txt'));

    assert.throws(() => expandIncludes(['linked.txt'], source), /SURFACE_INCLUDE_ESCAPE/);
    assert.throws(() => expandIncludes(['nested/**'], source), /SURFACE_INCLUDE_ESCAPE/);
    assert.throws(() => expandIncludes(['outside-dir'], source), /SURFACE_INCLUDE_ESCAPE/);
    assert.throws(() => expandIncludes(['outside-dir/**'], source), /SURFACE_INCLUDE_ESCAPE/);
    assert.deepEqual(expandIncludes(['inside-link.txt'], source), ['inside-link.txt']);
    assert.deepEqual(expandIncludes(['nested/real.txt'], source), ['nested/real.txt']);

    const cycle = path.join(source, 'cycle-root');
    fs.mkdirSync(cycle);
    fs.writeFileSync(path.join(cycle, 'file.txt'), 'ok\n');
    fs.symlinkSync(cycle, path.join(cycle, 'loop'));
    assert.deepEqual(expandIncludes(['cycle-root/**'], source), ['cycle-root/file.txt']);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
