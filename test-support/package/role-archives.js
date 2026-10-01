'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  FORBIDDEN_CORE_CONTENT,
  FORBIDDEN_CORE_PATHS,
  ROOT,
  findForbiddenPaths,
  inspectRoleArchive,
  posixPath,
  scanMarkdown,
  stageRole,
  walkFiles,
  withTemporaryDirectory,
} = require('../surface-test-utils');
const { packedPaths, withPackedPackage } = require('./fixture');

const CORE_ARCHIVES = [
  'skills/pocket-development/pocket-development.skill',
  'skills/pocket-closing/pocket-closing.skill',
  'skills/pocket-grinding/pocket-grinding.skill',
  'skills/pocket-init/pocket-init.skill',
  'skills/pocket-help/pocket-help.skill',
];
const ENTERPRISE_ARCHIVES = [
  'skills/create-pr/create-pr.skill',
  'skills/pocket-enterprise/pocket-enterprise.skill',
];

function assertRequiredArchivesArePacked(extracted) {
  const packed = packedPaths(extracted);
  for (const archive of [...CORE_ARCHIVES, ...ENTERPRISE_ARCHIVES]) {
    assert.ok(packed.has(archive), `npm pack must include role archive ${archive}`);
  }
}

function stageRolePair(stagedRoot, coreRole, enterpriseRole) {
  const staged = {};
  for (const role of [coreRole, enterpriseRole]) {
    const root = path.join(stagedRoot, role.replace('/', '-'));
    stageRole(ROOT, role, root);
    staged[role] = {
      root,
      files: walkFiles(root).map((file) => posixPath(path.relative(root, file))).sort(),
    };
  }
  return staged;
}

function stageRolePairs(stagedRoot) {
  const staged = new Map();
  for (const [coreRole, enterpriseRole] of [
    ['pi/core', 'pi/enterprise'],
    ['claude/core', 'claude/enterprise'],
  ]) {
    staged.set(coreRole, stageRolePair(stagedRoot, coreRole, enterpriseRole));
  }
  return staged;
}

function assertEnterpriseDelta(coreRole, roles) {
  const enterpriseRole = coreRole.replace('/core', '/enterprise');
  const duplicateSkills = roles[enterpriseRole].files
    .filter((rel) => rel.startsWith('skills/'))
    .filter((rel) => roles[coreRole].files.includes(rel));
  assert.deepEqual(duplicateSkills, [], `${coreRole}: Enterprise delta must not copy Core skills`);

  const reportingPath = 'skills/pocket-development/references/enterprise-reporting.md';
  assert.ok(roles[enterpriseRole].files.includes(reportingPath), `${coreRole}: reporting reference must be available in Enterprise`);
  assert.ok(!roles[coreRole].files.includes(reportingPath), `${coreRole}: reporting reference must not be staged in Core`);
  assert.deepEqual(
    findForbiddenPaths(roles[coreRole].files, FORBIDDEN_CORE_PATHS),
    [],
    `${coreRole}: Enterprise-owned paths must be absent from Core`,
  );
}

function assertRoleMarkdown(role, stagedRole, forbiddenContent, selectedPaths) {
  const scan = scanMarkdown(stagedRole.root, role, { forbiddenContent, availablePaths: selectedPaths });
  assert.deepEqual(scan.contentViolations, [], `${role}: forbidden Enterprise content must be absent`);
  assert.deepEqual(scan.citationViolations, [], `${role}: citations must resolve within the selected roles`);
}

function assertRoleCitationsAndCoreContent(coreRole, roles) {
  const enterpriseRole = coreRole.replace('/core', '/enterprise');
  const selectedPaths = new Set([...roles[coreRole].files, ...roles[enterpriseRole].files]);
  for (const role of [coreRole, enterpriseRole]) {
    const forbiddenContent = role === coreRole ? FORBIDDEN_CORE_CONTENT : [];
    assertRoleMarkdown(role, roles[role], forbiddenContent, selectedPaths);
  }
  return selectedPaths;
}

function assertArchiveLeaksAbsent(extracted, coreRole, selectedPaths) {
  const coreLeaks = CORE_ARCHIVES.flatMap((archiveRel) =>
    inspectRoleArchive(path.join(extracted, archiveRel), archiveRel, selectedPaths, {
      forbiddenPaths: FORBIDDEN_CORE_PATHS,
      forbiddenContent: FORBIDDEN_CORE_CONTENT,
    }),
  );
  const enterpriseLeaks = ENTERPRISE_ARCHIVES.flatMap((archiveRel) =>
    inspectRoleArchive(path.join(extracted, archiveRel), archiveRel, selectedPaths),
  );
  assert.deepEqual(
    [...coreLeaks, ...enterpriseLeaks],
    [],
    `${coreRole}: bundled role archives must contain only their role-owned paths/content`,
  );
}

function assertRolePair(extracted, coreRole, roles) {
  assertEnterpriseDelta(coreRole, roles);
  const selectedPaths = assertRoleCitationsAndCoreContent(coreRole, roles);
  assertArchiveLeaksAbsent(extracted, coreRole, selectedPaths);
}

test('packed role archives keep Core forbidden-content out and Enterprise additive', () =>
  withPackedPackage(ROOT, (extracted) =>
    withTemporaryDirectory('pocketto-role-pack-', (stagedRoot) => {
      assertRequiredArchivesArePacked(extracted);
      const staged = stageRolePairs(stagedRoot);
      for (const [coreRole, roles] of staged) assertRolePair(extracted, coreRole, roles);
    }),
  ),
);
