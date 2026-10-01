'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PhaseHandlerError, safeMessage } = require('./phase-handler-errors');

function loadContext(event, options) {
  const root = path.resolve(options.projectRoot || process.cwd());
  const defaultSpecDir = path.join(root, 'docs', 'pocket', 'spec', event.plan_id);
  const specDir = path.resolve(options.specDir || defaultSpecDir);
  const lifecyclePath = path.join(specDir, 'lifecycle.json');
  let lifecycle;
  try {
    lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  } catch (error) {
    throw new PhaseHandlerError('PHASE_LIFECYCLE_UNAVAILABLE', `Cannot read phase lifecycle evidence: ${safeMessage(error)}`, {
      status: 'retryable',
      retryable: true,
    });
  }
  if (!lifecycle.plan || lifecycle.plan.plan_id !== event.plan_id) {
    throw new PhaseHandlerError('PHASE_PLAN_IDENTITY_MISMATCH', 'Lifecycle metadata does not identify this event plan.');
  }
  const defaultPlanDir = path.join(root, 'docs', 'pocket', 'plans', event.plan_id);
  const planDir = path.resolve(options.planDir || lifecycle.plan.plan_dir || defaultPlanDir);
  if (typeof lifecycle.plan.branch !== 'string' || lifecycle.plan.branch.length === 0) {
    throw new PhaseHandlerError('PHASE_BRANCH_REQUIRED', 'Lifecycle metadata does not contain the captured plan branch.');
  }
  return { root, specDir, planDir, branch: lifecycle.plan.branch, lifecycle };
}


module.exports = { loadContext };
