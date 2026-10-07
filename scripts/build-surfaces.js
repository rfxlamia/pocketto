#!/usr/bin/env node
'use strict';

// Manifest-driven surface builder for the four release roles:
// pi/core, pi/enterprise, claude/core, claude/enterprise.
//
//   node scripts/build-surfaces.js --validate [--source <dir>]
//   node scripts/build-surfaces.js --role <role> --output <dir> [--source <dir>]
//
// --validate checks manifest structure and (with --source) include existence.
// --role stages the role's declared includes under --output atomically:
// every include is resolved and scanned BEFORE any write; on any failure the
// target role directory is left untouched and the offending role/path/
// content is reported. Node built-ins only.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'surfaces.json');
const {
  EXPECTED_ROLES,
  expandIncludes,
  loadManifest,
  patternCovers,
} = require('../cli/lib/surface-manifest');

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const opts = { validate: false, role: null, output: null, source: null, manifest: DEFAULT_MANIFEST };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--validate') opts.validate = true;
    else if (a === '--role') opts.role = argv[(i += 1)];
    else if (a === '--output') opts.output = argv[(i += 1)];
    else if (a === '--source') opts.source = argv[(i += 1)];
    else if (a === '--manifest') opts.manifest = argv[(i += 1)];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function isEnterpriseRel(rel) {
  return rel.startsWith('enterprise/') ||
    rel.startsWith('skills/pocket-enterprise/') ||
    rel.startsWith('skills/create-pr/') ||
    rel === 'skills/pocket-development/references/enterprise-reporting.md' ||
    rel === 'cli/commands/mode.js' ||
    rel === 'cli/lib/mode.js' ||
    rel === 'cli/commands/format.js' ||
    rel === 'cli/lib/bodies.js';
}

function validateRoleAgainstSource(name, role, sourceDir, manifest) {
  // 1. Declared includes resolve (missing include fails).
  const expanded = expandIncludes(role.includes, sourceDir);

  // 2. No source owned by two roles: detect duplicates against sibling roles.
  for (const [otherName, otherRole] of Object.entries(manifest.roles)) {
    if (otherName === name) continue;
    // Enterprise deltas legitimately overlap their matching Core requires
    // only via full-surface composition — but within THIS manifest the
    // enterprise includes are disjoint from core includes; check raw overlap.
    const otherExpanded = expandIncludes(otherRole.includes, sourceDir);
    const otherSet = new Set(otherExpanded);
    const overlap = expanded.filter((rel) => otherSet.has(rel));
    const sameHost = role.host === otherRole.host;
    const isRequiredPair =
      (role.kind === 'enterprise' && (role.requires || []).includes(otherName)) ||
      (otherRole.kind === 'enterprise' && (otherRole.requires || []).includes(name));
    if (sameHost && overlap.length > 0 && !isRequiredPair) {
      throw new Error(
        `SURFACE_DUPLICATE_OWNERSHIP: role ${name}: source owned by two roles: ${overlap[0]} (also in ${otherName})`,
      );
    }
    // Enterprise deltas must not duplicate Core-owned sources either:
    // an enterprise role whose include also appears in its required core is invalid.
    if (role.kind === 'enterprise' && isRequiredPair && overlap.length > 0) {
      throw new Error(
        `SURFACE_DUPLICATE_OWNERSHIP: role ${name}: source owned by two roles: ${overlap[0]} (duplicates required core ${otherName})`,
      );
    }
  }

  // 3. Forbidden paths absent from staged set.
  for (const forbidden of role.forbidden_paths || []) {
    const leaked = expanded.filter((rel) => patternCovers(forbidden, rel));
    if (leaked.length > 0) {
      throw new Error(`SURFACE_FORBIDDEN_PATH: role ${name}: forbidden path present: ${leaked[0]}`);
    }
  }

  // 4. Forbidden content absent from staged bytes (scan core roles for
  // enterprise leakage markers; scan enterprise roles for core-only markers).
  for (const marker of role.forbidden_content || []) {
    for (const rel of expanded) {
      const full = path.join(sourceDir, rel);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue; // binary; skip content scan
      }
      if (text.includes(marker)) {
        throw new Error(`SURFACE_FORBIDDEN_CONTENT: role ${name}: forbidden content ${marker} in ${rel}`);
      }
    }
  }

  // 5. Core kind must not stage enterprise-owned sources.
  if (role.kind === 'core') {
    const leaked = expanded.filter(isEnterpriseRel);
    if (leaked.length > 0) {
      throw new Error(`SURFACE_FORBIDDEN_PATH: role ${name}: enterprise-owned source staged in core: ${leaked[0]}`);
    }
  }
  return expanded;
}

