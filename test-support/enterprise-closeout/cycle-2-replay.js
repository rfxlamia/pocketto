'use strict';

// T10 RED cycle 2
// Test file: test/enterprise-closeout.test.js
// Level: integration
// Test intent: Given a tasklist marker was updated before a local ledger timeout, When the same event is drained, Then the handler finds and updates the existing marker without duplication and returns the existing proof.
// Exercise through: closure handler replay with fake paginated issue comments and persisted metadata.
// Test doubles: fake GitHub transport and ledger writer failure; no live GitHub.
// Expected RED: no canonical closure marker replay or reconciling path exists.
// Exact command: `node --test test/enterprise-closeout.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handlePlanClosed } = require('../../enterprise/closure-handler');
const { TASKLIST_MARKER, tasklistBody } = require('../../cli/lib/bodies');
const { enterpriseMeta, makeFixture, makeEvent, makeFakeGh } = require('./fixtures');

test('CYCLE 2: paginated marker replay returns proof after a local ledger timeout', async () => {
  const fixture = makeFixture();
  const event = makeEvent(fixture.planDir);
  const canonicalTasklist = tasklistBody(fixture.log);
  const informational = '# Closeout — demo-plan\n\n- **Result:** CLOSED — informational only';
  const gh = makeFakeGh([
    { id: 812, body: canonicalTasklist },
    { id: 813, body: informational },
  ]);
  let failLedgerWrite = true;
  const writeMeta = (specDir, metadata) => {
    if (failLedgerWrite) throw new Error('simulated ledger timeout after marker update');
    enterpriseMeta.writeMetaFor(specDir, metadata);
  };
  const first = await handlePlanClosed(event, {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
    writeMeta,
  });
  assert.equal(first.status, 'reconciling');
  assert.equal(first.proof_ref, 'meta:github_issue|marker:issue-tasklist');
  assert.match(first.proof_hash, /^[0-9a-f]{64}$/, 'remote success must retain its proof across the local timeout');
  failLedgerWrite = false;
  const replay = await handlePlanClosed(event, {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
    writeMeta,
  });

  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.proof_ref, first.proof_ref);
  assert.equal(replay.proof_hash, first.proof_hash, 'replay must return the original remote proof');
  assert.equal(gh.comments.filter((comment) => comment.body.startsWith(`${TASKLIST_MARKER}\n`)).length, 1);
  assert.equal(gh.comments.find((comment) => comment.id === 813).body, informational);
  assert.equal(gh.calls.filter(({ args }) => args.includes('POST')).length, 0,
    'replay must update the existing marker rather than creating a duplicate');
  assert.equal(gh.calls.filter(({ args }) => args.includes('PATCH')).length, 2);
  assert.equal(gh.calls.filter(({ args }) => args.includes('--paginate') && args.includes('--slurp')).length, 2,
    'each attempt must inspect all issue-comment pages before mutation');
  const persisted = enterpriseMeta.readMetaFor(fixture.specDir).github_issue.tasklist;
  assert.equal(persisted.event_id, event.event_id);
  assert.equal(persisted.proof_hash, replay.proof_hash);
});
