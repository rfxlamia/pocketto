'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hashCanonicalPayload } = require('../../../cli/lib/lifecycle-contract');
const { FIXED_NOW, PHASE_PATH, PLAN_ID } = require('./constants');
const { sha256, writeFile } = require('./files');

function readLifecycle(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.specDir, 'lifecycle.json'), 'utf8'));
}

function readRemote(fixture) {
  return JSON.parse(fs.readFileSync(fixture.remotePath, 'utf8'));
}

function writeGapDocument(fixture) {
  const ref = {
    root: 'plan', kind: 'phase-evidence', path: PHASE_PATH,
    sha256: sha256(fixture.phaseEvidence), revision: 1,
  };
  const lifecycle = {
    schema: 1,
    plan: {
      plan_id: PLAN_ID,
      spec_dir: fixture.specDir,
      plan_dir: fixture.planDir,
      branch: `feature/${PLAN_ID}`,
      state: { approval: 'APPROVED', phase_status: { 'phase-1': 'COMPLETE' }, status: 'IN_PROGRESS' },
      revision: 5,
    },
    events: [
      gapEvent(ref, 'spec-approved', 1, 'succeeded'),
      gapEvent(ref, 'phase-complete', 2, 'succeeded'),
      gapEvent(ref, 'phase-complete', 3, 'succeeded'),
      gapEvent(ref, 'phase-complete', 5, 'pending'),
    ],
  };
  writeFile(path.join(fixture.specDir, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
  return lifecycle;
}

function gapEvent(ref, type, revision, status) {
  return {
    event_id: `${PLAN_ID}:${type}:r${revision}`,
    plan_id: PLAN_ID,
    type,
    revision,
    occurred_at: FIXED_NOW,
    artifact_refs: [ref],
    payload_hash: String(revision).padStart(64, 'a'),
    proof_ref: null,
    proof_hash: null,
    delivery: status === 'succeeded'
      ? { status, attempts: 1, proof_ref: 'test:proof', proof_hash: 'b'.repeat(64) }
      : { status, attempts: 0 },
  };
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

module.exports = { readLifecycle, readRemote, writeGapDocument, appendOrderedPendingRevisions };
