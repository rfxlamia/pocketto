'use strict';

// Skill-set parity across Core roles (plan §5.2): every wave-1 harness Core
// role must stage exactly the same skill entrypoint set as claude/core.
// Any silent drift (a skill added to one role but not the others) fails here.
//
// TDD RED on the baseline: staging an undeclared role throws
// SURFACE_ROLE_INVALID until the roles are implemented.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  ROOT,
  posixPath,
  stageRole,
  walkFiles,
  withTemporaryDirectory,
} = require('../surface-test-utils');
const { NEW_CORE_ROLES } = require('../../test/surface-support/harness-shared');

function stagedSkillNames(roleDir) {
  return walkFiles(path.join(roleDir, 'skills'))
    .filter((file) => path.basename(file) === 'SKILL.md')
    .map((file) => posixPath(path.relative(path.join(roleDir, 'skills'), path.dirname(file))))
    .sort();
}

test('harness Core roles stage exactly the claude/core skill set (no silent drift)', () =>
  withTemporaryDirectory('t6-harness-parity-', (temp) => {
    const reference = path.join(temp, 'claude-core');
    stageRole(ROOT, 'claude/core', reference);
    const expected = stagedSkillNames(reference);
    assert.ok(expected.length > 0, 'claude/core must stage at least one skill entrypoint');
    for (const role of NEW_CORE_ROLES) {
      const output = path.join(temp, role.replace('/', '-'));
      // Throws SURFACE_ROLE_INVALID on the baseline — the TDD red state.
      stageRole(ROOT, role, output);
      assert.deepEqual(
        stagedSkillNames(output),
        expected,
        `${role}: staged skill set must be identical to claude/core's`,
      );
    }
  }),
);
