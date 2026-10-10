'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const enterpriseMeta = require('../enterprise/meta');

function makeMetaFixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-meta-'));
  const temporarySpecDir = path.join(temporaryRoot, 'docs', 'pocket', 'spec', 'meta-guard-plan');
  fs.mkdirSync(temporarySpecDir, { recursive: true });
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = fs.realpathSync(temporaryRoot);
  const specDir = fs.realpathSync(temporarySpecDir);
  return {
    projectRoot,
    specDir,
    context: { projectRoot, specDir },
    metadataPath: path.join(specDir, '.pocket-meta.json'),
  };
}

function writeMetaFixture(metadataPath) {
  const value = Buffer.from('{\n  "slug": "meta-guard-plan",\n  "github_issue": {"number": 73},\n  "phases": {},\n  "external_tracker": null\n}\n');
  fs.writeFileSync(metadataPath, value);
  return value;
}

test('metadata seam reads and writes an internal same-spec-directory symlink', (t) => {
  const fixture = makeMetaFixture(t);
  const targetPath = path.join(fixture.specDir, '.pocket-meta-target.json');
  const originalBytes = writeMetaFixture(targetPath);
  fs.symlinkSync(targetPath, fixture.metadataPath, 'file');

  const checked = enterpriseMeta.preflightMetaFor(fixture.specDir, fixture.context);
  assert.equal(checked.exists, true);
  assert.equal(enterpriseMeta.readMetaFor(fixture.specDir, fixture.context).github_issue.number, 73);
  enterpriseMeta.writeMetaFor(fixture.specDir, {
    slug: 'meta-guard-plan',
    github_issue: { number: 74 },
    phases: {},
    external_tracker: null,
  }, fixture.context);

  const written = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  assert.equal(written.github_issue.number, 74);
  assert.notDeepEqual(fs.readFileSync(targetPath), originalBytes);
  assert.equal(fs.lstatSync(fixture.metadataPath).isSymbolicLink(), true);
});

test('metadata seam rejects external symlinks before read or write and keeps sentinel bytes unchanged', (t) => {
  const fixture = makeMetaFixture(t);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-meta-external-'));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const externalPath = path.join(externalRoot, '.pocket-meta.json');
  const sentinelBytes = writeMetaFixture(externalPath);
  fs.symlinkSync(externalPath, fixture.metadataPath, 'file');

  assert.throws(
    () => enterpriseMeta.preflightMetaFor(fixture.specDir, fixture.context),
    (error) => error.code === 'ENTERPRISE_META_PATH_INVALID' && !error.message.includes(externalRoot),
  );
  assert.throws(
    () => enterpriseMeta.readMetaFor(fixture.specDir, fixture.context),
    (error) => error.code === 'ENTERPRISE_META_PATH_INVALID' && !error.message.includes(externalRoot),
  );
  assert.throws(
    () => enterpriseMeta.writeMetaFor(fixture.specDir, { github_issue: { number: 99 } }, fixture.context),
    (error) => error.code === 'ENTERPRISE_META_PATH_INVALID' && !error.message.includes(externalRoot),
  );
  assert.deepEqual(fs.readFileSync(externalPath), sentinelBytes);
});

test('metadata seam distinguishes absent metadata from dangling metadata symlinks', (t) => {
  const fixture = makeMetaFixture(t);

  const absent = enterpriseMeta.preflightMetaFor(fixture.specDir, fixture.context, { allowMissing: true });
  assert.equal(absent.exists, false);
  assert.throws(
    () => enterpriseMeta.preflightMetaFor(fixture.specDir, fixture.context),
    (error) => error.code === 'ENTERPRISE_META_MISSING',
  );

  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-meta-dangling-'));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const missingTarget = path.join(externalRoot, 'missing.json');
  fs.symlinkSync(missingTarget, fixture.metadataPath, 'file');
  assert.throws(
    () => enterpriseMeta.preflightMetaFor(fixture.specDir, fixture.context, { allowMissing: true }),
    (error) => error.code === 'ENTERPRISE_META_PATH_INVALID' && !error.message.includes(externalRoot),
  );
  assert.throws(
    () => enterpriseMeta.readMetaFor(fixture.specDir, fixture.context),
    (error) => error.code === 'ENTERPRISE_META_PATH_INVALID' && !error.message.includes(externalRoot),
  );
});

// T9: per-SHA push approval recorded by `enterprise/cli.js consent-push`.

