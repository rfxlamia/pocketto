'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CITATION_RE =
  /(?:<skills_root>\/|(?:skills|references|cli)\/)[A-Za-z0-9._/-]+\.(?:md|js)(?::\d+(?:-\d+)?)?/g;
const FORBIDDEN_CORE_PATHS = [
  'enterprise/',
  'skills/create-pr/',
  'skills/pocket-enterprise/',
  'skills/pocket-development/references/enterprise-reporting.md',
];
const FORBIDDEN_CORE_CONTENT = [
  /\bgh\s+(?:issue|pr|api|auth|repo|label)\b/i,
  /\bGitHub\s+(?:issue|issues|pull request|pull requests|PRs?)\b/i,
  /Pocket Enterprise|enterprise mode|Enterprise is opt-in/i,
  /\b(?:GITHUB|GH)_(?:TOKEN|KEY|SECRET)\b|github_pat_|ghp_[A-Za-z0-9]/,
  /\.pocket-meta\.json|\.github\//,
  /git\s+remote\s+get-url|create-pr|enterprise-reporting\.md/,
];
const IGNORED_ARCHIVE_SOURCE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '__MACOSX',
  '__pycache__',
]);

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function posixPath(relativePath) {
  return relativePath.split(path.sep).join('/');
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

function findForbiddenPaths(paths, forbiddenPaths = FORBIDDEN_CORE_PATHS) {
  return paths.filter((rel) =>
    forbiddenPaths.some((forbidden) => rel === forbidden || rel.startsWith(forbidden)),
  );
}

function scanMarkdown(
  roleDir,
  roleName,
  { include = () => true, forbiddenContent = FORBIDDEN_CORE_CONTENT, availablePaths } = {},
) {
  const markdown = walkFiles(roleDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, rel: posixPath(path.relative(roleDir, file)) }))
    .filter(({ rel }) => include(rel))
    .sort((left, right) => left.rel.localeCompare(right.rel));
  const contentViolations = [];
  const citationViolations = [];

  for (const { file, rel } of markdown) {
    const text = fs.readFileSync(file, 'utf8');
    for (const forbidden of forbiddenContent) {
      const match = text.match(forbidden);
      if (match) contentViolations.push(`${roleName}:${rel}: ${match[0]}`);
    }
    for (const citation of text.match(CITATION_RE) || []) {
      const resolved = resolveCitation(citation, rel);
      const exists = availablePaths
        ? availablePaths.has(resolved)
        : fs.existsSync(path.join(roleDir, resolved));
      if (!exists) citationViolations.push(`${roleName}:${rel} → ${citation} (${resolved})`);
    }
  }

  return {
    markdown: markdown.map(({ file }) => file),
    contentViolations,
    citationViolations,
  };
}

function stageRole(root, role, output) {
  execFileSync(
    'node',
    [path.join(root, 'scripts', 'build-surfaces.js'), '--role', role, '--output', output],
    { cwd: root, encoding: 'utf8' },
  );
}

