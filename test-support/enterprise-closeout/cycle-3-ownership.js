'use strict';

// T10 RED cycle 3
// Test file: test/enterprise-closeout.test.js
// Level: integration
// Test intent: Given the issue is absent, foreign, closed, or ownership is ambiguous, When `plan-closed` runs, Then it returns `ISSUE_REQUIRED` or terminal manual resolution, writes no tasklist/closeout remote mutation, and leaves local state safe.
// Exercise through: closure handler issue lookup boundary.
// Test doubles: fake paginated issue comments/metadata; no live GitHub.
// Expected RED: no closure issue prerequisite or no-mutation failure path exists.
// Exact command: `node --test test/enterprise-closeout.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handlePlanClosed } = require('../../enterprise/closure-handler');
const { fs, path, enterpriseMeta, ISSUE, ISSUE_NUMBER, PLAN_ID, makeFixture, makeEvent, makeFakeGh } = require('./fixtures');

const scenarios = [
  {
    name: 'missing issue metadata',
    prepare: (fixture) => {
      const metadata = enterpriseMeta.readMetaFor(fixture.specDir);
      metadata.github_issue = {};
      enterpriseMeta.writeMetaFor(fixture.specDir, metadata);
    },
    issue: ISSUE,
    expectedCode: 'ISSUE_REQUIRED',
  },
  {
    name: 'foreign metadata URL',
    prepare: (fixture) => {
      const metadata = enterpriseMeta.readMetaFor(fixture.specDir);
      metadata.github_issue.url = 'https://github.com/foreign/repo/issues/73';
      enterpriseMeta.writeMetaFor(fixture.specDir, metadata);
    },
    issue: ISSUE,
    expectedCode: 'ISSUE_OWNERSHIP_AMBIGUOUS',
  },
  {
    name: 'closed issue',
    prepare: () => {},
    issue: { ...ISSUE, state: 'closed' },
    expectedCode: 'ISSUE_CLOSED',
  },
  {
    name: 'issue response points to a foreign repository',
    prepare: () => {},
    issue: {
      number: ISSUE_NUMBER,
      state: 'open',
      title: `pocket-plan: ${PLAN_ID}`,
      body: `docs/pocket/spec/${PLAN_ID}/core.md`,
      html_url: 'https://github.com/foreign/repo/issues/73',
    },
    expectedCode: 'ISSUE_OWNERSHIP_AMBIGUOUS',
  },
];

async function assertIssueRejected(scenario) {
  const fixture = makeFixture();
  scenario.prepare(fixture);
  const event = makeEvent(fixture.planDir);
  const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
  const beforeMetadata = fs.readFileSync(metadataPath, 'utf8');
  const gh = makeFakeGh([], scenario.issue);
  const result = await handlePlanClosed(event, {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
  });
  assert.equal(result.status, 'terminal', `${scenario.name} must require safe manual resolution`);
  assert.equal(result.error.code, scenario.expectedCode, `${scenario.name} must return a stable prerequisite code`);
  assert.equal(gh.comments.length, 0, `${scenario.name}: no remote marker may be written`);
  assert.equal(gh.calls.filter(({ args }) => ['POST', 'PATCH', 'DELETE'].some((method) => args.includes(method))).length, 0,
    `${scenario.name}: no GitHub mutation may run`);
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), false,
    `${scenario.name}: no local closeout may be written`);
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), beforeMetadata,
    `${scenario.name}: ownership failure must leave local metadata unchanged`);
}

test('CYCLE 3: missing, foreign, closed, or ambiguous issue ownership fails without mutation', async (t) => {
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => assertIssueRejected(scenario));
  }
});
