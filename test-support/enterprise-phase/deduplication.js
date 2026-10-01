'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const enterpriseMeta = require('../../enterprise/meta');
const identity = require('../../cli/lib/identity');
const { createFixture } = require('./fixture');
const { allThreads } = require('./remote');
const { handlerOptions, inlinePostCount } = require('./replay-utils');
const { loadPhaseHandler } = require('./test-utils');

// T9 corrective RED cycle 1
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given the same `pocket-fp` fingerprint tag appears in multiple comments belonging to one still-active review thread, When `phase-complete` collects existing remote fingerprints and reconciles current findings, Then that thread ID is represented once for the fingerprint, is not treated as a duplicate, and is not resolved while the finding remains active.
// Exercise through: `enterprise/phase-handler.js` with fake paginated review-thread/comment APIs and real metadata.
// Test doubles: deterministic fake GitHub transport with one thread containing duplicate tagged comments; no live GitHub.
// Expected RED: current collection records the thread ID multiple times and duplicate resolution resolves the active canonical thread.
// Exact command: `node --test test/enterprise-phase.test.js`

test('T9 corrective RED cycle 1: duplicate tags in one active thread keep that thread unresolved', (t) => {
  const fixture = createFixture(t);
  const fingerprint = identity.fingerprint({
    file: 'src/worker.js',
    ruleId: 'stage-1:spec-compliance',
    message: 'Missing error handling for invalid input',
    occurrence: 0,
  });
  const taggedBody = `Missing error handling for invalid input\n\n<!-- pocket-fp:${fingerprint} -->`;
  const activeThread = {
    id: 'PRRT_DUPLICATE_TAGS',
    isResolved: false,
    comments: { nodes: [
      { body: taggedBody, path: 'src/worker.js', line: 18, side: 'RIGHT' },
      { body: taggedBody, path: 'src/worker.js', line: 18, side: 'RIGHT' },
    ] },
  };
  fixture.remote.prs[0].threadPages[1].push(activeThread);
  const handler = loadPhaseHandler();

  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.equal(activeThread.isResolved, false,
    'a thread carrying the active finding must not be resolved as its own duplicate');
  assert.equal(fixture.remote.successfulResolutions, 0, 'no thread resolution is needed for one unique thread ID');
  assert.deepEqual(allThreads(fixture.remote).map((thread) => thread.id), ['PRRT_DUPLICATE_TAGS']);
  assert.deepEqual(enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'].review.fingerprints, [
    { fingerprint, thread: 'PRRT_DUPLICATE_TAGS' },
  ]);
  assert.ok(fixture.remote.calls.some((args) => args[0] === 'api'
    && args[1] === 'graphql' && args.includes('after=cursor-1')),
  'the active thread must be discovered through paginated review-thread transport');
});

// T9 corrective RED cycle 2
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given two task reports in one phase produce the same canonical fingerprint, When `phase-complete` posts new inline findings and persists proof, Then exactly one inline comment is posted and exactly one canonical proof record is stored for that fingerprint.
// Exercise through: full `enterprise/phase-handler.js` aggregation/reconciliation with fake task/PR review-thread responses and real metadata.
// Test doubles: fake GitHub transport and task fixtures with identical findings; do not mock fingerprint hashing or the posting/dedup path.
// Expected RED: identical records are concatenated, set-diff leaves both as new, and duplicate inline posts/proof records result.
// Exact command: `node --test test/enterprise-phase.test.js`

test('T9 corrective RED cycle 2: duplicate task findings post and persist once', (t) => {
  const fixture = createFixture(t);
  const logPath = path.join(fixture.planDir, 'log.json');
  const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  log.phases[0].tasks.push({ id: 'T2', name: 'Repeat input validation', status: 'DONE' });
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  fs.writeFileSync(path.join(fixture.planDir, 'reviews', 'T2-review.json'), `${JSON.stringify({
    task_id: 'T2',
    overall: 'REVIEW_FAIL',
    stage_1: {
      issues: [{
        type: 'spec-compliance',
        location: 'src/worker.js:27',
        description: 'Missing error handling for invalid input',
      }],
    },
    stage_2: { issues: [] },
  }, null, 2)}\n`);
  const handler = loadPhaseHandler();

  const response = handler.handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  const proof = enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'].review.fingerprints;
  const postedThreads = allThreads(fixture.remote);
  assert.deepEqual({
    inlinePosts: inlinePostCount(fixture.remote),
    proofRecords: proof.length,
    representativeLine: postedThreads[0] && postedThreads[0].comments.nodes[0].line,
  }, {
    inlinePosts: 1,
    proofRecords: 1,
    representativeLine: 18,
  }, 'identical fingerprints from later tasks must reuse the first task representative');
});
