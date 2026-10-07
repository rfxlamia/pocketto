'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FORBIDDEN_CORE_PATHS,
  ROOT,
  findForbiddenPaths,
  posixPath,
  scanMarkdown,
  stageRole,
  walkFiles,
  withTemporaryDirectory,
} = require('../surface-test-utils');

const CORE_ROLES = ['pi/core', 'claude/core'];
const CORE_SKILLS = [
  'pocket-grinding',
  'pocket-init',
  'pocket-help',
  'pocket-development',
  'pocket-closing',
];

function scanCoreRole(roleDir, roleName) {
  const files = walkFiles(path.join(roleDir, 'skills'));
  const paths = files.map((file) => posixPath(path.relative(roleDir, file)));
  return {
    paths,
    pathViolations: findForbiddenPaths(paths, FORBIDDEN_CORE_PATHS),
    ...scanMarkdown(roleDir, roleName, { include: (rel) => rel.startsWith('skills/') }),
  };
}

function stageCoreRoles(temp) {
  const staged = new Map();
  for (const role of CORE_ROLES) {
    const output = path.join(temp, role.replace('/', '-'));
    stageRole(ROOT, role, output);
    staged.set(role, scanCoreRole(output, role));
  }
  return staged;
}

function assertCoreRolesRemainStaged(temp, staged) {
  for (const [role, result] of staged) {
    assert.deepEqual(result.pathViolations, [], `${role}: Enterprise skill/reference paths must be absent`);
    assert.deepEqual(result.contentViolations, [], `${role}: Enterprise instructions and remote data must be absent`);
    assert.deepEqual(result.citationViolations, [], `${role}: every active citation must resolve inside Core`);
    const output = path.join(temp, role.replace('/', '-'));
    for (const skill of CORE_SKILLS) {
      assert.ok(
        fs.existsSync(path.join(output, 'skills', skill, 'SKILL.md')),
        `${role}: Core skill ${skill} must remain staged`,
      );
    }
  }
}

function recordingRunner() {
  const calls = [];
  return {
    calls,
    cli(args) {
      calls.push(`cli:${args.join(' ')}`);
    },
    remote(command) {
      calls.push(`remote:${command}`);
    },
    skill(name) {
      calls.push(`skill:${name}`);
    },
  };
}

function executeGrindingHandoffFixture(skillText, runner, fixture) {
  const operations = [];
  const patterns = [
    {
      type: 'cli',
      expression: /pocketto-pi\s+lifecycle\s+transition\s+[^\n`]*\bspec-approved\b/g,
    },
    { type: 'remote', expression: /gh\s+issue\s+create\b[^\n`]*/g },
    { type: 'skill', expression: /(?:\/pocketto:pocket-planning\b|### Invoke pocket-planning\b)[^\n`]*/g },
  ];
  for (const { type, expression } of patterns) {
    for (const match of skillText.matchAll(expression)) {
      operations.push({ type, position: match.index, text: match[0] });
    }
  }
  operations.sort((left, right) => left.position - right.position);
  for (const operation of operations) {
    if (operation.type === 'cli') {
      runner.cli(['lifecycle', 'transition', fixture.specDir, 'spec-approved']);
    } else if (operation.type === 'remote') {
      runner.remote(operation.text);
    } else {
      runner.skill('pocket-planning', fixture.specFile);
    }
  }
}

function assertNeutralLifecycleAndHandoff(temp) {
  const piCore = path.join(temp, 'pi-core');
  const grinding = fs.readFileSync(path.join(piCore, 'skills/pocket-grinding/SKILL.md'), 'utf8');
  const development = fs.readFileSync(path.join(piCore, 'skills/pocket-development/SKILL.md'), 'utf8');
  const closing = fs.readFileSync(path.join(piCore, 'skills/pocket-closing/SKILL.md'), 'utf8');
  const lifecycleText = `${grinding}\n${development}\n${closing}`;

  for (const event of ['spec-approved', 'phase-complete', 'plan-closed']) {
    assert.ok(lifecycleText.includes(event), `Core must retain the neutral ${event} lifecycle event`);
  }
  for (const artifactRef of ['lifecycle.json', 'artifact_refs', '--artifact']) {
    assert.ok(lifecycleText.includes(artifactRef), `Core must retain lifecycle artifact reference ${artifactRef}`);
  }
  assert.match(
    lifecycleText,
    /lifecycle\s+repair[\s\S]*lifecycle\s+drain|lifecycle\s+drain[\s\S]*lifecycle\s+repair/,
    'Core must retain local-first lifecycle repair and drain guidance',
  );

  const runner = recordingRunner();
  executeGrindingHandoffFixture(grinding, runner, {
    specDir: '/tmp/approved-spec',
    specFile: '/tmp/approved-spec/feature.md',
  });
  assert.deepEqual(
    runner.calls,
    ['cli:lifecycle transition /tmp/approved-spec spec-approved', 'skill:pocket-planning'],
    'the approved-spec handoff must emit spec-approved before planning and make no remote call',
  );
}

test('Core role staging excludes Enterprise instructions and runs the neutral grinding handoff', () =>
  withTemporaryDirectory('t6-core-surfaces-', (temp) => {
    const staged = stageCoreRoles(temp);
    assertCoreRolesRemainStaged(temp, staged);
    assertNeutralLifecycleAndHandoff(temp);
  }),
);
