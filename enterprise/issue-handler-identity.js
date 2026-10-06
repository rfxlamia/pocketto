'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const enterpriseMeta = require('./meta');

const ISSUE_LABEL = 'pocket-plan';
const ISSUE_FIELDS = 'number,url,state,title,body,labels,createdAt';
const PLAN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const { issueUrlBelongsTo } = require('./issue-identity');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function contextFailure(code, message, retryable = false) {
  return { error: { code, message, retryable } };
}

function filesystemFailure(error, message) {
  return enterpriseMeta.isTransientIoError(error)
    ? contextFailure('ARTIFACT_READ_FAILED', message, true)
    : contextFailure('STALE_ARTIFACT', message);
}

function resolvePhysicalSpecContext(planId, projectRoot) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    return contextFailure('STALE_ARTIFACT', 'Registered project root is required and must be absolute.');
  }

  try {
    const realProjectRoot = fs.realpathSync(projectRoot);
    if (!fs.statSync(realProjectRoot).isDirectory()) {
      return contextFailure('STALE_ARTIFACT', 'Registered project root is not a directory.');
    }
    const expectedSpecDir = path.resolve(realProjectRoot, 'docs', 'pocket', 'spec', planId);
    const realSpecDir = fs.realpathSync(expectedSpecDir);
    if (realSpecDir !== expectedSpecDir || !fs.statSync(realSpecDir).isDirectory()) {
      return contextFailure('STALE_ARTIFACT', 'Approved spec directory does not match the selected plan directory.');
    }
    if (realSpecDir === realProjectRoot || !isInside(realProjectRoot, realSpecDir)) {
      return contextFailure('STALE_ARTIFACT', 'Approved spec directory escapes the registered project root.');
    }
    return { projectRoot: realProjectRoot, specDir: realSpecDir };
  } catch (error) {
    return filesystemFailure(error, 'Approved spec directory is unavailable.');
  }
}

function preflightArtifactRefs(refs, realSpecDir) {
  const targets = [];
  for (const ref of refs) {
    if (path.isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes('..')) {
      return contextFailure('STALE_ARTIFACT', 'Approved spec artifact path is not root-relative.');
    }

    const artifactPath = path.resolve(realSpecDir, ref.path);
    if (artifactPath === realSpecDir || !isInside(realSpecDir, artifactPath)) {
      return contextFailure('STALE_ARTIFACT', 'Approved spec artifact escapes the current plan directory.');
    }

    let realArtifact;
    try {
      realArtifact = fs.realpathSync(artifactPath);
    } catch (error) {
      return filesystemFailure(error, 'Approved spec artifact could not be resolved.');
    }
    if (realArtifact === realSpecDir || !isInside(realSpecDir, realArtifact)) {
      return contextFailure('STALE_ARTIFACT', 'Approved spec artifact escapes the current plan directory.');
    }
    targets.push({ ref, realArtifact });
  }
  return { targets };
}

function readSelectedArtifact({ ref, realArtifact }) {
  let markdown;
  try {
    if (!fs.statSync(realArtifact).isFile()) {
      return contextFailure('STALE_ARTIFACT', 'Approved spec artifact is not a regular file.');
    }
    markdown = fs.readFileSync(realArtifact, 'utf8');
  } catch (error) {
    return filesystemFailure(error, 'Approved spec artifact could not be read.');
  }
  const actualHash = crypto.createHash('sha256').update(markdown).digest('hex');
  if (actualHash !== ref.sha256) {
    return contextFailure('STALE_ARTIFACT', 'Approved spec artifact hash does not match the event.');
  }
  return { markdown };
}

function specContext(event, projectRoot) {
  if (!PLAN_ID_PATTERN.test(event.plan_id)) {
    return contextFailure('STALE_ARTIFACT', 'plan_id is not a normalized kebab-slug.');
  }
  const refs = event.artifact_refs.filter((ref) => ref.root === 'spec');
  if (refs.length === 0 || refs.length !== event.artifact_refs.length) {
    return contextFailure('STALE_ARTIFACT', 'spec-approved requires spec-root artifacts only.');
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
