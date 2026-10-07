'use strict';

const { PHASE_PATH } = require('./constants');
const { sha256 } = require('./files');
const { assertCliOk, runCore } = require('./core-cli');
const { installEnterpriseAdapter } = require('./enterprise');

function initializePlan(fixture) {
  installEnterpriseAdapter(fixture);
  const initialized = runCore(fixture, ['log', 'init', fixture.planDir, '--json', '--contract', '3']);
  assertCliOk(initialized, 'public log init');
  const taskDone = runCore(fixture, [
    'log', 'update', fixture.planDir, PHASE_PATH, 'DONE', '--task', 'T1', '--json', '--contract', '3',
  ]);
  assertCliOk(taskDone, 'public log update task completion');
}

function transitionApprovedSpec(fixture, label = 'public spec-approved transition') {
  const result = runCore(fixture, [
    'lifecycle', 'transition', fixture.specDir, 'spec-approved',
    '--artifact', `spec:approved-spec:approved-spec.md:${sha256(fixture.approvedSpec)}`,
    '--json', '--contract', '3',
  ]);
  return assertCliOk(result, label);
}

module.exports = { initializePlan, transitionApprovedSpec };
