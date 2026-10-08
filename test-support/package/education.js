'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, stageRole, withTemporaryDirectory } = require('../surface-test-utils');
const { expandIncludes, loadManifest } = require('../../cli/lib/surface-manifest');
const { packedPaths, withPackedPackage } = require('./fixture');

const EDUCATION_FILES = [
  'cli/commands/edu.js',
  'cli/lib/education.js',
  'skills/pocket-education/SKILL.md',
  'skills/pocket-education/pocket-education.skill',
  'skills/pocket-education/references/calibration.md',
  'skills/pocket-education/references/educational-review.md',
  'skills/pocket-education/references/hint-ladder.md',
  'skills/pocket-education/references/learning-journal.md',
  'skills/pocket-education/references/teaching-depth.md',
];

function assertEducationRoundTrip(packageRoot, project) {
  const cli = path.join(packageRoot, 'cli/index.js');
  function run(args) {
    const output = execFileSync(process.execPath, [cli, ...args, '--json', '--contract', '3'], {
      cwd: project, encoding: 'utf8',
    });
    return JSON.parse(output).data;
  }
  run(['edu', 'init', project, '--file', 'AGENTS.md', '--level', 'testing=foundation']);
  const profile = run(['edu', project]);
  assert.equal(profile.education, true);
  assert.equal(profile.skills.testing, 'foundation');
  run(['edu', 'set', project, '--level', 'testing=guided']);
  assert.equal(run(['edu', project]).skills.testing, 'guided');
}

for (const role of ['pi/core', 'claude/core']) {
  test(`${role} ships a working Education CLI without Enterprise`, () =>
    withTemporaryDirectory('education-core-', (temp) => {
      const manifest = loadManifest(path.join(ROOT, 'surfaces.json'));
      const included = new Set(expandIncludes(manifest.roles[role].includes, ROOT));
      for (const rel of EDUCATION_FILES) assert.ok(included.has(rel), `${role} must ship ${rel}`);
      const output = path.join(temp, 'core');
      stageRole(ROOT, role, output);
      assert.equal(fs.existsSync(path.join(output, 'cli/commands/mode.js')), false);
      const project = path.join(temp, 'project');
      fs.mkdirSync(project);
      assertEducationRoundTrip(output, project);
    }),
  );
}

test('npm package ships the complete Education skill and working CLI', () =>
  withPackedPackage(ROOT, (extracted) => {
    const files = packedPaths(extracted);
    for (const rel of EDUCATION_FILES) assert.ok(files.has(rel), `npm package must ship ${rel}`);
    withTemporaryDirectory('education-packed-', (project) => assertEducationRoundTrip(extracted, project));
  }),
);
