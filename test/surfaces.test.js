// T5 Cycle 1 — explicit four-role surface manifest (integration).
// Given a synthetic source fixture and the canonical manifest,
// When the surface manifest is loaded,
// Then it contains exactly pi/core, pi/enterprise, claude/core, claude/enterprise,
// each with explicit includes/requires/forbidden_paths/forbidden_content;
// Enterprise roles require matching Core roles, no role relies on skills/**,
// and ownership classifies the 10 named CLI modules.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'surfaces.json');
const BUILDER = path.join(ROOT, 'scripts', 'build-surfaces.js');
const LIB = path.join(ROOT, 'cli', 'lib', 'surface-manifest.js');

const EXPECTED_ROLES = ['pi/core', 'pi/enterprise', 'claude/core', 'claude/enterprise'];

const ENTERPRISE_RUNTIME_FILES = [
  'enterprise/cli.js',
  'enterprise/adapter.js',
  'enterprise/registration.js',
  'enterprise/github.js',
  'enterprise/meta.js',
  'enterprise/retry.js',
];

const NAMED_CLI_MODULES = [
  'cli/commands/mode.js',
  'cli/lib/mode.js',
  'cli/commands/meta.js',
  'cli/lib/meta.js',
  'cli/commands/format.js',
  'cli/lib/bodies.js',
  'cli/lib/identity.js',
  'cli/lib/reconcile.js',
  'cli/commands/lifecycle.js',
  'cli/lib/lifecycle-transition.js',
];

function makeFixtureSource() {
  // Materialize every declared manifest include so the fixture source tree
  // is complete: exact files get placeholders, `<dir>/**` globs get two
  // sample files. Forbidden paths are never created.
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't5-surface-src-'));
  const seen = new Set();
  for (const role of Object.values(manifest.roles)) {
    for (const inc of role.includes) {
      if (seen.has(inc)) continue;
      seen.add(inc);
      if (inc.endsWith('/**')) {
        const base = inc.slice(0, -3);
        for (const sample of ['SKILL.md', 'references/sample.md']) {
          const full = path.join(dir, base, sample);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, `# fixture ${base}/${sample}\n`, 'utf8');
        }
      } else {
        const full = path.join(dir, inc);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, `# fixture ${inc}\n`, 'utf8');
      }
    }
  }
  return dir;
}

test('manifest declares exactly four explicit roles with no wildcard package surface', () => {
  const { loadManifest } = require(LIB);
  const manifest = loadManifest(MANIFEST_PATH);

  assert.equal(manifest.schema, 1, 'manifest schema must be 1');
  assert.equal(
    manifest.release && manifest.release.major,
    4,
    'release major must be 4',
  );
  const roles = Object.keys(manifest.roles || {}).sort();
  assert.deepEqual(roles, [...EXPECTED_ROLES].sort(), 'exactly four roles required');

  for (const name of EXPECTED_ROLES) {
    const role = manifest.roles[name];
    assert.ok(Array.isArray(role.includes) && role.includes.length > 0, `${name}: explicit includes required`);
    assert.ok(Array.isArray(role.requires), `${name}: requires required`);
    assert.ok(
      Array.isArray(role.forbidden_paths) && role.forbidden_paths.length > 0,
      `${name}: forbidden_paths required`,
    );
    assert.ok(
      Array.isArray(role.forbidden_content) && role.forbidden_content.length > 0,
      `${name}: forbidden_content required`,
    );
    for (const inc of role.includes) {
      assert.ok(
        inc !== 'skills/**' && inc !== 'skills/*',
        `${name}: role must not rely on package-wide skills/** wildcard (got ${inc})`,
      );
    }
  }

  assert.deepEqual(manifest.roles['pi/enterprise'].requires, ['pi/core']);
  assert.deepEqual(manifest.roles['claude/enterprise'].requires, ['claude/core']);
  assert.deepEqual(manifest.roles['pi/core'].requires, []);
  assert.deepEqual(manifest.roles['claude/core'].requires, []);

  assert.ok(manifest.ownership, 'ownership map required');
  for (const mod of NAMED_CLI_MODULES) {
    assert.ok(
      ['core', 'shared', 'enterprise'].includes(manifest.ownership[mod]),
      `ownership must classify ${mod}`,
    );
  }

  assert.ok(manifest.cli_boundary, 'manifest must describe the lazy CLI boundary');
});

