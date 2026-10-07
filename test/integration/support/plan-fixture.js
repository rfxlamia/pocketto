'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const enterpriseMeta = require('../../../enterprise/meta');
const { PLAN_ID, PHASE_PATH, PR_NUMBER, REPOSITORY_URL } = require('./constants');
const { writeFile } = require('./files');

function writePlanFixture(root) {
  const specDir = path.join(root, 'docs', 'pocket', 'spec', PLAN_ID);
  const planDir = path.join(root, 'docs', 'pocket', 'plans', PLAN_ID);
  const approvedSpec = approvedSpecContent();
  const phaseEvidence = phaseEvidenceContent();
  const index = planIndexContent();
  writePlanDocuments(specDir, planDir, approvedSpec, phaseEvidence, index);
  enterpriseMeta.setPrIdentity(specDir, 'phase-1', {
    number: PR_NUMBER,
    url: `${REPOSITORY_URL}/pull/${PR_NUMBER}`,
  });
  return { specDir, planDir, phaseEvidence, approvedSpec, index };
}

function writePlanDocuments(specDir, planDir, approvedSpec, phaseEvidence, index) {
  const review = { task_id: 'T1', overall: 'REVIEW_PASS', stage_1: { issues: [] }, stage_2: { issues: [] } };
  writeFile(path.join(specDir, 'approved-spec.md'), approvedSpec);
  writeFile(path.join(planDir, 'execution-plan', 'index.md'), index);
  writeFile(path.join(planDir, PHASE_PATH), phaseEvidence);
  writeFile(path.join(planDir, 'reviews', 'T1-review.json'), `${JSON.stringify(review, null, 2)}\n`);
  writeFile(path.join(planDir, 'execution-plan.md'), '# Complete lifecycle integration plan\n');
}

function approvedSpecContent() {
  return [
    '# Approved lifecycle integration spec', '', '## Summary',
    'Exercise the public Core-to-Enterprise lifecycle boundary.', '', '## Acceptance Criteria',
    '- Core emits durable neutral events before Enterprise delivery.',
    '- Enterprise remote effects are reconciled by canonical proof.', '',
  ].join('\n');
}

function phaseEvidenceContent() {
  return [
    '# Phase 1 — lifecycle integration', '',
    '### Task 1: Verify the Core-to-Enterprise lifecycle delivery flow', '',
    'Completion evidence: public lifecycle emitters and adapter delivery are exercised.', '',
  ].join('\n');
}

function planIndexContent() {
  return [
    '# Lifecycle integration fixture', '',
    `**Spec:** docs/pocket/spec/${PLAN_ID}/approved-spec.md`,
    '**Source Plan:** execution-plan.md', '', '## Task Index', '',
    `- [T1] Verify public lifecycle delivery for ${PLAN_ID}`, '',
  ].join('\n');
}

function initializeFixtureGit(root) {
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['checkout', '--quiet', '-b', `feature/${PLAN_ID}`], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lifecycle Integration Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lifecycle-test@example.invalid'], { cwd: root });
  execFileSync('git', ['add', 'docs'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture: create lifecycle integration plan'], { cwd: root });
}

module.exports = { writePlanFixture, initializeFixtureGit };
