// T6 Cycle 1 — Core skills stay remote-free and retain neutral lifecycle handoffs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUILDER = path.join(ROOT, 'scripts', 'build-surfaces.js');
const { expandIncludes, loadManifest } = require('../cli/lib/surface-manifest');
const CORE_ROLES = ['pi/core', 'claude/core'];
const CORE_SKILLS = [
  'pocket-grinding',
  'pocket-init',
  'pocket-help',
  'pocket-development',
  'pocket-closing',
];
const FORBIDDEN_PATHS = [
  'skills/create-pr/',
  'skills/pocket-enterprise/',
  'skills/pocket-development/references/enterprise-reporting.md',
];
const FORBIDDEN_CONTENT = [
  /\bgh\s+(?:issue|pr|api|auth|repo|label)\b/i,
  /\bGitHub\s+(?:issue|issues|pull request|pull requests|PRs?)\b/i,
  /Pocket Enterprise|enterprise mode|Enterprise is opt-in/i,
  /\b(?:GITHUB|GH)_(?:TOKEN|KEY|SECRET)\b|github_pat_|ghp_[A-Za-z0-9]/,
  /\.pocket-meta\.json|\.github\//,
  /git\s+remote\s+get-url|create-pr|enterprise-reporting\.md/,
];
const CITATION_RE =
  /(?:<skills_root>\/|(?:skills|references|cli)\/)[A-Za-z0-9._/-]+\.(?:md|js)(?::\d+(?:-\d+)?)?/g;

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function posix(rel) {
  return rel.split(path.sep).join('/');
}

function stageRole(role, out) {
  execFileSync('node', [BUILDER, '--role', role, '--output', out], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function resolveCitation(citation, fromFile) {
  const filePart = citation.replace(/:\d+(?:-\d+)?$/, '');
  if (filePart.startsWith('<skills_root>/')) {
    return `skills/${filePart.slice('<skills_root>/'.length)}`;
  }
  if (filePart.startsWith('references/')) {
    const parts = fromFile.split('/');
    return `${parts[0]}/${parts[1]}/${filePart}`;
  }
  return filePart;
}

function scanMarkdown(roleDir, roleName, include = () => true) {
  const markdown = walkFiles(roleDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, rel: posix(path.relative(roleDir, file)) }))
    .filter(({ rel }) => include(rel))
    .sort((left, right) => left.rel.localeCompare(right.rel));
  const contentViolations = [];
  const citationViolations = [];

  for (const { file, rel } of markdown) {
    const text = fs.readFileSync(file, 'utf8');
    for (const forbidden of FORBIDDEN_CONTENT) {
      const match = text.match(forbidden);
      if (match) contentViolations.push(`${roleName}:${rel}: ${match[0]}`);
    }
    for (const citation of text.match(CITATION_RE) || []) {
      const resolved = resolveCitation(citation, rel);
      if (!fs.existsSync(path.join(roleDir, resolved))) {
        citationViolations.push(`${roleName}:${rel} → ${citation} (${resolved})`);
      }
    }
  }

  return {
    markdown: markdown.map(({ file }) => file),
    contentViolations,
    citationViolations,
  };
}

