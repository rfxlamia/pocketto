'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const enterpriseMeta = require('../../enterprise/meta');
const { makePr } = require('./remote');

const FIXED_CLOCK = '2026-09-19T12:00:00.000Z';
const ISSUE_NUMBER = 31;
const PR_NUMBER = 42;
const OWNER = 'pocketto-test';
const REPOSITORY = 'phase-fixtures';
const BRANCH = 'feature/demo-plan';

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-phase-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planId = 'demo-plan';
  const paths = createPlanFiles(root, planId);
  const event = createPhaseEvent(planId, paths.phasePath, paths.phaseText);
  writeLifecycle(paths.specDir, planId, paths.planDir, event);
  seedRemoteIdentities(paths.specDir);
  return { ...paths, root, event, remote: createRemoteFixture(planId) };
}

function createPlanFiles(root, planId) {
  const specDir = path.join(root, 'docs', 'pocket', 'spec', planId);
  const planDir = path.join(root, 'docs', 'pocket', 'plans', planId);
  const phasePath = 'execution-plan/phase-1.md';
  const phaseText = '# Phase 1\n\nContains tasks: T1\n';
  fs.mkdirSync(path.join(planDir, 'execution-plan'), { recursive: true });
  fs.mkdirSync(path.join(planDir, 'reviews'), { recursive: true });
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, phasePath), phaseText);
  writePlanLog(planDir, phasePath);
  writeInitialReview(planDir);
  return { specDir, planDir, phasePath, phaseText };
}

function writePlanLog(planDir, phasePath) {
  fs.writeFileSync(path.join(planDir, 'log.json'), JSON.stringify({
    header: { plan_dir: planDir, status: 'IN_PROGRESS' },
    phases: [{
      file: phasePath,
      status: 'REVIEW',
      tasks: [{ id: 'T1', name: 'Validate input handling', status: 'DONE' }],
    }],
  }, null, 2) + '\n');
}

function writeInitialReview(planDir) {
  fs.writeFileSync(path.join(planDir, 'reviews', 'T1-review.json'), JSON.stringify({
    task_id: 'T1',
    overall: 'REVIEW_FAIL',
    stage_1: {
      issues: [{
        type: 'spec-compliance',
        location: 'src/worker.js:18',
        description: 'Missing error handling for invalid input',
      }],
    },
    stage_2: { issues: [] },
  }, null, 2) + '\n');
}

function createPhaseEvent(planId, phasePath, phaseText) {
  return {
    event_id: `${planId}:phase-complete:r1`,
    plan_id: planId,
    type: 'phase-complete',
    revision: 1,
    occurred_at: FIXED_CLOCK,
    artifact_refs: [{
      root: 'plan',
      kind: 'phase-evidence',
      path: phasePath,
      sha256: crypto.createHash('sha256').update(phaseText).digest('hex'),
      revision: 1,
    }],
    payload_hash: 'a'.repeat(64),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 1 },
  };
}

function writeLifecycle(specDir, planId, planDir, event) {
  fs.writeFileSync(path.join(specDir, 'lifecycle.json'), JSON.stringify({
    schema: 1,
    plan: {
      plan_id: planId,
      spec_dir: specDir,
      plan_dir: planDir,
      branch: BRANCH,
      state: { approval: 'APPROVED', phase_status: { 'phase-1': 'COMPLETE' }, status: 'IN_PROGRESS' },
      revision: 1,
    },
    events: [event],
  }, null, 2) + '\n');
}

function seedRemoteIdentities(specDir) {
  enterpriseMeta.setIssueIdentity(specDir, {
    number: ISSUE_NUMBER,
    url: `https://github.com/${OWNER}/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
  });
  enterpriseMeta.setPrIdentity(specDir, 'phase-1', {
    number: PR_NUMBER,
    url: `https://github.com/${OWNER}/${REPOSITORY}/pull/${PR_NUMBER}`,
  });
}

function createRemoteFixture(planId) {
  return {
    owner: OWNER,
    repository: REPOSITORY,
    issue: {
      number: ISSUE_NUMBER,
      url: `https://github.com/${OWNER}/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
      state: 'OPEN',
      title: `[pocket-plan] ${planId}`,
      body: `Plan identity: docs/pocket/spec/${planId}/core.md`,
    },
    prs: [makePr(PR_NUMBER, planId)],
    issueSearch: [],
    calls: [],
    nextCommentId: 1,
    nextThreadId: 1,
    resolveFailuresRemaining: 0,
    successfulResolutions: 0,
  };
}

module.exports = {
  BRANCH,
  FIXED_CLOCK,
  ISSUE_NUMBER,
  OWNER,
  PR_NUMBER,
  REPOSITORY,
  createFixture,
};
