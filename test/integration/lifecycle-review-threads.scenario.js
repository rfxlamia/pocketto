'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PHASE_PATH } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { runCore, assertCliOk } = require('./support/core-cli');
const { readRemote } = require('./support/lifecycle-state');

test('phase-complete resolves a stale review thread from a later GraphQL page', (t) => {
  const fixture = createFixture(t);
  seedStaleThread(fixture);
  initializePlan(fixture);
  transitionApprovedSpec(fixture);
  const review = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'REVIEW', '--json', '--contract', '3',
  ]);
  assertCliOk(review, 'public log update REVIEW');

  const drained = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  assertCliOk(drained, 'drain with a paginated stale review thread');

  const remote = readRemote(fixture);
  assert.equal(remote.pullRequests[0].reviewThreadPages[1][0].isResolved, true);
  assert.deepEqual(
    remote.effects.filter((effect) => effect.kind === 'review-thread-resolve').map((effect) => effect.id),
    ['PRRT_STALE'],
  );
  const cursors = remote.calls
    .filter((call) => call[0] === 'api' && call[1] === 'graphql' && call.some((arg) => String(arg).includes('reviewThreads')))
    .map((call) => call.find((arg) => String(arg).startsWith('after=')));
  assert.deepEqual(cursors, ['after=null', 'after=cursor-1']);
});

function seedStaleThread(fixture) {
  const remote = readRemote(fixture);
  remote.pullRequests[0].reviewThreadPages = [
    [],
    [{
      id: 'PRRT_STALE',
      isResolved: false,
      comments: {
        nodes: [{
          body: 'Removed finding\n\n<!-- pocket-fp:0123456789abcdef -->',
          path: 'src/worker.js',
          line: 18,
        }],
      },
    }],
  ];
  fs.writeFileSync(fixture.remotePath, `${JSON.stringify(remote, null, 2)}\n`);
}