function scanCoreRole(roleDir, roleName) {
  const skillRoot = path.join(roleDir, 'skills');
  const files = walkFiles(skillRoot).sort();
  const paths = files.map((file) => posix(path.relative(roleDir, file)));
  const pathViolations = paths.filter((rel) =>
    FORBIDDEN_PATHS.some((forbidden) => rel === forbidden || rel.startsWith(forbidden)),
  );
  return {
    paths,
    pathViolations,
    ...scanMarkdown(roleDir, roleName, (rel) => rel.startsWith('skills/')),
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
  operations.sort((a, b) => a.position - b.position);

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

test('Core role staging excludes Enterprise instructions and runs the neutral grinding handoff', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't6-core-surfaces-'));
  try {
    const staged = new Map();
    for (const role of CORE_ROLES) {
      const out = path.join(temp, role.replace('/', '-'));
      stageRole(role, out);
      staged.set(role, scanCoreRole(out, role));
    }

    for (const [role, result] of staged) {
      assert.deepEqual(result.pathViolations, [], `${role}: Enterprise skill/reference paths must be absent`);
      assert.deepEqual(result.contentViolations, [], `${role}: Enterprise instructions and remote data must be absent`);
      assert.deepEqual(result.citationViolations, [], `${role}: every active citation must resolve inside Core`);

      for (const skill of CORE_SKILLS) {
        assert.ok(
          fs.existsSync(path.join(temp, role.replace('/', '-'), 'skills', skill, 'SKILL.md')),
          `${role}: Core skill ${skill} must remain staged`,
        );
      }
    }

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
    assert.match(lifecycleText, /lifecycle\s+repair[\s\S]*lifecycle\s+drain|lifecycle\s+drain[\s\S]*lifecycle\s+repair/,
      'Core must retain local-first lifecycle repair and drain guidance');

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
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

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
  return walkFiles(root).map((file) => posix(path.relative(root, file))).sort();
}

function assertArchiveMatchesSource(archivePath) {
  const archiveRel = posix(path.relative(ROOT, archivePath));
  const skillDirRel = path.posix.dirname(archiveRel);
  const manifest = loadManifest(path.join(ROOT, 'surfaces.json'), { sourceDir: ROOT });
  const owners = [];

  for (const [roleName, role] of Object.entries(manifest.roles)) {
    const expanded = expandIncludes(role.includes, ROOT);
    if (!expanded.includes(archiveRel)) continue;
    const members = expanded
      .filter((rel) => rel.startsWith(`${skillDirRel}/`) && rel !== archiveRel)
      .filter((rel) => {
        const local = rel.slice(skillDirRel.length + 1);
        if (local.endsWith('.skill')) return false;
        return local.split('/').every((part) =>
          !['.DS_Store', 'Thumbs.db', '__MACOSX', '__pycache__'].includes(part) &&
          (!part.startsWith('.') || part === '.skillkit-mode'),
        );
      })
      .map((rel) => rel.slice(skillDirRel.length + 1))
      .sort();
    owners.push({ roleName, kind: role.kind, members });
  }

  assert.ok(owners.length > 0, `${archiveRel}: no surface role owns this archive`);
  for (const owner of owners.slice(1)) {
    assert.equal(owner.kind, owners[0].kind, `${archiveRel}: conflicting archive role kinds`);
    assert.deepEqual(owner.members, owners[0].members, `${archiveRel}: host roles disagree on archive sources`);
  }

  const expected = owners[0].members;
  const skillDir = path.join(ROOT, skillDirRel);
  const actual = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  assert.deepEqual(actual, expected, `${archiveRel}: archive members must match its role-owned source set`);
  for (const rel of expected) {
    const archived = execFileSync('unzip', ['-p', archivePath, rel]);
    const source = fs.readFileSync(path.join(skillDir, rel));
    assert.ok(archived.equals(source), `${archiveRel}: stale role-owned content for ${rel}`);
  }
}

function scanWholeCoreMarkdown(roleDir, roleName) {
  const result = scanMarkdown(roleDir, roleName);
  return [...result.contentViolations, ...result.citationViolations];
}

test('Enterprise roles add only their adapter delta and preserve the immutable v3 source snapshot', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't6-enterprise-surfaces-'));
  try {
    const roleFiles = new Map();
    for (const [coreRole, enterpriseRole] of [
      ['pi/core', 'pi/enterprise'],
      ['claude/core', 'claude/enterprise'],
    ]) {
      const coreOut = path.join(temp, coreRole.replace('/', '-'));
      const enterpriseOut = path.join(temp, enterpriseRole.replace('/', '-'));
      stageRole(coreRole, coreOut);
      stageRole(enterpriseRole, enterpriseOut);
      roleFiles.set(enterpriseRole, {
        core: stagedPaths(coreOut),
        enterprise: stagedPaths(enterpriseOut),
        coreOut,
      });
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'surfaces.json'), 'utf8'));
    for (const [role, staged] of roleFiles) {
      const coreRole = role.replace('/enterprise', '/core');
      assert.deepEqual(manifest.roles[role].requires, [coreRole], `${role}: the matching Core role must be required`);
      assert.ok(manifest.roles[role].includes.includes('skills/pocket-enterprise/**'), `${role}: adapter source must be manifest-owned`);
      for (const forbidden of FORBIDDEN_PATHS) {
        assert.ok(manifest.roles[coreRole].forbidden_paths.includes(forbidden), `${coreRole}: ${forbidden} must be explicitly forbidden`);
      }
      const expectedDelta = [...ENTERPRISE_SKILL_DELTA].sort();
      const actualDelta = staged.enterprise.filter((file) => file.startsWith('skills/')).sort();
      assert.deepEqual(actualDelta, expectedDelta, `${role}: Enterprise skill files must be an explicit additive delta`);

      const copiedCoreSkills = actualDelta.filter((file) => staged.core.includes(file));
      assert.deepEqual(copiedCoreSkills, [], `${role}: Enterprise must not copy any Core skill source`);
      const forbiddenCorePaths = staged.core.filter((file) =>
        FORBIDDEN_PATHS.some((forbidden) => file === forbidden || file.startsWith(forbidden)),
      );
      assert.deepEqual(forbiddenCorePaths, [], `${coreRole}: Enterprise-owned paths must be absent`);
      assert.deepEqual(
        scanWholeCoreMarkdown(staged.coreOut, coreRole),
        [],
        `${role}: Core Markdown must contain no Enterprise-only path/content and all citations must stay in Core`,
      );
    }

    const { createHash } = require('node:crypto');
    for (const [rel, expectedHash] of Object.entries(V3_SNAPSHOT_SHA256)) {
      const snapshot = execFileSync('git', ['show', `v3.1.3:${rel}`]);
      const actualHash = createHash('sha256').update(snapshot).digest('hex');
      assert.equal(actualHash, expectedHash, `v3.1.3 source snapshot changed for ${rel}`);
    }

    for (const rel of TASK_ARCHIVES) {
      const archive = path.join(ROOT, rel);
      assert.ok(fs.existsSync(archive), `required role archive is missing: ${rel}`);
      assertArchiveMatchesSource(archive);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