function withTemporaryDirectory(prefix, callback) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return callback(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function readSurfaceManifest(root = ROOT) {
  const manifestPath = path.join(root, 'surfaces.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    assert.fail(`unable to read valid surface manifest at ${manifestPath}: ${error.message}`);
  }
}

// Expand manifest includes independently of the production surface builder.
function expandManifestIncludes(includes, root = ROOT) {
  const expanded = new Set();
  for (const include of includes) {
    const sourcePath = include.endsWith('/**') ? include.slice(0, -3) : include;
    const fullPath = path.join(root, sourcePath);
    assert.ok(fs.existsSync(fullPath), `manifest include does not exist: ${include}`);
    if (fs.statSync(fullPath).isDirectory()) {
      for (const file of walkFiles(fullPath)) {
        expanded.add(posixPath(path.relative(root, file)));
      }
    } else {
      expanded.add(posixPath(path.relative(root, fullPath)));
    }
  }
  return [...expanded].sort();
}

function isArchiveableMember(rel, skillDirRel) {
  if (!rel.startsWith(`${skillDirRel}/`)) return false;
  const local = rel.slice(skillDirRel.length + 1);
  if (local.endsWith('.skill')) return false;
  return local.split('/').every((part) =>
    !IGNORED_ARCHIVE_SOURCE_NAMES.has(part) &&
    (!part.startsWith('.') || part === '.skillkit-mode'),
  );
}

function expectedRoleArchiveMembers(archiveRel, manifest, root = ROOT) {
  const skillDirRel = path.posix.dirname(archiveRel);
  const owners = [];
  for (const [roleName, role] of Object.entries(manifest.roles)) {
    const expanded = expandManifestIncludes(role.includes, root);
    if (!expanded.includes(archiveRel)) continue;
    const members = expanded
      .filter((rel) => rel !== archiveRel && isArchiveableMember(rel, skillDirRel))
      .map((rel) => rel.slice(skillDirRel.length + 1))
      .sort();
    owners.push({ roleName, kind: role.kind, members });
  }

  assert.ok(owners.length > 0, `${archiveRel}: no surface role owns this archive`);
  for (const owner of owners.slice(1)) {
    assert.equal(owner.kind, owners[0].kind, `${archiveRel}: conflicting archive role kinds`);
    assert.deepEqual(owner.members, owners[0].members, `${archiveRel}: host roles disagree on archive sources`);
  }
  return owners[0].members;
}

function skillArchivePaths(archive) {
  let output;
  try {
    output = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
  } catch (error) {
    if (error.code === 'ENOENT') assert.fail('unzip executable is required to validate .skill archives');
    throw error;
  }

  const entries = output.split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  for (const entry of entries) {
    assert.equal(path.posix.isAbsolute(entry), false, `${archive}: absolute ZIP entry ${entry}`);
    assert.equal(entry.includes('\\'), false, `${archive}: backslash in ZIP entry ${entry}`);
    assert.equal(entry.split('/').includes('..'), false, `${archive}: parent traversal in ZIP entry ${entry}`);
    assert.equal(seen.has(entry), false, `${archive}: duplicate ZIP entry ${entry}`);
    seen.add(entry);
  }
  return entries.sort();
}

function assertArchiveMatchesSource(archive, root = ROOT, manifest = readSurfaceManifest(root)) {
  const archiveRel = posixPath(path.relative(root, archive));
  const expected = expectedRoleArchiveMembers(archiveRel, manifest, root);
  const actual = skillArchivePaths(archive);
  assert.deepEqual(actual, expected, `${archiveRel}: archive members must match its role-owned source set`);

  const skillDir = path.join(root, path.posix.dirname(archiveRel));
  for (const rel of expected) {
    const archived = execFileSync('unzip', ['-p', archive, rel]);
    const source = fs.readFileSync(path.join(skillDir, rel));
    assert.ok(archived.equals(source), `${archiveRel}: stale role-owned content for ${rel}`);
  }
}

function inspectRoleArchive(
  archive,
  archiveRel,
  selectedPaths,
  { forbiddenPaths = [], forbiddenContent = [] } = {},
) {
  const issues = [];
  const entries = skillArchivePaths(archive);
  const sourcePaths = entries.map((entry) => path.posix.join(path.posix.dirname(archiveRel), entry));
  for (const leaked of findForbiddenPaths(sourcePaths, forbiddenPaths)) {
    issues.push(`${archiveRel}: forbidden path ${leaked}`);
  }

  for (const entry of entries.filter((item) => item.endsWith('.md'))) {
    const sourceRel = path.posix.join(path.posix.dirname(archiveRel), entry);
    const text = execFileSync('unzip', ['-p', archive, entry], { encoding: 'utf8' });
    for (const forbidden of forbiddenContent) {
      if (forbidden.test(text)) issues.push(`${archiveRel}:${entry}: forbidden content ${forbidden}`);
    }
    for (const citation of text.match(CITATION_RE) || []) {
      const resolved = resolveCitation(citation, sourceRel);
      if (!selectedPaths.has(resolved)) {
        issues.push(`${archiveRel}:${entry}: unresolved role citation ${citation}`);
      }
    }
  }
  return issues;
}

module.exports = {
  CITATION_RE,
  FORBIDDEN_CORE_CONTENT,
  FORBIDDEN_CORE_PATHS,
  ROOT,
  assertArchiveMatchesSource,
  expectedRoleArchiveMembers,
  findForbiddenPaths,
  inspectRoleArchive,
  posixPath,
  readSurfaceManifest,
  resolveCitation,
  scanMarkdown,
  skillArchivePaths,
  stageRole,
  walkFiles,
  withTemporaryDirectory,
};
