'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID, PHASE_PATH } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { runCore, assertCliOk } = require('./support/core-cli');
const { readRemote, readLifecycle } = require('./support/lifecycle-state');
const { installRegisteredEnterpriseReadFaultGate } = require('./support/failure-gates');
const { sha256, writeFile } = require('./support/files');
const { commitTransition } = require('../../cli/lib/lifecycle-store');
const { isDeepStrictEqual } = require('node:util');

function assertArtifactStateIsTerminal(t, artifactState) {
  const fixture = createFixture(t);
  initializePlan(fixture);
  const eventId = transitionApprovedSpec(fixture).event_id;
  alterCommittedArtifact(fixture, artifactState);
  const drain = runCore(fixture, ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3']);
  const data = assertCliOk(drain, `public drain with ${artifactState} committed artifact`);
  assert.deepEqual(data.deliveries.map(({ event_id, revision, status, error }) => ({
    event_id, revision, status, code: error && error.code,
  })), [{ event_id: eventId, revision: 1, status: 'terminal', code: 'STALE_ARTIFACT' }]);
  assertStaleArtifactHasNoRemoteEffects(fixture);
}

function alterCommittedArtifact(fixture, artifactState) {
  const artifactPath = path.join(fixture.specDir, 'approved-spec.md');
  if (artifactState === 'missing') fs.unlinkSync(artifactPath);
  else fs.writeFileSync(artifactPath, `${fixture.approvedSpec}Changed after commit.\n`);
}

function assertStaleArtifactHasNoRemoteEffects(fixture) {
  const event = readLifecycle(fixture).events[0];
  assert.equal(event.delivery.status, 'terminal');
  assert.equal(event.delivery.error.code, 'STALE_ARTIFACT');
  const remote = readRemote(fixture);
  assert.deepEqual(remote.calls, [], 'artifact validation must stop before the fake GitHub transport');
  assert.deepEqual(remote.effects, []);
  assert.deepEqual(remote.issues, []);
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.specDir, '.pocket-meta.json'), 'utf8'));
  assert.equal(metadata.github_issue.ownership, undefined, 'stale content must not write Enterprise issue ownership proof');
  assert.equal(metadata.github_issue.number, undefined);
  assert.equal(fs.existsSync(path.join(fixture.specDir, '.lifecycle.lock')), false);
}

module.exports = {
  assertArtifactStateIsTerminal,
};