test('staged pi/core contains the lifecycle files and its entry starts', () => {
  const { execFileSync: exec } = require('node:child_process');
  // Stage from the real repo source (fixture trees hold placeholders that
  // cannot be required), then demand the lifecycle files and a loadable
  // staged entry: requiring the staged cli/index.js exercises the eager
  // Core command graph (including lifecycle) without enterprise modules.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't5-core-entry-'));
  try {
    const out = path.join(parent, 'pi-core');
    const stdout = exec(
      'node',
      [BUILDER, '--role', 'pi/core', '--output', out],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.ok(stdout.includes('staged pi/core'), 'role staging must report the staged role');
    assert.ok(
      fs.existsSync(path.join(out, 'cli/commands/lifecycle.js')),
      'staged core must contain cli/commands/lifecycle.js',
    );
    assert.ok(
      fs.existsSync(path.join(out, 'cli/lib/lifecycle-transition.js')),
      'staged core must contain cli/lib/lifecycle-transition.js',
    );
    require(path.join(out, 'cli', 'index.js'));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('staged Core roles include lifecycle dispatch dependencies and load their CLI entries', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't4-core-dispatcher-'));
  try {
    for (const role of ['pi/core', 'claude/core']) {
      const out = path.join(parent, role.replace('/', '-'));
      const stdout = execFileSync('node', [BUILDER, '--role', role, '--output', out], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      assert.ok(stdout.includes(`staged ${role}`), `${role} must be staged`);
      assert.ok(
        fs.existsSync(path.join(out, 'cli/lib/lifecycle-dispatch.js')),
        `${role} staged Core must include cli/lib/lifecycle-dispatch.js`,
      );
      assert.ok(
        fs.existsSync(path.join(out, 'cli/lib/lifecycle-lock.js')),
        `${role} staged Core must include cli/lib/lifecycle-lock.js`,
      );
      assert.doesNotThrow(
        () => require(path.join(out, 'cli', 'index.js')),
        `${role} staged CLI entry must load with its lifecycle dispatcher`,
      );
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('Enterprise runtime is staged only in Enterprise roles and selected for the v4 package', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't7-enterprise-surfaces-'));
  try {
    const staged = {};
    for (const role of EXPECTED_ROLES) {
      const out = path.join(parent, role.replace('/', '-'));
      execFileSync('node', [BUILDER, '--role', role, '--output', out], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      staged[role] = ENTERPRISE_RUNTIME_FILES.filter((rel) =>
        fs.existsSync(path.join(out, rel)),
      );
    }

    const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const packed = new Set((JSON.parse(packJson)[0].files || []).map((file) => file.path));
    const packedRuntime = ENTERPRISE_RUNTIME_FILES.filter((rel) => packed.has(rel));

    assert.deepEqual(
      {
        staged,
        packed: packedRuntime,
      },
      {
        staged: {
          'pi/core': [],
          'pi/enterprise': ENTERPRISE_RUNTIME_FILES,
          'claude/core': [],
          'claude/enterprise': ENTERPRISE_RUNTIME_FILES,
        },
        packed: ENTERPRISE_RUNTIME_FILES,
      },
      'all six T7 runtime modules must ship in both Enterprise roles and the package, never in Core',
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('scripts/build-surfaces.js validates the manifest against a fixture source tree', () => {
  const src = makeFixtureSource();
  try {
    const out = execFileSync(
      'node',
      [BUILDER, '--validate', '--source', src],
      { cwd: ROOT, encoding: 'utf8' },
    );
    for (const name of EXPECTED_ROLES) {
      assert.ok(out.includes(name), `builder validation output must mention ${name}`);
    }
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('manifest staging rejects missing, duplicate, or forbidden fixture entries before partial output', () => {
  const { execFileSync: exec } = require('node:child_process');

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

  // Case A: a declared include is missing — validation fails before replacing the target.
  {
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

  // Case B: a source is owned by two roles — staging fails with the offending path.
  {
    const src = makeFixtureSource();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 't5-stage-dup-'));
    try {
      // Plant the Core-owned cli/commands/log.js into the enterprise include tree
      // via a synthetic manifest that double-owns it.
      const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
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

  // Case C: forbidden content is present — staging fails with role + marker.
  {
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

  // Positive control: deterministic same-root atomic staging for a valid role.
  {
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
});

test('package metadata and role staging use v4 release inputs', () => {
  const { execFileSync: exec } = require('node:child_process');

  // `node scripts/build-surfaces.js --role pi/core --output <dir>` stages Core.
  {
    const src = makeFixtureSource();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't5-c3-role-'));
    try {
      const out = path.join(parent, 'pi-core');
      const stdout = exec(
        'node',
        [BUILDER, '--role', 'pi/core', '--output', out, '--source', src],
        { cwd: ROOT, encoding: 'utf8' },
      );
      assert.ok(stdout.includes('staged pi/core'), 'role staging must report the staged role');
      assert.ok(fs.existsSync(path.join(out, 'cli/commands/log.js')), 'staged core must carry core CLI modules');
      assert.ok(fs.existsSync(path.join(out, 'cli/commands/lifecycle.js')), 'staged core must carry the lifecycle command module');
      assert.ok(fs.existsSync(path.join(out, 'cli/lib/lifecycle-transition.js')), 'staged core must carry the lifecycle transition module');
      assert.ok(!fs.existsSync(path.join(out, 'skills/create-pr')), 'staged core must not carry the enterprise skill');
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }

  // `rebuild-skills.sh` rebuilds archives without a wildcard: it consumes the
  // manifest include list instead of iterating every directory implicitly.
  {
    const text = fs.readFileSync(path.join(ROOT, 'rebuild-skills.sh'), 'utf8');
    assert.ok(
      text.includes('surfaces.json') || text.includes('build-surfaces'),
      'rebuild-skills.sh must consume the surface manifest',
    );
    assert.ok(
      !/for skill_dir in "\$SKILLS_DIR"\//.test(text),
      'rebuild-skills.sh must not rebuild via an implicit wildcard directory loop',
    );
  }

  // The explicit package file list carries no wildcard ownership.
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '4.0.0');
    for (const entry of pkg.files || []) {
      assert.ok(
        entry !== 'skills/**' && entry !== 'skills/*' && entry !== 'cli/**',
        `package file list must not rely on wildcard ownership (got ${entry})`,
      );
    }
    assert.ok(
      (pkg.files || []).includes('surfaces.json'),
      'package file list must ship the surface manifest',
    );
    // The packed tarball must carry the release archives and mode dotfiles:
    // at least one .skill archive and one .skillkit-mode dotfile.
    {
      const packJson = exec('npm', ['pack', '--dry-run', '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const packed = (JSON.parse(packJson)[0].files || []).map((f) => f.path);
      assert.ok(
        packed.some((p) => p.endsWith('.skill')),
        'packed tarball must include at least one .skill archive',
      );
      assert.ok(
        packed.some((p) => p.endsWith('.skillkit-mode')),
        'packed tarball must include at least one .skillkit-mode dotfile',
      );
      assert.ok(
        packed.includes('skills/pocket-development/pocket-development.skill'),
        'packed tarball must include the pocket-development archive',
      );
      assert.ok(
        packed.includes('skills/pocket-development/.skillkit-mode'),
        'packed tarball must include the pocket-development .skillkit-mode dotfile',
      );
    }
  }

  // Both Claude host manifests consume the manifest without wildcard ownership.
  for (const name of ['plugin.json', 'marketplace.json']) {
    const doc = JSON.parse(
      fs.readFileSync(path.join(ROOT, '.claude-plugin', name), 'utf8'),
    );
    const text = JSON.stringify(doc);
    assert.ok(
      text.includes('surfaces.json') || text.includes('claude/core') || text.includes('surface_manifest'),
      `${name} must consume the surface manifest`,
    );
    assert.ok(
      !text.includes('skills/**'),
      `${name} must not rely on wildcard ownership`,
    );
  }

  // `rebuild-skills.sh` runs in a temporary copy: archives still generate.
  {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 't5-c3-rebuild-'));
    try {
      for (const entry of ['skills', 'surfaces.json', 'scripts', 'cli', 'enterprise', 'assets', 'llms.txt', 'README.md', 'LICENSE', 'rebuild-skills.sh']) {
        exec('cp', ['-r', path.join(ROOT, entry), path.join(copy, entry)], { encoding: 'utf8' });
      }
      const rebuildOut = exec('bash', [path.join(copy, 'rebuild-skills.sh')], { cwd: copy, encoding: 'utf8' });
      const archives = exec('find', [path.join(copy, 'skills'), '-name', '*.skill'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      assert.ok(archives.length > 0, 'rebuild in a temporary copy must still generate archives');
      // The manifest union must include pocket-development (declared only via
      // per-file includes), and its archive must be rebuilt by the script.
      const skillDirs = exec(
        'node',
        ['-e', 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync("surfaces.json","utf8"));const d=new Set();for(const r of Object.values(m.roles||{})){for(const i of r.includes||[]){const x=/^(skills\\/[^/]+)(?:\\/|$)/.exec(i);if(x)d.add(x[1]);}}console.log([...d].sort().join("\\n"));'],
        { cwd: ROOT, encoding: 'utf8' },
      ).split('\n').filter(Boolean);
      assert.ok(
        skillDirs.includes('skills/pocket-development'),
        'manifest skill-dir union must include pocket-development',
      );
      assert.ok(
        rebuildOut.includes('skills/pocket-development/pocket-development.skill'),
        'rebuild-skills.sh must rebuild the pocket-development archive',
      );
      assert.ok(
        fs.existsSync(path.join(copy, 'skills/pocket-development/pocket-development.skill')),
        'pocket-development archive must exist after rebuild',
      );
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }
});

