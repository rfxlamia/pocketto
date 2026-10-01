'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const enterpriseMeta = require('../../enterprise/meta');
const identity = require('../../cli/lib/identity');
const { FIXED_CLOCK, PR_NUMBER, createFixture } = require('./fixture');
const { allThreads, fakeGh } = require('./remote');
const { loadPhaseHandler } = require('./test-utils');

// RED cycle 4
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given prior fingerprints only at `phases.<phase>.fingerprints`, When phase-complete reconciles findings, Then it reads that legacy path once for compatibility, writes the resulting proof only to `phases.<phase>.review.fingerprints`, and does not delete or mutate the legacy field.
// Exercise through: phase handler metadata migration boundary with real `.pocket-meta.json`.
// Test doubles: fake GitHub transport; use real metadata serialization.
// Expected RED: no v4 nested fingerprint path or legacy read-only fallback exists.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 4: legacy fingerprints are read-only input to the nested v4 proof', (t) => {
  const fixture = createFixture(t);
  const legacy = [{ fingerprint: '9'.repeat(16), thread: 'PRRT_LEGACY' }];
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  delete meta.phases['phase-1'].review;
  meta.phases['phase-1'].fingerprints = legacy;
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  fixture.remote.prs[0].threadPages[1].push({
    id: 'PRRT_LEGACY',
    isResolved: false,
    comments: { nodes: [{ body: 'Legacy finding without a fingerprint tag', path: 'src/old.js', line: 4 }] },
  });
  const handler = loadPhaseHandler();
  assert.ok(handler && typeof handler.handlePhaseComplete === 'function');

  const response = handler.handlePhaseComplete(fixture.event, {
    projectRoot: fixture.root,
    ghRunner: fakeGh(fixture.remote),
    now: () => new Date(FIXED_CLOCK),
  });

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  const resolveCalls = fixture.remote.calls.filter((args) => args[0] === 'api' && args[1] === 'graphql'
    && args.some((arg) => String(arg).includes('resolveReviewThread')));
  assert.equal(resolveCalls.filter((args) => args.some((arg) => arg === 'threadId=PRRT_LEGACY')).length, 1,
    'the legacy thread must be reconciled exactly once');
  const persisted = enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'];
  assert.deepEqual(persisted.fingerprints, legacy, 'the legacy field must remain byte-for-byte equivalent as data');
  assert.deepEqual(persisted.review.fingerprints.map((record) => record.fingerprint), [
    identity.fingerprint({
      file: 'src/worker.js',
      ruleId: 'stage-1:spec-compliance',
      message: 'Missing error handling for invalid input',
      occurrence: 0,
    }),
  ]);
  assert.equal(persisted.review.fingerprints.length, 1, 'v4 proof is written only to the nested canonical path');
});
