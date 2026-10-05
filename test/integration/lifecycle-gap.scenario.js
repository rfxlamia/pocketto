'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLAN_ID } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { installFakeAdapter } = require('./support/enterprise');
const { writeGapDocument, readRemote } = require('./support/lifecycle-state');
const { runCore, assertCliOk } = require('./support/core-cli');

test('revision gaps remain pending with an actionable predecessor diagnostic', (t) => {
  const fixture = createFixture(t);
  const adapterTrace = path.join(fixture.root, 'fake-adapter.jsonl');
  fs.writeFileSync(adapterTrace, '');
  const env = installFakeAdapter(fixture, adapterTrace);
  writeGapDocument(fixture);
  const lifecyclePath = path.join(fixture.specDir, 'lifecycle.json');
  const lifecycleBefore = fs.readFileSync(lifecyclePath);
  const drain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'], env);
  assertRevisionGap(assertCliOk(drain, 'public drain with revision gap'));
  assertUnchangedGapState(fixture, lifecyclePath, lifecycleBefore, adapterTrace);
});

function assertRevisionGap(data) {
  assert.equal(data.plan_id, PLAN_ID);
  assert.equal(data.revision, 5);
  assert.deepEqual(data.deliveries, [{
    event_id: `${PLAN_ID}:phase-complete:r5`, revision: 5, status: 'pending', deferred: true, blocked_by_gap: true,
  }]);
  assert.deepEqual(data.gaps, [{
    plan_id: PLAN_ID,
    blocked_revision: 5,
    missing_predecessor: 4,
    next_step: `Restore or replay lifecycle revision 4 for plan ${PLAN_ID}, then rerun lifecycle drain.`,
  }], 'the gap diagnostic must identify the plan, missing predecessor, and recovery action');
}

function assertUnchangedGapState(fixture, lifecyclePath, lifecycleBefore, adapterTrace) {
  assert.equal(fs.readFileSync(lifecyclePath).toString(), lifecycleBefore.toString(),
    'a blocked gap must not mutate the event ledger or increment attempts');
  assert.equal(fs.readFileSync(adapterTrace, 'utf8'), '', 'the registered adapter must not be invoked across a revision gap');
  assert.deepEqual(readRemote(fixture).calls, [], 'the fake GitHub runner must remain untouched across a gap');
  assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false,
    'a gap must be detected before a worker claim is acquired');
}
