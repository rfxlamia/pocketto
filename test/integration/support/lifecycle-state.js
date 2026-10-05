'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hashCanonicalPayload } = require('../../../cli/lib/lifecycle-contract');
const { FIXED_NOW, PLAN_ID } = require('./constants');
const { sha256, writeFile } = require('./files');

function readLifecycle(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.specDir, 'lifecycle.json'), 'utf8'));
}

function readRemote(fixture) {
  return JSON.parse(fs.readFileSync(fixture.remotePath, 'utf8'));
}

function appendOrderedPendingRevisions(fixture) {
  const lifecycle = readLifecycle(fixture);
  const existingRevisions = lifecycle.events.map((event) => event.revision);
  assert.deepEqual(existingRevisions, [1, 2], 'the public emitters must create the initial ordered revisions');
  assert.ok(lifecycle.events.every((event) => event.delivery.status === 'succeeded'));
  for (const revision of [3, 4, 5]) appendPendingRevision(fixture, lifecycle, revision);
  lifecycle.plan.revision = 5;
  writeFile(path.join(fixture.specDir, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
  return lifecycle;
}

function appendPendingRevision(fixture, lifecycle, revision) {
  const phaseNumber = revision - 1;
  const artifactPath = `execution-plan/phase-${phaseNumber}.md`;
  const contents = `# Phase ${phaseNumber} evidence\n\nCompleted lifecycle revision ${revision}.\n`;
  writeFile(path.join(fixture.planDir, artifactPath), contents);
  const artifactRef = {
    root: 'plan', kind: 'phase-evidence', path: artifactPath,
    sha256: sha256(contents), revision: 1,
  };
  const payload = {
    plan_id: PLAN_ID,
    type: 'phase-complete',
    artifact_refs: [artifactRef],
    proof_ref: null,
    proof_hash: null,
  };
  lifecycle.events.push({
    event_id: `${PLAN_ID}:phase-complete:r${revision}`,
    plan_id: PLAN_ID,
    type: 'phase-complete',
    revision,
    occurred_at: new Date(Date.parse(FIXED_NOW) + revision * 1000).toISOString(),
    artifact_refs: [artifactRef],
    payload_hash: hashCanonicalPayload(payload),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 0 },
  });
  lifecycle.plan.state.phase_status[`phase-${phaseNumber}`] = 'COMPLETE';
}

module.exports = { readLifecycle, readRemote, appendOrderedPendingRevisions };
