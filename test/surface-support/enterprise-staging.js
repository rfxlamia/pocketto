const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  BUILDER,
  ENTERPRISE_RUNTIME_FILES,
  EXPECTED_ROLES,
  ROOT,
  T8_ISSUE_RUNTIME_FILES,
} = require('./shared');

function assertEnterpriseRuntimeShipsOnlyForEnterpriseRoles() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't7-enterprise-surfaces-'));
  try {
    const staged = {};
    for (const role of EXPECTED_ROLES) {
      const out = path.join(parent, role.replace('/', '-'));
      execFileSync('node', [BUILDER, '--role', role, '--output', out], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      staged[role] = ENTERPRISE_RUNTIME_FILES.filter((rel) =>
        fs.existsSync(path.join(out, rel)),
      );
    }

    const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const packed = new Set((JSON.parse(packJson)[0].files || []).map((file) => file.path));
    const packedRuntime = ENTERPRISE_RUNTIME_FILES.filter((rel) => packed.has(rel));

    assert.deepEqual(
      {
        staged,
        packed: packedRuntime,
      },
      {
        staged: {
          'pi/core': [],
          'pi/enterprise': ENTERPRISE_RUNTIME_FILES,
          'claude/core': [],
          'claude/enterprise': ENTERPRISE_RUNTIME_FILES,
        },
        packed: ENTERPRISE_RUNTIME_FILES,
      },
      'all six T7 runtime modules must ship in both Enterprise roles and the package, never in Core',
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function assertIssueHandlerIsEnterpriseOnlyInRolesAndPackage() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't8-issue-surfaces-'));
  try {
    const staged = {};
    for (const role of EXPECTED_ROLES) {
      const out = path.join(parent, role.replace('/', '-'));
      execFileSync('node', [BUILDER, '--role', role, '--output', out], { cwd: ROOT, encoding: 'utf8' });
      staged[role] = T8_ISSUE_RUNTIME_FILES.filter((rel) => fs.existsSync(path.join(out, rel)));
    }
    const packageFiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
    const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
    const packed = new Set((JSON.parse(packJson)[0].files || []).map((file) => file.path));
    for (const rel of T8_ISSUE_RUNTIME_FILES) {
      assert.ok(!staged['pi/core'].includes(rel), `pi/core must exclude ${rel}`);
      assert.ok(!staged['claude/core'].includes(rel), `claude/core must exclude ${rel}`);
      assert.ok(staged['pi/enterprise'].includes(rel), `pi/enterprise must include ${rel}`);
      assert.ok(staged['claude/enterprise'].includes(rel), `claude/enterprise must include ${rel}`);
      assert.ok(packageFiles.includes(rel), `package.json files must explicitly include ${rel}`);
      assert.ok(packed.has(rel), `npm pack must include ${rel}`);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

test('Enterprise runtime is staged only in Enterprise roles and selected for the v4 package', () => {
  assertEnterpriseRuntimeShipsOnlyForEnterpriseRoles();
});

test('T8 issue handler is shipped in Enterprise roles and package only', () => {
  assertIssueHandlerIsEnterpriseOnlyInRolesAndPackage();
});
