'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  FORBIDDEN_CORE_PATHS,
  ROOT,
  assertArchiveMatchesSource,
  findForbiddenPaths,
  posixPath,
  readSurfaceManifest,
  scanMarkdown,
  stageRole,
  walkFiles,
  withTemporaryDirectory,
} = require('../surface-test-utils');

const ROLE_PAIRS = [
  ['pi/core', 'pi/enterprise'],
  ['claude/core', 'claude/enterprise'],
];
const ENTERPRISE_SKILL_DELTA = [
  'skills/create-pr/SKILL.md',
  'skills/create-pr/create-pr.skill',
  'skills/pocket-development/references/enterprise-reporting.md',
  'skills/pocket-enterprise/SKILL.md',
  'skills/pocket-enterprise/pocket-enterprise.skill',
  'skills/pocket-enterprise/references/issue-reconciliation.md',
  'skills/pocket-enterprise/references/lifecycle-contract.md',
  'skills/pocket-enterprise/references/onboarding.md',
  'skills/pocket-enterprise/references/phase-reconciliation.md',
];
const TASK_ARCHIVES = [
  'skills/pocket-development/pocket-development.skill',
  'skills/pocket-closing/pocket-closing.skill',
  'skills/pocket-grinding/pocket-grinding.skill',
  'skills/pocket-init/pocket-init.skill',
  'skills/pocket-help/pocket-help.skill',
  'skills/create-pr/create-pr.skill',
  'skills/pocket-enterprise/pocket-enterprise.skill',
];
const V3_SNAPSHOT_SHA256 = {
  'skills/pocket-grinding/SKILL.md': 'f6b509bb429500e1229bc411c78cde8d92e39f3907c71d9635a81c54ba9fd481',
  'skills/pocket-init/SKILL.md': 'bbee2ba8865a88709d473d4d90e7bc8f98576990cf9acf139ddd647013cbb496',
  'skills/pocket-help/SKILL.md': '8571fdac961901166c5728603bad19bc457e40680d25f09bc35697e120d1bc07',
  'skills/pocket-help/references/end-to-end-flow.md': '0206ee599eb9ebd9ce5e392d0d267f44e3556f7d89b7751a477830b1c9ffd7ce',
  'skills/pocket-help/references/skill-map.md': '38a97a1abc851429e9a74c1cdd33427567652f1b46ca754b590d80b619c8ccad',
  'skills/pocket-development/SKILL.md': 'b79a6fa416afe37deca50160c9eb1691e64480b649ba535570265f87a009538e',
  'skills/pocket-development/references/enterprise-reporting.md': '947dbbc3e7ef7c6909edb9693a8c49a423f25d504376fcd069116782c5d5bbb1',
  'skills/pocket-closing/SKILL.md': '82461db8b9d20384471c435eca5515e9c653a55d0cb79405fef7ef99afa266b6',
  'skills/create-pr/SKILL.md': '8344a61191f585bd54428882d72030dd4a0731deac3e9bce821d2b0f9c627bc1',
};

function stagedPaths(root) {
  return walkFiles(root).map((file) => posixPath(path.relative(root, file))).sort();
}

function stageRolePair(temp, coreRole, enterpriseRole) {
  const coreOut = path.join(temp, coreRole.replace('/', '-'));
  const enterpriseOut = path.join(temp, enterpriseRole.replace('/', '-'));
  stageRole(ROOT, coreRole, coreOut);
  stageRole(ROOT, enterpriseRole, enterpriseOut);
  return {
    coreOut,
    core: stagedPaths(coreOut),
    enterprise: stagedPaths(enterpriseOut),
  };
}

function stageRolePairs(temp) {
  const staged = new Map();
  for (const [coreRole, enterpriseRole] of ROLE_PAIRS) {
    staged.set(enterpriseRole, stageRolePair(temp, coreRole, enterpriseRole));
  }
  return staged;
}

function assertManifestOwnership(manifest, role, coreRole) {
  assert.deepEqual(manifest.roles[role].requires, [coreRole], `${role}: the matching Core role must be required`);
  assert.ok(manifest.roles[role].includes.includes('skills/pocket-enterprise/**'), `${role}: adapter source must be manifest-owned`);
  for (const forbidden of FORBIDDEN_CORE_PATHS) {
    assert.ok(manifest.roles[coreRole].forbidden_paths.includes(forbidden), `${coreRole}: ${forbidden} must be explicitly forbidden`);
  }
}

function assertAdditiveRoleDelta(role, coreRole, staged, manifest) {
  assertManifestOwnership(manifest, role, coreRole);
  const actualDelta = staged.enterprise.filter((file) => file.startsWith('skills/')).sort();
  assert.deepEqual(actualDelta, [...ENTERPRISE_SKILL_DELTA].sort(), `${role}: Enterprise skill files must be an explicit additive delta`);

  const copiedCoreSkills = actualDelta.filter((file) => staged.core.includes(file));
  assert.deepEqual(copiedCoreSkills, [], `${role}: Enterprise must not copy any Core skill source`);
  const forbiddenCorePaths = findForbiddenPaths(staged.core);
  assert.deepEqual(forbiddenCorePaths, [], `${coreRole}: Enterprise-owned paths must be absent`);
  const scan = scanMarkdown(staged.coreOut, coreRole);
  assert.deepEqual(
    [...scan.contentViolations, ...scan.citationViolations],
    [],
    `${role}: Core Markdown must contain no Enterprise-only path/content and all citations must stay in Core`,
  );
}

function assertAllRoleDeltas(staged) {
  const manifest = readSurfaceManifest(ROOT);
  for (const [role, roleFiles] of staged) {
    const coreRole = role.replace('/enterprise', '/core');
    assertAdditiveRoleDelta(role, coreRole, roleFiles, manifest);
  }
}

function assertV3SnapshotIsUnchanged() {
  for (const [rel, expectedHash] of Object.entries(V3_SNAPSHOT_SHA256)) {
    const snapshot = execFileSync('git', ['show', `v3.1.3:${rel}`]);
    const actualHash = createHash('sha256').update(snapshot).digest('hex');
    assert.equal(actualHash, expectedHash, `v3.1.3 source snapshot changed for ${rel}`);
  }
}

function assertTaskArchivesMatchSources() {
  for (const rel of TASK_ARCHIVES) {
    const archive = path.join(ROOT, rel);
    assert.ok(fs.existsSync(archive), `required role archive is missing: ${rel}`);
    assertArchiveMatchesSource(archive, ROOT);
  }
}

test('Enterprise roles add only their adapter delta and preserve the immutable v3 source snapshot', () =>
  withTemporaryDirectory('t6-enterprise-surfaces-', (temp) => {
    const staged = stageRolePairs(temp);
    assertAllRoleDeltas(staged);
    assertV3SnapshotIsUnchanged();
    assertTaskArchivesMatchSources();
  }),
);
