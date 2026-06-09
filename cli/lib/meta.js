'use strict';

const path = require('node:path');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');

const META_FILE = '.pocket-meta.json';

// .pocket-meta.json schema is additive:
// { slug, github_issue: { number, url, created_at }, phases: { "<phase>": { github_pr: { number, url }, fingerprints: [] } }, external_tracker: string|null }
function emptyMeta() {
  return {
    slug: null,
    github_issue: {},
    phases: {},
    external_tracker: null,
  };
}

function metaPathFor(dir) {
  return path.join(dir, META_FILE);
}

function normalizeEol(content) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function readMeta(metaPath) {
  if (!existsSync(metaPath)) return emptyMeta();
  const parsed = JSON.parse(normalizeEol(readFileSync(metaPath, 'utf8')));
  return { ...emptyMeta(), ...parsed };
}

function writeMeta(metaPath, meta) {
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
}

function pathParts(field) {
  if (typeof field !== 'string' || field.trim() === '') {
    throw new Error('field must be a non-empty dotted path.');
  }
  const parts = field.split('.');
  if (parts.some((part) => part === '')) {
    throw new Error(`field must be a dotted path without empty segments: '${field}'.`);
  }
  return parts;
}

function getDotted(meta, field) {
  let current = meta;
  for (const part of pathParts(field)) {
    if (current === null || typeof current !== 'object' || !(part in current)) return null;
    current = current[part];
  }
  return current;
}

function setDotted(meta, field, value) {
  const parts = pathParts(field);
  let current = meta;
  for (const part of parts.slice(0, -1)) {
    if (current[part] === null || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return meta;
}

function getIssue(meta) {
  return meta.github_issue || {};
}

function setIssue(meta, issue) {
  meta.github_issue = { ...(meta.github_issue || {}), ...issue };
  return meta;
}

function phaseEntry(meta, phase) {
  if (!meta.phases || typeof meta.phases !== 'object' || Array.isArray(meta.phases)) meta.phases = {};
  if (!meta.phases[phase] || typeof meta.phases[phase] !== 'object' || Array.isArray(meta.phases[phase])) {
    meta.phases[phase] = {};
  }
  return meta.phases[phase];
}

function getPr(meta, phase) {
  return ((meta.phases || {})[phase] || {}).github_pr || {};
}

function setPr(meta, phase, pr) {
  const entry = phaseEntry(meta, phase);
  entry.github_pr = { ...(entry.github_pr || {}), ...pr };
  return meta;
}

function getFingerprints(meta, phase) {
  const fingerprints = ((meta.phases || {})[phase] || {}).fingerprints;
  return Array.isArray(fingerprints) ? fingerprints : [];
}

function setFingerprints(meta, phase, fingerprints) {
  const entry = phaseEntry(meta, phase);
  entry.fingerprints = Array.isArray(fingerprints) ? fingerprints : [];
  return meta;
}

module.exports = {
  META_FILE,
  emptyMeta,
  metaPathFor,
  readMeta,
  writeMeta,
  getDotted,
  setDotted,
  getIssue,
  setIssue,
  getPr,
  setPr,
  getFingerprints,
  setFingerprints,
};
