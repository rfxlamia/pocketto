'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIXED_NOW } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { runCore, assertCliOk } = require('./support/core-cli');
const { readLifecycle, readRemote } = require('./support/lifecycle-state');

const DELAYS_MS = [1000, 5000, 30000, 120000, 600000];

test('retryable Enterprise transport failures exhaust the Core delivery budget', (t) => {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const eventId = transitionApprovedSpec(fixture).event_id;
  let now = Date.parse(FIXED_NOW);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assertCliOk(drainAt(fixture, now), `retryable transport attempt ${attempt}`);
    const event = eventById(fixture, eventId);
    assert.equal(event.delivery.status, 'retryable');
    assert.equal(event.delivery.attempts, attempt);
    assert.equal(event.delivery.error.code, 'GH_TIMEOUT');
    assert.equal(event.delivery.manual_resolution, false);
    assert.equal(event.delivery.next_attempt_at, new Date(now + DELAYS_MS[attempt - 1]).toISOString());
    now += DELAYS_MS[attempt - 1];
  }

  assertCliOk(drainAt(fixture, now), 'budget exhaustion drain');
  const exhausted = eventById(fixture, eventId);
  assert.equal(exhausted.delivery.status, 'terminal');
  assert.equal(exhausted.delivery.attempts, 6);
  assert.equal(exhausted.delivery.manual_resolution, true);
  assert.equal(exhausted.delivery.error.code, 'MAX_ADAPTER_ATTEMPTS_EXCEEDED');
  assert.equal(exhausted.delivery.next_attempt_at, null);
  const remote = readRemote(fixture);
  assert.equal(remote.issues.length, 0, 'a failed origin lookup must not create an issue');
  assert.equal(remote.calls.length, 6, 'each invocation tries the transport once');

  const replay = drainAt(fixture, now + 1000);
  assert.deepEqual(assertCliOk(replay, 'drain after the budget is exhausted').deliveries, []);
  assert.equal(readRemote(fixture).calls.length, remote.calls.length);
});

function drainAt(fixture, nowMs) {
  return runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'], {
    ...fixture.env,
    FAKE_GH_RETRYABLE_FAILURE: '1',
    POCKETTO_LIFECYCLE_NOW: new Date(nowMs).toISOString(),
  });
}

function eventById(fixture, eventId) {
  return readLifecycle(fixture).events.find((event) => event.event_id === eventId);
}
