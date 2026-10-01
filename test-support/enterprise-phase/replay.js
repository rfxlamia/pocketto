'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const enterpriseMeta = require('../../enterprise/meta');
const identity = require('../../cli/lib/identity');
const { summaryBody } = require('../../cli/lib/bodies');
const { FIXED_CLOCK, PR_NUMBER, createFixture } = require('./fixture');
const { allComments, allThreads, fakeGh } = require('./remote');
const { loadPhaseHandler } = require('./test-utils');
const { handlerOptions, inlinePostCount, staleResolveCount } = require('./replay-utils');

// RED cycle 5
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given an existing marker comment, prior fingerprints, and an event that already succeeded or partially posted remote findings, When the same event is replayed, Then the earliest marker is updated, duplicate marker comments are collapsed, existing finding threads are kept/resolved by fingerprint, and no duplicate inline mutation occurs.
// Exercise through: phase handler replay with persisted proof and fake comment/thread state.
// Test doubles: deterministic fake GitHub API with call recording; real identity helper behavior.
// Expected RED: no durable phase proof or reconciling path exists.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 5: succeeded and reconciling replay reuse markers and finding threads', async (t) => {
  await runReplayModes(t);
});

async function runReplayModes(t) {
  const currentFingerprint = identity.fingerprint({
    file: 'src/worker.js',
    ruleId: 'stage-1:spec-compliance',
    message: 'Missing error handling for invalid input',
    occurrence: 0,
  });
  const staleFingerprint = '3'.repeat(16);
  for (const mode of ['succeeded', 'reconciling']) {
    await t.test(`${mode} replay reconciles remote proof without duplicate inline calls`, (t) => {
      assertReplayMode(t, mode, currentFingerprint, staleFingerprint);
    });
  }
}

function assertReplayMode(t, mode, currentFingerprint, staleFingerprint) {
  const fixture = createFixture(t);
  configureReplayFixture(fixture, mode, currentFingerprint, staleFingerprint);
  const handler = loadPhaseHandler();
  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  const marker = identity.markerFor('1');
  const remainingMarkers = allComments(fixture.remote, PR_NUMBER).filter((comment) => comment.body.startsWith(marker));
  assert.equal(remainingMarkers.length, 1, 'duplicate markers must collapse to one');
  assert.equal(remainingMarkers[0].id, 3, 'the earliest marker must be retained');
  assert.equal(remainingMarkers[0].body, summaryBody({ phase: 1, verdicts: [{ task: 'T1', verdict: 'FAIL' }], prLinked: true }));
  assert.equal(allThreads(fixture.remote)[0].isResolved, false, 'the current finding thread must be kept');
  assert.equal(allThreads(fixture.remote)[1].isResolved, true, 'the removed finding thread must be resolved');
  assert.equal(inlinePostCount(fixture.remote), 0, 'replay must not post a duplicate inline finding');
  assert.equal(staleResolveCount(fixture.remote), 1, 'stale thread resolution must occur exactly once');
  const persisted = enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'].review.fingerprints;
  assert.deepEqual(persisted, [{ fingerprint: currentFingerprint, thread: 'PRRT_KEEP' }]);
}

function configureReplayFixture(fixture, mode, currentFingerprint, staleFingerprint) {
  const pr = fixture.remote.prs[0];
  const marker = identity.markerFor('1');
  pr.commentPages = [
    [{ id: 3, body: `${marker}\n\nOld summary` }],
    [{ id: 8, body: `${marker}\n\nDuplicate summary` }],
  ];
  pr.threadPages = [[{
    id: 'PRRT_KEEP',
    isResolved: false,
    comments: { nodes: [{ body: `Existing finding\n\n<!-- pocket-fp:${currentFingerprint} -->`, path: 'src/worker.js', line: 18 }] },
  }], [{
    id: 'PRRT_STALE',
    isResolved: false,
    comments: { nodes: [{ body: `Removed finding\n\n<!-- pocket-fp:${staleFingerprint} -->`, path: 'src/old.js', line: 4 }] },
  }]];
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  if (mode === 'succeeded') {
    meta.phases['phase-1'].review = { fingerprints: [
      { fingerprint: currentFingerprint, thread: 'PRRT_KEEP' },
      { fingerprint: staleFingerprint, thread: 'PRRT_STALE' },
    ] };
  } else {
    delete meta.phases['phase-1'].review;
  }
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  fixture.event.delivery.status = mode;
  fixture.event.proof_ref = 'meta:phases.phase-1.github_pr';
  fixture.event.proof_hash = 'b'.repeat(64);
}
