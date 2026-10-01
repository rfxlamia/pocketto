const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { BUILDER, ROOT, makeFixtureSource } = require('./shared');

const exec = execFileSync;

function assertCoreRoleUsesV4ReleaseInputs() {
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

function assertArchiveRebuildConsumesTheManifest() {
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

function assertExplicitPackageListIncludesReleaseAssets() {
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

function assertClaudeManifestsUseExplicitSurfaces() {
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
}

function assertRebuildWorksInTemporaryCopy() {
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

test('package metadata and role staging use v4 release inputs', () => {
  assertCoreRoleUsesV4ReleaseInputs();
  assertArchiveRebuildConsumesTheManifest();
  assertExplicitPackageListIncludesReleaseAssets();
  assertClaudeManifestsUseExplicitSurfaces();
  assertRebuildWorksInTemporaryCopy();
});
