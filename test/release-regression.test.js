'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FORBIDDEN_CORE_CONTENT,
  FORBIDDEN_CORE_PATHS,
  expectedRoleArchiveMembers,
  inspectRoleArchive,
  posixPath,
  scanMarkdown,
  skillArchivePaths,
  walkFiles,
} = require('../test-support/surface-test-utils');

const ROOT = path.resolve(__dirname, '..');
const BUILDER = path.join(ROOT, 'scripts', 'build-surfaces.js');
const RELEASE_ROLES = ['pi/core', 'pi/enterprise', 'claude/core', 'claude/enterprise'];
const PLAN = `# EXECUTION PLAN — Release rehearsal\n\n**Date:** 2026-09-19\n**Spec:** docs/pocket/spec/release-rehearsal.md\n\n## Pocket Packets\n\n---\n\n### Task 1: Verify release [prereq]\n\nRun the local release rehearsal.\n\n## Plan Summary\n\nVerify the local release rehearsal.\n`;

function walkRelativeFiles(root) {
  return walkFiles(root).map((file) => posixPath(path.relative(root, file))).sort();
}

function expandManifestIncludes(includes, sourceRoot) {
  const selected = new Set();
  const addTree = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '__pycache__') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) addTree(full);
      else if (entry.isFile()) selected.add(posixPath(path.relative(sourceRoot, full)));
    }
  };

  for (const include of includes) {
    const source = path.join(sourceRoot, include.endsWith('/**') ? include.slice(0, -3) : include);
    assert.ok(fs.existsSync(source), `manifest include must exist: ${include}`);
    if (fs.statSync(source).isDirectory()) addTree(source);
    else selected.add(posixPath(path.relative(sourceRoot, source)));
  }
  return [...selected].sort();
}

function assertManifestForbiddenContent(roleName, stagedRoot, files, markers) {
  for (const rel of files) {
    const full = path.join(stagedRoot, rel);
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const marker of markers) {
      assert.equal(text.includes(marker), false, `${roleName}: forbidden content ${JSON.stringify(marker)} in ${rel}`);
    }
  }
}

function makeOneUseTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pocketto-release-regression-'));
}

