const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EXPECTED_ROLES, LIB, MANIFEST_PATH, NAMED_CLI_MODULES } = require('./shared');

function assertRoleContract(manifest) {
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
}

function assertManifestRelease(manifest) {
  assert.equal(manifest.schema, 1, 'manifest schema must be 1');
  assert.equal(
    manifest.release && manifest.release.major,
    4,
    'release major must be 4',
  );
  const roles = Object.keys(manifest.roles || {}).sort();
  assert.deepEqual(roles, [...EXPECTED_ROLES].sort(), 'exactly four roles required');
}

test('manifest declares exactly four explicit roles with no wildcard package surface', () => {
  const { loadManifest } = require(LIB);
  const manifest = loadManifest(MANIFEST_PATH);

  assertManifestRelease(manifest);
  assertRoleContract(manifest);
});
