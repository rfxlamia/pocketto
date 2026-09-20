// T5 Cycle 1 — explicit four-role surface manifest (integration).
// Given a synthetic source fixture and the canonical manifest,
// When the surface manifest is loaded,
// Then it contains exactly pi/core, pi/enterprise, claude/core, claude/enterprise,
// each with explicit includes/requires/forbidden_paths/forbidden_content;
// Enterprise roles require matching Core roles, no role relies on skills/**,
// and ownership classifies the 8 named CLI modules.

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

const NAMED_CLI_MODULES = [
  'cli/commands/mode.js',
  'cli/lib/mode.js',
  'cli/commands/meta.js',
  'cli/lib/meta.js',
  'cli/commands/format.js',
  'cli/lib/bodies.js',
  'cli/lib/identity.js',
  'cli/lib/reconcile.js',
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

test('package major is 4.0.0', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '4.0.0');
});
