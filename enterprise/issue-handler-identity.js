'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ISSUE_LABEL = 'pocket-plan';
const ISSUE_FIELDS = 'number,url,state,title,body,labels,createdAt';
const PLAN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const { issueUrlBelongsTo } = require('./issue-identity');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function specContext(event, projectRoot) {
  if (!PLAN_ID_PATTERN.test(event.plan_id)) return { error: 'plan_id is not a normalized kebab-slug' };
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    return { error: 'registered project root is required and must be absolute' };
  }
  const refs = event.artifact_refs.filter((ref) => ref.root === 'spec');
  if (refs.length === 0 || refs.length !== event.artifact_refs.length) {
    return { error: 'spec-approved requires spec-root artifacts only' };
  }
  for (const ref of refs) {
    if (path.isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes('..')) {
      return { error: 'approved spec artifact path is not root-relative' };
    }
  }

  let realProjectRoot;
  let realSpecDir;
  try {
    realProjectRoot = fs.realpathSync(projectRoot);
    if (!fs.statSync(realProjectRoot).isDirectory()) return { error: 'registered project root is not a directory' };
    const expectedSpecDir = path.resolve(realProjectRoot, 'docs', 'pocket', 'spec', event.plan_id);
    realSpecDir = fs.realpathSync(expectedSpecDir);
    if (realSpecDir !== expectedSpecDir || !fs.statSync(realSpecDir).isDirectory()) {
      return { error: 'approved spec directory does not match the selected plan directory' };
    }
    const projectRelative = path.relative(realProjectRoot, realSpecDir);
    if (projectRelative === '' || projectRelative === '..'
        || projectRelative.startsWith(`..${path.sep}`) || path.isAbsolute(projectRelative)) {
      return { error: 'approved spec directory escapes the registered project root' };
    }
  } catch {
    return { error: 'approved spec directory is unavailable' };
  }

  const targets = [];
  for (const ref of refs) {
    const artifactPath = path.resolve(realSpecDir, ref.path);
    const relative = path.relative(realSpecDir, artifactPath);
    if (relative === '' || !isInside(realSpecDir, artifactPath)) {
      return { error: 'approved spec artifact escapes the current plan directory' };
    }
    let realArtifact;
    try {
      realArtifact = fs.realpathSync(artifactPath);
    } catch (err) {
      return { error: `approved spec artifact is unavailable (${err && err.code === 'ENOENT' ? 'not found' : 'read failed'})` };
    }
    const realRelative = path.relative(realSpecDir, realArtifact);
    if (realRelative === '' || !isInside(realSpecDir, realArtifact)) {
      return { error: 'approved spec artifact escapes the current plan directory' };
    }
    targets.push({ ref, realArtifact });
  }

  const { ref, realArtifact } = targets[0];
  let markdown;
  try {
    if (!fs.statSync(realArtifact).isFile()) return { error: 'approved spec artifact is not a file' };
    markdown = fs.readFileSync(realArtifact, 'utf8');
  } catch (err) {
    return { error: `approved spec artifact is unavailable (${err && err.code === 'ENOENT' ? 'not found' : 'read failed'})` };
  }
  const actualHash = crypto.createHash('sha256').update(markdown).digest('hex');
  if (actualHash !== ref.sha256) return { error: 'approved spec artifact hash does not match the event' };
  const specPath = `docs/pocket/spec/${event.plan_id}/${ref.path.split(path.sep).join('/')}`;
  const metaContext = { projectRoot: realProjectRoot, specDir: realSpecDir };
  return { projectRoot: realProjectRoot, specDir: realSpecDir, realProjectRoot, realSpecDir, metaContext, specPath, markdown, ref };
}

function flattenIssuePages(data) {
  if (!Array.isArray(data)) return null;
  const issues = [];
  const append = (page) => {
    if (!Array.isArray(page)) return false;
    for (const issue of page) {
      if (Array.isArray(issue)) {
        if (!append(issue)) return false;
      } else if (!issue || typeof issue !== 'object') {
        return false;
      } else {
        issues.push(issue);
      }
    }
    return true;
  };
  return append(data) ? issues : null;
}

function parseCreatedIssueNumber(output, repo) {
  const match = /\/issues\/(\d+)(?:\s|$)/.exec(String(output || '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  const candidate = { number, url: String(output).trim() };
  return issueUrlBelongsTo(candidate, repo) ? number : null;
}

module.exports = {
  ISSUE_FIELDS,
  ISSUE_LABEL,
  flattenIssuePages,
  parseCreatedIssueNumber,
  specContext,
};