const { execFileSync } = require('node:child_process');
const CONSENT_CLI = path.resolve(__dirname, '../enterprise/cli.js');
const CONSENT_SHA = '0123456789abcdef0123456789abcdef01234567';
const SEEDED_META = {
  slug: 'consent-plan',
  github_issue: { number: 73, url: 'https://github.com/example/repo/issues/73' },
  phases: { 'phase-1': { github_pr: { number: 5, url: 'https://github.com/example/repo/pull/5' } } },
  external_tracker: null,
};

function makeConsentFixture(t, { withMeta = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-consent-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const specDir = path.join(root, 'docs', 'pocket', 'spec', 'consent-plan');
  fs.mkdirSync(specDir, { recursive: true });
  const realSpec = fs.realpathSync(specDir);
  const metaPath = path.join(realSpec, '.pocket-meta.json');
  if (withMeta) fs.writeFileSync(metaPath, `${JSON.stringify(SEEDED_META, null, 2)}\n`);
  return { root, specDir: realSpec, metaPath };
}

function runConsentPush(args) {
  try {
    const stdout = execFileSync(process.execPath, [CONSENT_CLI, 'consent-push', ...args, '--json'], { encoding: 'utf8' });
    return { exit: 0, json: JSON.parse(stdout) };
  } catch (err) {
    return { exit: err.status ?? 1, json: JSON.parse((err.stdout || '').toString()) };
  }
}

test('consent-push records a SHA-bound approval and preserves issue identity and unrelated metadata', (t) => {
  const fixture = makeConsentFixture(t);
  const res = runConsentPush([fixture.root, fixture.specDir, 'phase-1', '--sha', CONSENT_SHA]);
  assert.equal(res.exit, 0, `consent-push should succeed: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.ok, true);

  const approval = enterpriseMeta.getPushApproval(fixture.specDir, 'phase-1');
  assert.equal(approval.sha, CONSENT_SHA, 'approval must be bound to the given SHA');
  assert.equal(typeof approval.approved_at, 'string');
  assert.equal(Number.isNaN(Date.parse(approval.approved_at)), false, 'approved_at must be an ISO timestamp');

  assert.deepEqual(enterpriseMeta.getIssueIdentity(fixture.specDir), SEEDED_META.github_issue, 'issue identity must be unchanged');
  const after = JSON.parse(fs.readFileSync(fixture.metaPath, 'utf8'));
  assert.equal(after.slug, 'consent-plan', 'unrelated slug must be preserved');
  assert.deepEqual(after.phases['phase-1'].github_pr, SEEDED_META.phases['phase-1'].github_pr, 'sibling PR identity must be preserved');
  assert.equal(after.phases['phase-1'].push_approval.sha, CONSENT_SHA);
});

test('consent-push validation rejects malformed sha or phase key with no metadata write', (t) => {
  const cases = [
    ['short sha', ['--sha', 'abc123'], 'phase-1'],
    ['uppercase sha', ['--sha', CONSENT_SHA.toUpperCase()], 'phase-1'],
    ['non-numeric phase key', ['--sha', CONSENT_SHA], 'phase-x'],
    ['zero phase key', ['--sha', CONSENT_SHA], 'phase-0'],
    ['leading-zero phase key', ['--sha', CONSENT_SHA], 'phase-01'],
    ['missing sha value', ['--sha'], 'phase-1'],
  ];
  for (const [label, shaArgs, phaseKey] of cases) {
    const fixture = makeConsentFixture(t);
    const before = fs.readFileSync(fixture.metaPath);
    const res = runConsentPush([fixture.root, fixture.specDir, phaseKey, ...shaArgs]);
    assert.equal(res.exit, 1, `${label} must exit 1`);
    assert.equal(res.json.ok, false, `${label} must be ok:false`);
    assert.equal(res.json.error.code, 'ENTERPRISE_CONSENT_INVALID', `${label} must use the validation code`);
    assert.deepEqual(fs.readFileSync(fixture.metaPath), before, `${label} must leave .pocket-meta.json byte-identical`);
  }

  const bare = makeConsentFixture(t, { withMeta: false });
  const missing = runConsentPush([bare.root, bare.specDir, 'phase-1', '--sha', CONSENT_SHA]);
  assert.equal(missing.json.ok, false, 'a missing .pocket-meta.json must fail closed');
  assert.equal(missing.json.error.code, 'ENTERPRISE_META_MISSING');
  assert.equal(fs.existsSync(bare.metaPath), false, 'consent-push must not create metadata when it is missing');
});
