'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID, REPOSITORY, REPOSITORY_URL, ISSUE_NUMBER, PR_NUMBER } = require('./constants');
const { writePlanFixture, initializeFixtureGit } = require('./plan-fixture');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-enterprise-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = writePlanFixture(root);
  initializeFixtureGit(root);
  const fake = installFakeGitHub(root);
  return { root, ...plan, ...fake, env: createEnvironment(fake) };
}

function installFakeGitHub(root) {
  const remotePath = path.join(root, '.fake-github.json');
  const binDir = path.join(root, '.fake-bin');
  const fakeGhPath = path.join(binDir, 'gh');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(remotePath, `${JSON.stringify(initialRemoteState(), null, 2)}\n`);
  fs.copyFileSync(path.join(__dirname, 'fake-gh-runner.js'), fakeGhPath);
  fs.chmodSync(fakeGhPath, 0o755);
  return { remotePath, binDir, fakeGhPath };
}

function initialRemoteState() {
  return {
    calls: [], effects: [], issues: [],
    pullRequests: [{
      number: PR_NUMBER, url: `${REPOSITORY_URL}/pull/${PR_NUMBER}`, state: 'OPEN',
      headRefName: `feature/${PLAN_ID}`, baseRefName: 'main', headRefOid: 'abc123def456',
      title: `Phase 1: ${PLAN_ID}`, body: `Implements ${PLAN_ID}`,
    }],
    comments: {}, nextIssueNumber: ISSUE_NUMBER, nextCommentId: 900,
  };
}

function createEnvironment(fake) {
  const env = { ...process.env };
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) delete env[key];
  env.PATH = `${fake.binDir}${path.delimiter}${env.PATH || ''}`;
  env.FAKE_GH_STATE = fake.remotePath;
  env.FAKE_GH_REPOSITORY = REPOSITORY;
  env.FAKE_GH_REPOSITORY_URL = REPOSITORY_URL;
  env.FAKE_GH_ISSUE_NUMBER = String(ISSUE_NUMBER);
  env.FAKE_GH_PR_NUMBER = String(PR_NUMBER);
  env.FAKE_GH_NOW = FIXED_NOW;
  env.POCKETTO_LIFECYCLE_NOW = FIXED_NOW;
  return env;
}

module.exports = { createFixture };
