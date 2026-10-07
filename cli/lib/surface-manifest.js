'use strict';

// Surface-manifest loader: reads and structurally validates surfaces.json.
//
// Node built-ins only. This module never touches the filesystem beyond
// reading the manifest file; staging/copying lives in
// scripts/build-surfaces.js.

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_ROLES = ['pi/core', 'pi/enterprise', 'claude/core', 'claude/enterprise'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

// Expands `<dir>/**` globs in an ordered include list against `sourceDir`
// and returns POSIX-relative file paths in deterministic LC_ALL=C order.
// Throws a stable error when the pattern is invalid or matches nothing.
function expandIncludes(includes, sourceDir) {
  const expanded = [];
  for (const pattern of includes) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('SURFACE_INCLUDE_INVALID: include entries must be non-empty strings.');
    }
    if (pattern === 'skills/**' || pattern === 'skills/*') {
      throw new Error(`SURFACE_WILDCARD_FORBIDDEN: package-wide wildcard include is forbidden: ${pattern}`);
    }
    assertIncludeStaysInSource(pattern, sourceDir);
    if (pattern.endsWith('/**')) {
      const base = pattern.slice(0, -3);
      const baseDir = path.join(sourceDir, base);
      let stat;
      try {
        stat = fs.statSync(baseDir);
      } catch {
        throw new Error(`SURFACE_INCLUDE_MISSING: declared include is missing: ${pattern}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`SURFACE_INCLUDE_MISSING: declared include is not a directory: ${pattern}`);
      }
      expanded.push(...walkUnder(baseDir, sourceDir, new Set()));
    } else {
      const target = path.join(sourceDir, pattern);
      let listed;
      try {
        listed = fs.lstatSync(target);
      } catch {
        throw new Error(`SURFACE_INCLUDE_MISSING: declared include is missing: ${pattern}`);
      }
      if (!listed.isSymbolicLink() && !listed.isFile() && !listed.isDirectory()) {
        throw new Error(`SURFACE_INCLUDE_MISSING: declared include is missing: ${pattern}`);
      }
      // stat follows a direct symlink. Resolve it before staging so a link
      // cannot copy a file from outside the source root.
      assertResolvedPathInside(target, sourceDir, pattern);
      const stat = listed.isSymbolicLink() ? fs.statSync(target) : listed;
      if (stat.isDirectory()) {
        expanded.push(...walkUnder(target, sourceDir, new Set()));
      } else if (stat.isFile()) {
        expanded.push(posix(pattern));
      } else {
        throw new Error(`SURFACE_INCLUDE_MISSING: declared include is missing: ${pattern}`);
      }
    }
  }
  return [...new Set(expanded)].sort();
}

function assertIncludeStaysInSource(pattern, sourceDir) {
  const portable = pattern.split(path.sep).join('/');
  if (path.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || portable.startsWith('/')) {
    throw new Error(`SURFACE_INCLUDE_ESCAPE: include escapes the staging root: ${pattern}`);
  }
  const segments = portable.split('/');
  if (segments.includes('..')) {
    throw new Error(`SURFACE_INCLUDE_ESCAPE: include escapes the staging root: ${pattern}`);
  }
  const root = path.resolve(sourceDir);
  const base = portable.endsWith('/**') ? portable.slice(0, -3) : portable;
  const resolved = path.resolve(root, base);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`SURFACE_INCLUDE_ESCAPE: include escapes the staging root: ${pattern}`);
  }
}

function posix(rel) {
  return rel.split(path.sep).join('/');
}

// Lexical checks reject `..` and absolute patterns. This rejects a path whose
// real target, including through a symlink, sits outside the source root.
// A target that cannot be resolved is rejected too: staging must not copy it.
function assertResolvedPathInside(full, sourceDir, label) {
  let realTarget;
  let realRoot;
  try {
    realTarget = fs.realpathSync(full);
    realRoot = fs.realpathSync(sourceDir);
  } catch {
    throw new Error(`SURFACE_INCLUDE_ESCAPE: include escapes the staging root: ${label}`);
  }
  const escaped = path.relative(realRoot, realTarget);
  if (escaped.startsWith('..') || path.isAbsolute(escaped)) {
    throw new Error(`SURFACE_INCLUDE_ESCAPE: include escapes the staging root: ${label}`);
  }
}

function walkUnder(dir, sourceDir, seen) {
  const logicalDir = posix(path.relative(sourceDir, dir)) || '.';
  assertResolvedPathInside(dir, sourceDir, logicalDir);
  const realDir = fs.realpathSync(dir);
  if (seen.has(realDir)) return [];
  seen.add(realDir);
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const logical = posix(path.relative(sourceDir, full));
    if (entry.isSymbolicLink()) {
      assertResolvedPathInside(full, sourceDir, logical);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) out.push(...walkUnder(full, sourceDir, seen));
      else if (stat.isFile()) out.push(logical);
      continue;
    }
    if (entry.isDirectory()) {
      out.push(...walkUnder(full, sourceDir, seen));
    } else if (entry.isFile()) {
      if (entry.name === '__pycache__') continue;
      assertResolvedPathInside(full, sourceDir, logical);
      out.push(logical);
    }
  }
  return out;
}

// Returns true when POSIX-relative `rel` is covered by manifest `pattern`
// (exact file, `<dir>/` prefix, or `<dir>/**` glob).
function patternCovers(pattern, rel) {
  if (pattern.endsWith('/**')) {
    const base = pattern.slice(0, -3);
    return rel === base || rel.startsWith(`${base}/`);
  }
  if (pattern.endsWith('/')) {
    return rel.startsWith(pattern);
  }
  return rel === pattern;
}

function validateRole(name, role) {
  const errors = [];
  if (!isObject(role)) return [`SURFACE_ROLE_INVALID: role ${name} must be an object.`];
  if (!isNonEmptyStringArray(role.includes)) {
    errors.push(`SURFACE_ROLE_INVALID: role ${name} must declare a non-empty includes list.`);
  }
  if (!isStringArray(role.requires)) {
    errors.push(`SURFACE_ROLE_INVALID: role ${name} must declare a requires list.`);
  }
  if (!isNonEmptyStringArray(role.forbidden_paths)) {
    errors.push(`SURFACE_ROLE_INVALID: role ${name} must declare non-empty forbidden_paths.`);
  }
  if (!isNonEmptyStringArray(role.forbidden_content)) {
    errors.push(`SURFACE_ROLE_INVALID: role ${name} must declare non-empty forbidden_content.`);
  }
  return errors;
}

function validateManifestStructure(manifest) {
  const errors = [];
  if (!isObject(manifest)) return ['SURFACE_MANIFEST_INVALID: manifest must be a JSON object.'];
  if (manifest.schema !== 1) errors.push('SURFACE_MANIFEST_INVALID: schema must be 1.');
  if (!isObject(manifest.release) || manifest.release.major !== 4) {
    errors.push('SURFACE_MANIFEST_INVALID: release.major must be 4.');
  }
  if (!isObject(manifest.roles)) {
    errors.push('SURFACE_MANIFEST_INVALID: roles must be an object.');
    return errors;
  }
  const names = Object.keys(manifest.roles).sort();
  const expected = [...EXPECTED_ROLES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    errors.push(
      `SURFACE_ROLES_INVALID: roles must be exactly ${expected.join(', ')} (got ${names.join(', ')}).`,
    );
  }
  for (const [name, role] of Object.entries(manifest.roles)) {
    errors.push(...validateRole(name, role));
    if (role && Array.isArray(role.includes)) {
      for (const inc of role.includes) {
        if (inc === 'skills/**' || inc === 'skills/*') {
          errors.push(`SURFACE_WILDCARD_FORBIDDEN: role ${name} relies on package-wide wildcard ${inc}.`);
        }
      }
    }
  }
  const piEnt = manifest.roles['pi/enterprise'];
  const claudeEnt = manifest.roles['claude/enterprise'];
  const piCore = manifest.roles['pi/core'];
  const claudeCore = manifest.roles['claude/core'];
  if (piEnt && JSON.stringify(piEnt.requires || []) !== JSON.stringify(['pi/core'])) {
    errors.push('SURFACE_REQUIRES_INVALID: pi/enterprise must require exactly pi/core.');
  }
  if (claudeEnt && JSON.stringify(claudeEnt.requires || []) !== JSON.stringify(['claude/core'])) {
    errors.push('SURFACE_REQUIRES_INVALID: claude/enterprise must require exactly claude/core.');
  }
  if (piCore && Array.isArray(piCore.requires) && piCore.requires.length !== 0) {
    errors.push('SURFACE_REQUIRES_INVALID: pi/core must require nothing.');
  }
  if (claudeCore && Array.isArray(claudeCore.requires) && claudeCore.requires.length !== 0) {
    errors.push('SURFACE_REQUIRES_INVALID: claude/core must require nothing.');
  }

  // Explicit ownership classification for the ten named CLI modules.
  const requiredOwnership = [
    'cli/commands/mode.js',
    'cli/lib/mode.js',
    'cli/commands/meta.js',
    'cli/lib/meta.js',
    'cli/commands/format.js',
    'cli/lib/bodies.js',
    'cli/lib/identity.js',
    'cli/lib/reconcile.js',
    'cli/commands/lifecycle.js',
    'cli/lib/lifecycle-transition.js',
  ];
  if (!isObject(manifest.ownership)) {
    errors.push('SURFACE_OWNERSHIP_INVALID: ownership must be an object.');
  } else {
    for (const mod of requiredOwnership) {
      const value = manifest.ownership[mod];
      if (value !== 'core' && value !== 'shared' && value !== 'enterprise') {
        errors.push(`SURFACE_OWNERSHIP_INVALID: ownership must classify ${mod} as core/shared/enterprise.`);
      }
    }
  }

  if (!isObject(manifest.cli_boundary)) {
    errors.push('SURFACE_BOUNDARY_INVALID: cli_boundary must be an object describing the lazy CLI boundary.');
  }
  return errors;
}

// Loads and structurally validates the manifest. Options:
//   { manifestPath }               — explicit file (default: surfaces.json next to repo root)
//   { sourceDir }                  — when set, every declared include must exist under it
//                                   (missing includes fail with SURFACE_INCLUDE_MISSING).
// Throws a stable Error aggregating all violations.
function loadManifest(manifestPath, opts = {}) {
  const resolved = manifestPath || path.join(__dirname, '..', '..', 'surfaces.json');
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(`SURFACE_MANIFEST_MISSING: cannot read manifest at ${resolved}: ${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`SURFACE_MANIFEST_INVALID: manifest is not valid JSON: ${err.message}`);
  }
  const errors = validateManifestStructure(manifest);
  const sourceDir = opts.sourceDir || null;
  if (errors.length === 0 && sourceDir) {
    for (const [name, role] of Object.entries(manifest.roles)) {
      try {
        expandIncludes(role.includes, sourceDir);
      } catch (err) {
        errors.push(`${err.message} (role ${name})`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  return manifest;
}

module.exports = {
  EXPECTED_ROLES,
  expandIncludes,
  loadManifest,
  patternCovers,
  validateManifestStructure,
};
