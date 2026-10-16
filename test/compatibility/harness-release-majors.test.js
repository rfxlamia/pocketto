'use strict';

// Release-major pinning for the wave-1 harness roles (plan §5.4):
// new roles land on surface schema 1 / release major 4 — the same release
// line as the existing roles — and wave 1 adds core roles only
// (enterprise overlays are wave 2, plan §3.3).
//
// TDD RED on the baseline: the roles are not declared yet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'cli', 'lib', 'surface-manifest.js');
const MANIFEST_PATH = path.join(ROOT, 'surfaces.json');
const NEW_CORE_ROLES = ['copilot/core', 'codex/core', 'gemini/core', 'agents/core'];

test('wave-1 harness roles are pinned to surface schema 1 / release major 4', () => {
  const { loadManifest } = require(LIB);
  const manifest = loadManifest(MANIFEST_PATH);
  assert.equal(manifest.schema, 1, 'surface schema must stay 1');
  assert.equal(manifest.release && manifest.release.major, 4, 'release major must stay 4');
  for (const role of NEW_CORE_ROLES) {
    assert.ok(manifest.roles[role], `role ${role} must be declared in surfaces.json`);
    assert.equal(manifest.roles[role].kind, 'core', `${role}: wave 1 adds core roles only`);
  }
});