test('final v4 release rehearsal stages all roles and verifies the packed package, archives, and public CLI', () => {
  // T14 Cycle 1 — test/release-regression.test.js, integration.
  // Intent: Given complete v4 tree, when rehearsal stages all four roles and packs package, then package major/manifest/contract/pipeline values agree, role constraints pass, every archive matches manifest-selected role-owned source set, and no Enterprise-only content appears in Core. Exercise scripts/build-surfaces.js, npm pack, extracted package inspection, public CLI --version/--json; only temp staging/tarball dirs, no registry/GitHub network.
  // Expected RED from the task packet: current package/version tests expect contract 2 and a single mixed skills/** surface. This expectation is stale at the supplied base: v4 values/roles are already correct. Baseline result: pre-satisfied/green, not RED.
  // Exact command: node --test test/release-regression.test.js
  const temporaryRoot = makeOneUseTemporaryDirectory();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'surfaces.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.roles).sort(), [...RELEASE_ROLES].sort(), 'release manifest must declare exactly the four supported roles');
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.release.major, 4);

    const staged = new Map();
    for (const roleName of RELEASE_ROLES) {
      const output = path.join(temporaryRoot, roleName.replace('/', '-'));
      const stdout = execFileSync('node', [BUILDER, '--role', roleName, '--output', output, '--source', ROOT], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      assert.match(stdout, new RegExp(`^staged ${roleName.replace('/', '\\/')}: \\d+ files\\n$`), `${roleName}: builder must stage the requested role`);

      const expectedFiles = expandManifestIncludes(manifest.roles[roleName].includes, ROOT);
      const actualFiles = walkRelativeFiles(output);
      assert.deepEqual(actualFiles, expectedFiles, `${roleName}: staged files must equal its manifest-selected source set`);
      for (const rel of expectedFiles) {
        assert.deepEqual(
          fs.readFileSync(path.join(output, rel)),
          fs.readFileSync(path.join(ROOT, rel)),
          `${roleName}: staged source must match ${rel}`,
        );
      }

      const forbiddenPaths = manifest.roles[roleName].forbidden_paths;
      for (const forbidden of forbiddenPaths) {
        const leaked = actualFiles.filter((rel) => rel === forbidden || rel.startsWith(forbidden.endsWith('/') ? forbidden : `${forbidden}/`));
        assert.deepEqual(leaked, [], `${roleName}: forbidden path ${forbidden} must not be staged`);
      }
      assertManifestForbiddenContent(roleName, output, actualFiles, manifest.roles[roleName].forbidden_content);
      staged.set(roleName, { output, files: actualFiles });
    }

    const selectedPaths = new Set([...staged.values()].flatMap(({ files }) => files));
    for (const roleName of ['pi/core', 'claude/core']) {
      const { output } = staged.get(roleName);
      const scan = scanMarkdown(output, roleName, {
        forbiddenContent: FORBIDDEN_CORE_CONTENT,
        availablePaths: selectedPaths,
      });
      assert.deepEqual(scan.contentViolations, [], `${roleName}: Core Markdown must not contain Enterprise-only content`);
      assert.deepEqual(scan.citationViolations, [], `${roleName}: Core citations must resolve within the four selected role surfaces`);
    }

    const packDirectory = path.join(temporaryRoot, 'tarballs');
    const extractDirectory = path.join(temporaryRoot, 'extracted');
    fs.mkdirSync(packDirectory);
    fs.mkdirSync(extractDirectory);
    const packOutput = execFileSync('npm', [
      'pack',
      '--silent',
      '--offline',
      '--ignore-scripts',
      '--pack-destination',
      packDirectory,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_offline: 'true',
        npm_config_loglevel: 'silent',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
      },
    });
    const tarballs = fs.readdirSync(packDirectory).filter((entry) => entry.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, `npm pack must produce exactly one local tarball; output: ${packOutput.trim()}`);
    const tarball = path.join(packDirectory, tarballs[0]);
    execFileSync('tar', ['-xzf', tarball, '-C', extractDirectory], { encoding: 'utf8' });
    const extracted = path.join(extractDirectory, 'package');

    const packageJson = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
    const packedManifest = JSON.parse(fs.readFileSync(path.join(extracted, 'surfaces.json'), 'utf8'));
    const packedVersion = require(path.join(extracted, 'cli', 'lib', 'version.js'));
    assert.equal(packageJson.version, '4.0.0');
    assert.equal(packedManifest.schema, 1);
    assert.equal(packedManifest.release.major, 4);
    assert.deepEqual(Object.keys(packedManifest.roles).sort(), [...RELEASE_ROLES].sort());
    assert.deepEqual(
      {
        CLI_VERSION: packedVersion.CLI_VERSION,
        CONTRACT: packedVersion.CONTRACT,
        PIPELINE: packedVersion.PIPELINE,
        LIFECYCLE_SCHEMA: packedVersion.LIFECYCLE_SCHEMA,
        ADAPTER_CONTRACT: packedVersion.ADAPTER_CONTRACT,
        SURFACE_MANIFEST: packedVersion.SURFACE_MANIFEST,
      },
      {
        CLI_VERSION: '4.0.0',
        CONTRACT: 3,
        PIPELINE: 5,
        LIFECYCLE_SCHEMA: 1,
        ADAPTER_CONTRACT: 1,
        SURFACE_MANIFEST: 1,
      },
      'packed package and independent protocol versions must agree',
    );

    const stagedArchives = new Set([...staged.values()].flatMap(({ files }) => files.filter((rel) => rel.endsWith('.skill'))));
    const packedFiles = walkRelativeFiles(extracted);
    const packedArchives = packedFiles.filter((rel) => rel.endsWith('.skill')).sort();
    assert.ok(packedArchives.length > 0, 'packed package must contain role-owned skill archives');
    assert.deepEqual([...stagedArchives].sort(), packedArchives, 'packed archives must equal the union of manifest-selected role archives');

    for (const archiveRel of packedArchives) {
      const archivePath = path.join(extracted, archiveRel);
      const expectedMembers = expectedRoleArchiveMembers(archiveRel, manifest, ROOT);
      const actualMembers = skillArchivePaths(archivePath);
      assert.deepEqual(actualMembers, expectedMembers, `${archiveRel}: packed archive must match its manifest-selected role-owned source set`);
      for (const member of expectedMembers) {
        assert.deepEqual(
          execFileSync('unzip', ['-p', archivePath, member]),
          fs.readFileSync(path.join(ROOT, path.posix.dirname(archiveRel), member)),
          `${archiveRel}: packed member ${member} must match its selected source bytes`,
        );
      }

      if (staged.get('pi/core').files.includes(archiveRel) || staged.get('claude/core').files.includes(archiveRel)) {
        const coreForbiddenPaths = [...new Set([...FORBIDDEN_CORE_PATHS, ...manifest.roles['pi/core'].forbidden_paths])];
        const leaks = inspectRoleArchive(archivePath, archiveRel, selectedPaths, {
          forbiddenPaths: coreForbiddenPaths,
          forbiddenContent: FORBIDDEN_CORE_CONTENT,
        });
        assert.deepEqual(leaks, [], `${archiveRel}: Core archive must not contain Enterprise paths, instructions, or unresolved citations`);
      }
    }

    const packedCli = path.join(extracted, 'cli', 'index.js');
    const versionOutput = execFileSync('node', [packedCli, '--version'], { cwd: temporaryRoot, encoding: 'utf8' });
    assert.equal(versionOutput, 'pocketto-pi 4.0.0 (contract 3)\n');

    const planPath = path.join(temporaryRoot, 'execution-plan.md');
    fs.writeFileSync(planPath, PLAN, 'utf8');
    const jsonOutput = execFileSync('node', [packedCli, 'structure', planPath, '--dry-run', '--json', '--contract', '3'], {
      cwd: temporaryRoot,
      encoding: 'utf8',
    });
    const envelope = JSON.parse(jsonOutput);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, 'structure');
    assert.equal(envelope.contract, 3);
    assert.equal(envelope.data.action, 'single');
    assert.equal(envelope.data.taskCount, 1);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('npm test command includes every v4 runtime suite and keeps the T13 documentation gate separate', () => {
  // T14 Cycle 2 — test/release-regression.test.js, integration.
  // Intent: Given completed v4 executable test files, when regression inspects package.json and invokes test-command contract, then the script names test/cli.test.js, test/package.test.js, every lifecycle/surface/Enterprise/compatibility/integration/release suite, with no omission; documentation contract remains a separate T13 gate because T13 runs in parallel.
  // Exercise: the exact package.json scripts.test value and a controlled command-list assertion; run the full command only after the script update. Test doubles: none for package metadata; no live services.
  // Expected RED: the task text describes only CLI/package tests, but this baseline also includes test/surfaces.test.js. The actual missing suites are lifecycle-contract, lifecycle-store, lifecycle-cli, lifecycle-dispatch, skill-surfaces, enterprise-protocol, enterprise-issue, enterprise-phase, enterprise-closeout, enterprise-dispatch, enterprise-issue-dispatch, enterprise-meta, enterprise-ownership, compatibility, integration/lifecycle-enterprise, and release-regression.
  // Exact command: node --test test/release-regression.test.js
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const match = packageJson.scripts?.test?.match(/^node --test (.+)$/);
  assert.ok(match, 'scripts.test must invoke node --test with the repository test suite list');

  const expectedSuites = [
    'test/cli.test.js',
    'test/package.test.js',
    'test/lifecycle-contract.test.js',
    'test/lifecycle-store.test.js',
    'test/lifecycle-cli.test.js',
    'test/lifecycle-dispatch.test.js',
    'test/surfaces.test.js',
    'test/skill-surfaces.test.js',
    'test/enterprise-protocol.test.js',
    'test/enterprise-issue.test.js',
    'test/enterprise-phase.test.js',
    'test/enterprise-closeout.test.js',
    'test/enterprise-dispatch.test.js',
    'test/enterprise-issue-dispatch.test.js',
    'test/enterprise-meta.test.js',
    'test/enterprise-ownership.test.js',
    'test/compatibility.test.js',
    'test/integration/lifecycle-enterprise.test.js',
    'test/release-regression.test.js',
  ];
  const actualSuites = match[1].trim().split(/\s+/);
  assert.deepEqual(actualSuites, expectedSuites, 'scripts.test must name every v4 runtime suite, without omissions or unapproved extras');
  assert.equal(actualSuites.includes('test/documentation.test.js'), false, 'T13 owns the separately ordered documentation gate until it merges');
});
