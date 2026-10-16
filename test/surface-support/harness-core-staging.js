'use strict';

// Wave-1 harness Core staging assertions (plan §5.1).
//
// Each new Core role is staged through scripts/build-surfaces.js and checked:
//  - it stages exactly the claude/core skill entrypoint set (14 on the
//    baseline; derived at runtime, never hard-coded, so skill additions flow
//    through without editing this file);
//  - no Pi-only runtime module leaks in (plan §5.3, e.g.
//    cli/commands/setup-extensions.js);
//  - no enterprise paths and no enterprise content markers leak in
//    (the role's own forbidden_paths / forbidden_content from surfaces.json).
//
// TDD RED on the baseline: the builder rejects unknown roles with
// SURFACE_ROLE_INVALID until the roles are implemented.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./shared');
const { NEW_CORE_ROLES, PI_ONLY_PATHS } = require('./harness-shared');
const {
  expandManifestIncludes,
  posixPath,
  readSurfaceManifest,
  stageRole,
  walkFiles,
  withTemporaryDirectory,
} = require('../../test-support/surface-test-utils');

const SKILL_ENTRYPOINT_RE = /^skills\/[^/]+\/SKILL\.md$/;

function skillEntrypoints(stagedDir) {
  return walkFiles(path.join(stagedDir, 'skills'))
    .filter((file) => path.basename(file) === 'SKILL.md')
    .map((file) => posixPath(path.relative(stagedDir, file)))
    .sort();
}

function expectedCoreSkillEntrypoints() {
  const manifest = readSurfaceManifest(ROOT);
  return expandManifestIncludes(manifest.roles['claude/core'].includes, ROOT)
    .filter((rel) => SKILL_ENTRYPOINT_RE.test(rel))
    .sort();
}

function assertNoForbiddenPaths(role, roleDef, stagedDir) {
  const staged = walkFiles(stagedDir).map((file) => posixPath(path.relative(stagedDir, file)));
  for (const forbidden of roleDef.forbidden_paths) {
    const leaked = staged.filter((rel) => rel === forbidden || rel.startsWith(forbidden));
    assert.deepEqual(leaked, [], `${role}: forbidden path staged: ${forbidden}`);
  }
}

function assertNoForbiddenContent(role, roleDef, stagedDir) {
  const staged = walkFiles(stagedDir).map((file) => posixPath(path.relative(stagedDir, file)));
  for (const marker of roleDef.forbidden_content) {
    for (const rel of staged) {
      const full = path.join(stagedDir, rel);
      if (!fs.statSync(full).isFile()) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue; // binary; skip content scan
      }
      assert.ok(!text.includes(marker), `${role}: forbidden content '${marker}' in ${rel}`);
    }
  }
}

test('wave-1 harness Core roles stage the claude/core skill set with no Pi-only or enterprise leakage', () =>
  withTemporaryDirectory('t-harness-core-staging-', (temp) => {
    const expectedSkills = expectedCoreSkillEntrypoints();
    assert.ok(expectedSkills.length > 0, 'claude/core must stage at least one skill entrypoint');
    const manifest = readSurfaceManifest(ROOT);
    for (const role of NEW_CORE_ROLES) {
      const output = path.join(temp, role.replace('/', '-'));
      // Throws SURFACE_ROLE_INVALID on the baseline — the TDD red state.
      stageRole(ROOT, role, output);
      const roleDef = manifest.roles[role];
      assert.ok(roleDef, `${role}: role must be declared in surfaces.json`);

      assert.deepEqual(
        skillEntrypoints(output),
        expectedSkills,
        `${role}: staged skill entrypoints must equal claude/core's set`,
      );
      for (const rel of PI_ONLY_PATHS) {
        assert.ok(
          !fs.existsSync(path.join(output, rel)),
          `${role}: Pi-only module ${rel} must not leak into harness staging`,
        );
      }
      assertNoForbiddenPaths(role, roleDef, output);
      assertNoForbiddenContent(role, roleDef, output);
    }
  }),
);
