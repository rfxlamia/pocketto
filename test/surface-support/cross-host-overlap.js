'use strict';

// Validator semantics the Copilot reuse strategy depends on (plan §5.1):
// scripts/build-surfaces.js must KEEP permitting include overlap across hosts
// (that is the foundation of copilot/core reusing claude/core's skill set)
// while still rejecting duplicate ownership within one host.
//
// These tests exercise validateRoleAgainstSource directly with synthetic
// manifests so they stay meaningful before and after the wave-1 roles land:
// they pin the validator's logic, not the current role list.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRoleAgainstSource } = require('../../scripts/build-surfaces');

function makeSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cross-host-'));
  for (const skill of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(dir, 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', skill, 'SKILL.md'), `# ${skill}\n`, 'utf8');
  }
  return dir;
}

function syntheticRole(host, kind, includes, requires = []) {
  return {
    host,
    kind,
    requires,
    includes,
    forbidden_paths: ['enterprise/'],
    forbidden_content: ['ENTERPRISE_ONLY_SURFACE'],
  };
}

test('validator permits include overlap across hosts (Copilot reuse foundation)', () => {
  const src = makeSource();
  try {
    const manifest = {
      roles: {
        'claude/core': syntheticRole('claude', 'core', ['skills/alpha/**']),
        // copilot/core reuses claude/core's skill set verbatim: same files,
        // different host — this must NOT raise SURFACE_DUPLICATE_OWNERSHIP.
        'copilot/core': syntheticRole('copilot', 'core', ['skills/alpha/**', 'skills/beta/**']),
      },
    };
    assert.doesNotThrow(
      () => validateRoleAgainstSource('copilot/core', manifest.roles['copilot/core'], src, manifest),
      'cross-host include overlap must be permitted',
    );
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('validator still rejects duplicate ownership within one host', () => {
  const src = makeSource();
  try {
    // Case 1: enterprise role duplicating its required core's sources.
    const enterpriseDup = {
      roles: {
        'pi/core': syntheticRole('pi', 'core', ['skills/alpha/**']),
        'pi/enterprise': syntheticRole('pi', 'enterprise', ['skills/alpha/**', 'skills/beta/**'], ['pi/core']),
      },
    };
    assert.throws(
      () =>
        validateRoleAgainstSource(
          'pi/enterprise',
          enterpriseDup.roles['pi/enterprise'],
          src,
          enterpriseDup,
        ),
      /SURFACE_DUPLICATE_OWNERSHIP/,
      'enterprise role duplicating its required core must fail',
    );

    // Case 2: two core roles of the same host owning the same source.
    const coreDup = {
      roles: {
        'pi/core': syntheticRole('pi', 'core', ['skills/alpha/**']),
        'pi/other': syntheticRole('pi', 'core', ['skills/alpha/**', 'skills/beta/**']),
      },
    };
    assert.throws(
      () => validateRoleAgainstSource('pi/other', coreDup.roles['pi/other'], src, coreDup),
      /SURFACE_DUPLICATE_OWNERSHIP/,
      'same-host core roles must not double-own a source',
    );
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});
