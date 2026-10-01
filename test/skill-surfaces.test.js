// T6 Cycle 1 — Core skills stay remote-free and retain neutral lifecycle handoffs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUILDER = path.join(ROOT, 'scripts', 'build-surfaces.js');
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

function scanCoreRole(roleDir, roleName) {
  const skillRoot = path.join(roleDir, 'skills');
  const files = walkFiles(skillRoot).sort();
  const markdown = files.filter((file) => file.endsWith('.md'));
  const paths = files.map((file) => posix(path.relative(roleDir, file)));
  const pathViolations = paths.filter((rel) =>
    FORBIDDEN_PATHS.some((forbidden) => rel === forbidden || rel.startsWith(forbidden)),
  );
  const contentViolations = [];
  const citationViolations = [];

  for (const file of markdown) {
    const rel = posix(path.relative(roleDir, file));
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

  return { paths, markdown, pathViolations, contentViolations, citationViolations };
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
