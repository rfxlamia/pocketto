'use strict';

// Legacy-role stability across the wave-1 role additions (plan §5.4):
// staged output of pi/* and claude/* must be byte-identical before and after
// the new roles land.
//
// Two complementary guards:
//  1. Declaration pinning — sha256 over the canonical (key-sorted) JSON of
//     each legacy role declaration, recorded from the green baseline
//     (2026-10-14). Adding wave-1 roles must not alter these declarations;
//     any drift fails loudly here. Regenerate the hashes only with an
//     explicit, reviewed decision to change a legacy role.
//  2. Staging determinism — each legacy role staged twice must produce
//     byte-identical trees (file set + bytes), so the builder cannot silently
//     change what a legacy role ships.
//
// Both are GREEN on the baseline and must stay green after implementation.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const BUILDER = path.join(ROOT, 'scripts', 'build-surfaces.js');

// Recorded from the green baseline (2026-10-14) via:
//   node -e "…sha256(JSON.stringify(canonicalize(manifest.roles[r])))…"
const LEGACY_ROLE_DECLARATION_HASHES = {
  'pi/core': '8144bde9a9c8a373876bd40347eaa813bafca1a5fe8c198daf7daeb76addcbf4',
  'pi/enterprise': 'bfe66d2a29eb9311296e85fc59a98f94b34c2b52dd3584cd172a8a17bc9741b6',
  'claude/core': '3778b36719f5f16cb62f6c2f82962e7dd76b50c3b07e664ff716443cd53aa407',
  'claude/enterprise': 'e22a5ee3f86b14045ed65b7d6a653a2c468dc000ab414f3fc47f9c4693b7ffce',
};

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function hashRoleDeclaration(role) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(role))).digest('hex');
}

function hashStagedTree(dir) {
  const files = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  })(dir);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.slice(dir.length + 1).split(path.sep).join('/'));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

test('legacy role declarations are byte-stable across the wave-1 role additions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'surfaces.json'), 'utf8'));
  for (const [role, expected] of Object.entries(LEGACY_ROLE_DECLARATION_HASHES)) {
    assert.ok(manifest.roles[role], `legacy role ${role} must still be declared`);
    assert.equal(
      hashRoleDeclaration(manifest.roles[role]),
      expected,
      `${role}: declaration drift detected — legacy role declarations must not change when wave-1 roles are added`,
    );
  }
});

test('legacy role staging is byte-identical across repeated builds', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't-compat-stability-'));
  try {
    for (const role of Object.keys(LEGACY_ROLE_DECLARATION_HASHES)) {
      const output = path.join(parent, role.replace('/', '-'));
      execFileSync('node', [BUILDER, '--role', role, '--output', output], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const first = hashStagedTree(output);
      execFileSync('node', [BUILDER, '--role', role, '--output', output], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const second = hashStagedTree(output);
      assert.equal(second, first, `${role}: repeated staging must be byte-identical`);
      assert.ok(first.length === 64, `${role}: staged tree must be non-trivially hashable`);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
