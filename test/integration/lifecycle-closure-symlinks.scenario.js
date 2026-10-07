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

const {
  commitPlanClosedEvent,
  assertClosureSymlinkIsTerminal,
  deliverySummary,
  readMetadata,
} = require('./lifecycle-closure-artifact.helpers.js');

test('plan-closed accepts an in-root symlink to identical committed evidence', (t) => {
  const fixture = createFixture(t);
  const committedEvent = commitPlanClosedEvent(fixture);
  const committedRef = committedEvent.artifact_refs.find((ref) => ref.root === 'plan');
  const artifactPath = path.join(fixture.planDir, committedRef.path);
  const targetPath = path.join(path.dirname(artifactPath), 'phase-1-internal-target.md');
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);

  fs.renameSync(artifactPath, targetPath);
  fs.symlinkSync(path.basename(targetPath), artifactPath, 'file');
  assert.equal(path.dirname(fs.realpathSync(artifactPath)), fs.realpathSync(path.dirname(artifactPath)),
    'the symlink target must remain physically contained in the selected plan root');
  assert.equal(fs.statSync(artifactPath).isFile(), true);
  assert.equal(sha256(fs.readFileSync(artifactPath)), committedRef.sha256,
    'the resolved regular file must retain the committed bytes');

  const drain = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ]), 'public drain of closure evidence through a safe in-root symlink');
  assert.deepEqual(deliverySummary(drain, committedEvent.event_id), {
    event_id: committedEvent.event_id,
    revision: 3,
    status: 'succeeded',
  });
  const metadata = readMetadata(fixture);
  const proof = metadata.github_issue.tasklist;
  assert.equal(proof.event_id, committedEvent.event_id);
  assert.equal(proof.plan_id, PLAN_ID);
  assert.equal(proof.revision, committedEvent.revision);
  assert.equal(proof.marker, '<!-- pocket-tasklist -->');
  assert.equal(proof.artifact_refs[0].path, committedRef.path,
    'canonical proof must bind the original committed ref, not the symlink target path');
  assert.equal(readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id)
    .delivery.proof_ref, 'meta:github_issue|marker:issue-tasklist');
  assert.equal(metadata.lifecycle_delivery.last_applied_revision, 3);
  assert.deepEqual(readRemote(fixture).effects.slice(remoteBefore.effects.length).map(({ kind }) => kind), ['tasklist-create']);
  assert.equal(readRemote(fixture).comments['73'].filter(({ body }) => body.startsWith('<!-- pocket-tasklist -->')).length, 1);
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true);
  assert.equal(metadataBefore.github_issue.tasklist, undefined);
});

test('plan-closed keeps escaping, dangling, and ELOOP artifact symlinks terminal', async (t) => {
  for (const targetKind of ['sibling', 'outside', 'dangling', 'eloop']) {
    await t.test(`${targetKind} target`, (subtest) => assertClosureSymlinkIsTerminal(subtest, targetKind));
  }
});

function assertClosureArtifactEioFailure(fixture, artifactPath, committedEvent, faultGate, failedAttempt, failure,
  remoteBefore, metadataBefore) {
  assert.equal(fs.existsSync(faultGate.hitPath), true,
    `registered closure artifact read must inject EIO: ${failedAttempt.stdout}${failedAttempt.stderr}`);
  const injected = JSON.parse(fs.readFileSync(faultGate.hitPath, 'utf8'));
  assert.deepEqual(injected, {
    code: 'EIO',
    executable: path.resolve(__dirname, '../../enterprise/dispatch.js'),
    target: fs.realpathSync(artifactPath),
  });
  assert.deepEqual(failure.deliveries.map(({ event_id, status, error }) => ({
    event_id, status, code: error && error.code, retryable: error && error.retryable,
  })), [{
    event_id: committedEvent.event_id,
    status: 'retryable',
    code: 'CLOSEOUT_ARTIFACT_UNAVAILABLE',
    retryable: true,
  }]);
  const failedEvent = readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id);
  assert.equal(failedEvent.event_id, committedEvent.event_id);
  assert.equal(failedEvent.delivery.attempts, 1);
  assert.deepEqual(readRemote(fixture), remoteBefore,
    'artifact EIO must remain retryable before GitHub calls or effects');
  assert.deepEqual(readMetadata(fixture), metadataBefore,
    'artifact EIO must not write closure proof or advance the watermark');
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), false);
}

function assertClosureArtifactEioRecovery(fixture, committedEvent, retry, remoteBefore) {
  assert.deepEqual(deliverySummary(retry, committedEvent.event_id), {
    event_id: committedEvent.event_id,
    revision: committedEvent.revision,
    status: 'succeeded',
  });
  const recovered = readLifecycle(fixture).events.find(({ event_id }) => event_id === committedEvent.event_id);
  assert.equal(recovered.delivery.attempts, 2);
  assert.equal(readMetadata(fixture).github_issue.tasklist.event_id, committedEvent.event_id);
  assert.equal(readMetadata(fixture).lifecycle_delivery.last_applied_revision, 3);
  assert.deepEqual(readRemote(fixture).effects.slice(remoteBefore.effects.length).map(({ kind }) => kind), ['tasklist-create']);
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true);
}

test('plan-closed retries EIO during committed artifact validation and recovers', (t) => {
  const fixture = createFixture(t);
  const committedEvent = commitPlanClosedEvent(fixture);
  const artifactPath = path.join(fixture.planDir, PHASE_PATH);
  const faultGate = installRegisteredEnterpriseReadFaultGate(fixture);
  const metadataBefore = readMetadata(fixture);
  const remoteBefore = readRemote(fixture);
  const failedAttempt = runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    ...fixture.env,
    NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--require=${faultGate.hookPath}`].filter(Boolean).join(' '),
    LIFECYCLE_ENTERPRISE_READ_FAILURE_PATH: artifactPath,
    LIFECYCLE_ENTERPRISE_DISPATCH_PATH: faultGate.dispatchPath,
    LIFECYCLE_ENTERPRISE_READ_FAILURE_HIT_FILE: faultGate.hitPath,
  });
  const failure = assertCliOk(failedAttempt, 'public drain after registered closure artifact read EIO');
  assertClosureArtifactEioFailure(fixture, artifactPath, committedEvent, faultGate, failedAttempt, failure,
    remoteBefore, metadataBefore);

  const retry = assertCliOk(runCore(fixture, [
    'lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3',
  ], {
    ...fixture.env,
    POCKETTO_LIFECYCLE_NOW: new Date(Date.parse(FIXED_NOW) + 1001).toISOString(),
  }), 'public retry after closure artifact EIO recovery');
  assertClosureArtifactEioRecovery(fixture, committedEvent, retry, remoteBefore);
});
