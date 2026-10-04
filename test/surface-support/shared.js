const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MANIFEST_PATH = path.join(ROOT, 'surfaces.json');
const BUILDER = path.join(ROOT, 'scripts', 'build-surfaces.js');
const LIB = path.join(ROOT, 'cli', 'lib', 'surface-manifest.js');

const EXPECTED_ROLES = ['pi/core', 'pi/enterprise', 'claude/core', 'claude/enterprise'];
const LIFECYCLE_CORE_MODULES = [
  'cli/lib/lifecycle-dispatch.js',
  'cli/lib/lifecycle-drain.js',
  'cli/lib/lifecycle-projection.js',
  'cli/lib/lifecycle-claims.js',
  'cli/lib/lifecycle-adapter.js',
  'cli/lib/lifecycle-retry.js',
  'cli/lib/lifecycle-lock.js',
  'cli/lib/lifecycle-artifact-validation.js',
  'cli/lib/lifecycle-delivery-store.js',
  'cli/lib/lifecycle-delivery-validation.js',
];

const ENTERPRISE_RUNTIME_FILES = [
  'enterprise/cli.js',
  'enterprise/dispatch.js',
  'enterprise/adapter.js',
  'enterprise/registration.js',
  'enterprise/registration-record.js',
  'enterprise/registration-version.js',
  'enterprise/registration-preflight.js',
  'enterprise/github.js',
  'enterprise/meta.js',
  'enterprise/retry.js',
];
const T8_ISSUE_RUNTIME_FILES = [
  'enterprise/issue-handler.js',
  'enterprise/issue-handler-identity.js',
  'enterprise/issue-handler-proof.js',
  'enterprise/issue-handler-reconcile.js',
];
const T10_CLOSURE_RUNTIME_FILES = [
  'enterprise/closure-handler.js',
  'enterprise/closure-plan.js',
  'enterprise/closure-prerequisites.js',
  'enterprise/closure-tasklist.js',
];

const NAMED_CLI_MODULES = [
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

function makeFixtureSource() {
  // Materialize every declared manifest include so the fixture source tree
  // is complete: exact files get placeholders, `<dir>/**` globs get two
  // sample files. Forbidden paths are never created.
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't5-surface-src-'));
  const seen = new Set();
  for (const role of Object.values(manifest.roles)) {
    for (const inc of role.includes) {
      if (seen.has(inc)) continue;
      seen.add(inc);
      if (inc.endsWith('/**')) {
        const base = inc.slice(0, -3);
        for (const sample of ['SKILL.md', 'references/sample.md']) {
          const full = path.join(dir, base, sample);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, `# fixture ${base}/${sample}\n`, 'utf8');
        }
      } else {
        const full = path.join(dir, inc);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, `# fixture ${inc}\n`, 'utf8');
      }
    }
  }
  return dir;
}

module.exports = {
  BUILDER,
  ENTERPRISE_RUNTIME_FILES,
  EXPECTED_ROLES,
  LIB,
  LIFECYCLE_CORE_MODULES,
  MANIFEST_PATH,
  NAMED_CLI_MODULES,
  ROOT,
  T8_ISSUE_RUNTIME_FILES,
  T10_CLOSURE_RUNTIME_FILES,
  makeFixtureSource,
};
