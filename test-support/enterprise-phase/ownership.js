'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const enterpriseMeta = require('../../enterprise/meta');
const identity = require('../../cli/lib/identity');
const { FIXED_CLOCK, OWNER, PR_NUMBER, REPOSITORY, createFixture } = require('./fixture');
const { allComments, allThreads, fakeGh, makePr } = require('./remote');
const { addPhaseMarker, isRemoteMutation, loadPhaseHandler } = require('./test-utils');

// RED cycle 3
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given positive PR metadata pointing to the wrong origin, closed state, wrong branch, or wrong phase, When metadata-first validation runs, Then the handler rejects it and safely falls back to exact branch/phase search/manual resolution; given missing metadata and zero branch matches, multiple matches, foreign/closed/wrong-branch/wrong-phase PR, or a missing required PR, Then it returns `PR_REQUIRED` or terminal manual resolution, creates no PR, writes no comments/metadata, and preserves the event for retry/manual action.
// Exercise through: the full phase handler using fake repository/PR responses.
// Test doubles: fake `gh pr list/view` and comment APIs; no real network.
// Expected RED: no adapter handler enforces metadata validation, safe fallback, or the no-auto-create-PR rule.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 3: metadata validation falls back safely and ambiguous PRs stay untouched', async (t) => {
  await runInvalidMetadataCases(t);
  await t.test('missing metadata finds one exact branch/phase PR', (t) => assertExactBranchPhasePr(t));
  await runAmbiguousSearchCases(t);
});

async function runInvalidMetadataCases(t) {
  const cases = [
    ['wrong origin', (pr) => { pr.url = 'https://github.com/foreign/repo/pull/51'; }],
    ['closed state', (pr) => { pr.state = 'CLOSED'; }],
    ['wrong branch', (pr) => { pr.headRefName = 'feature/another-plan'; }],
    ['wrong phase', (pr) => addPhaseMarker(pr, 2, 11)],
  ];
  for (const [name, invalidate] of cases) {
    await t.test(`invalid metadata with ${name} falls back to the exact open PR`, (t) => {
      assertInvalidMetadataFallback(t, name, invalidate);
    });
  }
}

function assertInvalidMetadataFallback(t, name, invalidate) {
  const fixture = createFixture(t);
  const invalid = makePr(51);
  invalidate(invalid);
  if (name !== 'wrong phase') addPhaseMarker(invalid, 1, 10);
  const valid = makePr(52);
  addPhaseMarker(valid, 1, 20);
  fixture.remote.prs = [invalid, valid];
  enterpriseMeta.setPrIdentity(fixture.specDir, 'phase-1', { number: invalid.number, url: invalid.url });
  const invalidCommentBefore = JSON.stringify(allComments(fixture.remote, invalid.number));
  const handler = loadPhaseHandler();
  assert.ok(handler && typeof handler.handlePhaseComplete === 'function');

  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.deepEqual(enterpriseMeta.getPrIdentity(fixture.specDir, 'phase-1'), {
    number: valid.number,
    url: valid.url,
  });
  assert.equal(JSON.stringify(allComments(fixture.remote, invalid.number)), invalidCommentBefore,
    'invalid metadata PR must never be mutated');
  assert.equal(allComments(fixture.remote, valid.number).filter((comment) => comment.body.startsWith(identity.markerFor('1'))).length, 1);
  assert.equal(allThreads(fixture.remote, invalid.number).length, 0, 'inline mutations must avoid the invalid PR');
  assert.equal(allThreads(fixture.remote, valid.number).length, 1, 'inline mutations must target the exact branch/phase PR');
}

function assertExactBranchPhasePr(t) {
  const fixture = createFixture(t);
  addPhaseMarker(fixture.remote.prs[0], 1, 30);
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  delete meta.phases['phase-1'].github_pr;
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  const handler = loadPhaseHandler();

  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.deepEqual(enterpriseMeta.getPrIdentity(fixture.specDir, 'phase-1'), {
    number: PR_NUMBER,
    url: `https://github.com/${OWNER}/${REPOSITORY}/pull/${PR_NUMBER}`,
  });
  assert.ok(!fixture.remote.calls.some((args) => args[0] === 'pr' && args[1] === 'create'));
}

async function runAmbiguousSearchCases(t) {
  const cases = [
    ['zero branch matches', []],
    ['multiple matches', [makePr(61), makePr(62)]],
    ['foreign PR', [makePr(63)]],
    ['closed PR', [makePr(64)]],
    ['wrong-branch PR', [makePr(65)]],
    ['wrong-phase PR', [makePr(66)]],
  ];
  for (const [name, prs] of cases) {
    await t.test(`missing metadata with ${name} does not mutate`, (t) => {
      assertAmbiguousSearchDoesNotMutate(t, name, prs);
    });
  }
}

function assertAmbiguousSearchDoesNotMutate(t, name, prs) {
  const fixture = createFixture(t);
  fixture.remote.prs = prs;
  for (const pr of prs) addPhaseMarker(pr, 1, pr.number);
  if (name === 'foreign PR') prs[0].url = 'https://github.com/foreign/repo/pull/63';
  if (name === 'closed PR') prs[0].state = 'CLOSED';
  if (name === 'wrong-branch PR') prs[0].headRefName = 'feature/another-plan';
  if (name === 'wrong-phase PR') {
    prs[0].commentPages[1] = [];
    addPhaseMarker(prs[0], 2, 66);
  }
  if (name === 'multiple matches') addPhaseMarker(prs[1], 1, 67);
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  delete meta.phases['phase-1'].github_pr;
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  const metaPath = path.join(fixture.specDir, '.pocket-meta.json');
  const beforeMeta = fs.readFileSync(metaPath, 'utf8');
  const beforeEvent = JSON.stringify(fixture.event);
  const beforeComments = JSON.stringify(prs.map((pr) => allComments(fixture.remote, pr.number)));
  const handler = loadPhaseHandler();

  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.ok(response.error && (response.error.code === 'PR_REQUIRED' || response.status === 'terminal'), JSON.stringify(response));
  assert.equal(fixture.remote.calls.filter(isRemoteMutation).length, 0);
  assert.ok(!fixture.remote.calls.some((args) => args[0] === 'pr' && args[1] === 'create'), 'the adapter must never create a PR');
  assert.equal(fs.readFileSync(metaPath, 'utf8'), beforeMeta, 'failed lookup must not write metadata proof');
  assert.equal(JSON.stringify(fixture.event), beforeEvent, 'failed lookup must preserve the event for retry/manual action');
  assert.equal(JSON.stringify(prs.map((pr) => allComments(fixture.remote, pr.number))), beforeComments);
}

function handlerOptions(fixture) {
  return {
    projectRoot: fixture.root,
    ghRunner: fakeGh(fixture.remote),
    now: () => new Date(FIXED_CLOCK),
  };
}
