'use strict';

// Wave-1 role contract extensions (plan §5.1):
//  - surfaces.json must declare every planned wave-1 role
//    (TDD RED until surfaces.json + cli/lib/surface-manifest.js EXPECTED_ROLES
//    are extended together);
//  - every role name follows the <host>/<kind> convention;
//  - the requires-pair invariant holds generically: each <host>/enterprise
//    requires exactly [<host>/core], each <host>/core requires nothing.
//    Generic, so wave-2 enterprise overlays are covered without new tests.
//
// NOTE: these tests read the manifest through loadManifest (the production
// loader), not by raw JSON.parse, so the planned-roles assertion also proves
// the production EXPECTED_ROLES constant was extended.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LIB, MANIFEST_PATH } = require('./shared');
const { PLANNED_ROLES } = require('./harness-shared');

const ROLE_NAME_RE = /^[a-z-]+\/(core|enterprise)$/;

function loadManifestRoles() {
  const { loadManifest } = require(LIB);
  return loadManifest(MANIFEST_PATH).roles;
}

test('planned wave-1 roles are all declared in surfaces.json', () => {
  const roles = loadManifestRoles();
  const actual = Object.keys(roles).sort();
  assert.deepEqual(
    actual,
    [...PLANNED_ROLES].sort(),
    'surfaces.json must declare every planned wave-1 role (pi/*, claude/*, copilot/core, codex/core, gemini/core, agents/core)',
  );
});

test('every role name follows the <host>/<kind> convention', () => {
  const roles = loadManifestRoles();
  for (const name of Object.keys(roles)) {
    assert.match(name, ROLE_NAME_RE, `role name must match ${ROLE_NAME_RE}: ${name}`);
    const [host, kind] = name.split('/');
    assert.equal(roles[name].host, host, `${name}: host field must match the name prefix`);
    assert.equal(roles[name].kind, kind, `${name}: kind field must match the name suffix`);
  }
});

test('requires-pair invariant: <host>/enterprise requires [<host>/core], core requires nothing', () => {
  const roles = loadManifestRoles();
  for (const [name, role] of Object.entries(roles)) {
    const [host, kind] = name.split('/');
    if (kind === 'enterprise') {
      assert.deepEqual(
        role.requires,
        [`${host}/core`],
        `${name}: enterprise role must require exactly ${host}/core`,
      );
      assert.ok(roles[`${host}/core`], `${name}: required core role ${host}/core must be declared`);
    } else {
      assert.deepEqual(role.requires, [], `${name}: core role must require nothing`);
    }
  }
});