// Copies `expanded` (POSIX rel paths, sorted) from sourceDir into a temp
// sibling of targetDir, then renames it over targetDir (same root, atomic).
// The live target is never partially replaced: on any copy failure the temp
// directory is removed and the existing target is untouched.
function atomicStage(expanded, sourceDir, targetDir) {
  const parent = path.dirname(path.resolve(targetDir));
  const base = path.basename(path.resolve(targetDir));
  const tmpDir = path.join(parent, `.${base}.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    for (const rel of expanded) {
      const src = path.join(sourceDir, rel);
      const dest = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    // Same-root atomic replacement of the role directory.
    const hadTarget = fs.existsSync(targetDir);
    const backup = hadTarget ? path.join(parent, `.${base}.bak-${process.pid}-${Date.now()}`) : null;
    try {
      if (hadTarget) fs.renameSync(targetDir, backup);
      fs.renameSync(tmpDir, targetDir);
      if (backup) fs.rmSync(backup, { recursive: true, force: true });
    } catch (err) {
      try {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) { /* best-effort */ }
      try {
        if (backup && fs.existsSync(backup) && !fs.existsSync(targetDir)) {
          fs.renameSync(backup, targetDir);
        } else if (backup && fs.existsSync(backup)) {
          fs.rmSync(backup, { recursive: true, force: true });
        }
      } catch (_) { /* best-effort */ }
      throw err;
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) { /* best-effort */ }
    throw err;
  }
  return targetDir;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      'Usage: node scripts/build-surfaces.js --validate [--source <dir>] [--manifest <path>]\n' +
      '       node scripts/build-surfaces.js --role <role> --output <dir> [--source <dir>] [--manifest <path>]\n',
    );
    return;
  }
  let manifest;
  try {
    manifest = loadManifest(opts.manifest);
  } catch (err) {
    fail('SURFACE_MANIFEST_INVALID', err.message);
    return;
  }

  const sourceDir = opts.source ? path.resolve(opts.source) : ROOT;

  if (opts.validate) {
    try {
      loadManifest(opts.manifest, { sourceDir });
      // Full per-role source validation (ownership + forbidden checks).
      for (const [name, role] of Object.entries(manifest.roles)) {
        validateRoleAgainstSource(name, role, sourceDir, manifest);
      }
    } catch (err) {
      fail('SURFACE_VALIDATION_FAILED', err.message);
      return;
    }
    for (const name of EXPECTED_ROLES) {
      process.stdout.write(`ok ${name}\n`);
    }
    process.stdout.write('surface manifest validation passed\n');
    return;
  }

  if (opts.role) {
    if (!EXPECTED_ROLES.includes(opts.role)) {
      fail('SURFACE_ROLE_INVALID', `unknown role ${opts.role}; expected one of ${EXPECTED_ROLES.join(', ')}`);
      return;
    }
    if (!opts.output) {
      fail('SURFACE_USAGE', 'Usage: node scripts/build-surfaces.js --role <role> --output <dir> [--source <dir>]');
      return;
    }
    const role = manifest.roles[opts.role];
    let expanded;
    try {
      expanded = validateRoleAgainstSource(opts.role, role, sourceDir, manifest);
    } catch (err) {
      fail('SURFACE_VALIDATION_FAILED', err.message);
      return;
    }
    // All checks passed BEFORE any write — now stage atomically.
    try {
      atomicStage(expanded, sourceDir, path.resolve(opts.output));
    } catch (err) {
      fail('SURFACE_STAGE_FAILED', `role ${opts.role}: ${err.message}`);
      return;
    }
    process.stdout.write(`staged ${opts.role}: ${expanded.length} files\n`);
    return;
  }

  fail('SURFACE_USAGE', 'pass --validate or --role <role> --output <dir> (see --help)');
}

if (require.main === module) main();

module.exports = { atomicStage, validateRoleAgainstSource };
