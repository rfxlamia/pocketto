const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { BUILDER, LIFECYCLE_CORE_MODULES, ROOT } = require('./shared');

function assertPiCoreEntryStarts() {
  // Stage from the real repo source (fixture trees hold placeholders that
  // cannot be required), then demand the lifecycle files and a loadable
  // staged entry: requiring the staged cli/index.js exercises the eager
  // Core command graph (including lifecycle) without enterprise modules.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't5-core-entry-'));
  try {
    const out = path.join(parent, 'pi-core');
    const stdout = execFileSync(
      'node',
      [BUILDER, '--role', 'pi/core', '--output', out],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.ok(stdout.includes('staged pi/core'), 'role staging must report the staged role');
    assert.ok(
      fs.existsSync(path.join(out, 'cli/commands/lifecycle.js')),
      'staged core must contain cli/commands/lifecycle.js',
    );
    assert.ok(
      fs.existsSync(path.join(out, 'cli/lib/lifecycle-transition.js')),
      'staged core must contain cli/lib/lifecycle-transition.js',
    );
    require(path.join(out, 'cli', 'index.js'));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function assertCoreLifecycleDependenciesLoad() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't4-core-dispatcher-'));
  try {
    for (const role of ['pi/core', 'claude/core']) {
      const out = path.join(parent, role.replace('/', '-'));
      const stdout = execFileSync('node', [BUILDER, '--role', role, '--output', out], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      assert.ok(stdout.includes(`staged ${role}`), `${role} must be staged`);
      for (const modulePath of LIFECYCLE_CORE_MODULES) {
        assert.ok(
          fs.existsSync(path.join(out, modulePath)),
          `${role} staged Core must include ${modulePath}`,
        );
      }
      assert.doesNotThrow(
        () => require(path.join(out, 'cli', 'index.js')),
        `${role} staged CLI entry must load with its lifecycle dispatcher`,
      );
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

test('staged pi/core contains the lifecycle files and its entry starts', () => {
  assertPiCoreEntryStarts();
});

test('staged Core roles include lifecycle dispatch dependencies and load their CLI entries', () => {
  assertCoreLifecycleDependenciesLoad();
});
