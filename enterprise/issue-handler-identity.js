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

function resolvePhysicalSpecContext(planId, projectRoot) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    return { error: 'registered project root is required and must be absolute' };
  }

  try {
    const realProjectRoot = fs.realpathSync(projectRoot);
    if (!fs.statSync(realProjectRoot).isDirectory()) return { error: 'registered project root is not a directory' };
    const expectedSpecDir = path.resolve(realProjectRoot, 'docs', 'pocket', 'spec', planId);
    const realSpecDir = fs.realpathSync(expectedSpecDir);
    if (realSpecDir !== expectedSpecDir || !fs.statSync(realSpecDir).isDirectory()) {
      return { error: 'approved spec directory does not match the selected plan directory' };
    }
    if (realSpecDir === realProjectRoot || !isInside(realProjectRoot, realSpecDir)) {
      return { error: 'approved spec directory escapes the registered project root' };
    }
    return { projectRoot: realProjectRoot, specDir: realSpecDir };
  } catch {
    return { error: 'approved spec directory is unavailable' };
  }
}

function preflightArtifactRefs(refs, realSpecDir) {
  const targets = [];
  for (const ref of refs) {
    if (path.isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes('..')) {
      return { error: 'approved spec artifact path is not root-relative' };
    }

    const artifactPath = path.resolve(realSpecDir, ref.path);
    if (artifactPath === realSpecDir || !isInside(realSpecDir, artifactPath)) {
      return { error: 'approved spec artifact escapes the current plan directory' };
    }

    let realArtifact;
    try {
      realArtifact = fs.realpathSync(artifactPath);
    } catch (error) {
      const reason = error && error.code === 'ENOENT' ? 'not found' : 'read failed';
      return { error: `approved spec artifact is unavailable (${reason})` };
    }
    if (realArtifact === realSpecDir || !isInside(realSpecDir, realArtifact)) {
      return { error: 'approved spec artifact escapes the current plan directory' };
    }
    targets.push({ ref, realArtifact });
  }
  return { targets };
}

function readSelectedArtifact({ ref, realArtifact }) {
  let markdown;
  try {
    if (!fs.statSync(realArtifact).isFile()) return { error: 'approved spec artifact is not a file' };
    markdown = fs.readFileSync(realArtifact, 'utf8');
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? 'not found' : 'read failed';
    return { error: `approved spec artifact is unavailable (${reason})` };
  }
  const actualHash = crypto.createHash('sha256').update(markdown).digest('hex');
  if (actualHash !== ref.sha256) return { error: 'approved spec artifact hash does not match the event' };
  return { markdown };
}

function specContext(event, projectRoot) {
  if (!PLAN_ID_PATTERN.test(event.plan_id)) return { error: 'plan_id is not a normalized kebab-slug' };
  const refs = event.artifact_refs.filter((ref) => ref.root === 'spec');
  if (refs.length === 0 || refs.length !== event.artifact_refs.length) {
    return { error: 'spec-approved requires spec-root artifacts only' };
  }

  const physical = resolvePhysicalSpecContext(event.plan_id, projectRoot);
  if (physical.error) return physical;
  const preflight = preflightArtifactRefs(refs, physical.specDir);
  if (preflight.error) return preflight;

  const selected = readSelectedArtifact(preflight.targets[0]);
  if (selected.error) return selected;
  const { ref } = preflight.targets[0];
  const specPath = `docs/pocket/spec/${event.plan_id}/${ref.path.split(path.sep).join('/')}`;
  const metaContext = { projectRoot: physical.projectRoot, specDir: physical.specDir };
  return {
    projectRoot: physical.projectRoot,
    specDir: physical.specDir,
    realProjectRoot: physical.projectRoot,
    realSpecDir: physical.specDir,
    metaContext,
    specPath,
    markdown: selected.markdown,
    ref,
  };
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
