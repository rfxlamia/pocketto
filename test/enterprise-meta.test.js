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
