'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, mkdirSync, mkdtempSync, parseJson, path, readFileSync, rmSync,
  runCli, seedLifecycleEvent, sha256Hex, tmpdir, writeExecutable, writeFileSync,
} = require('./common');
const { symlinkSync } = require('node:fs');

const PLAN_ID = 'symlink-plan';
const PHASE_PATH = 'execution-plan-phase-1.md';
const ENTERPRISE_DISPATCH = path.resolve(__dirname, '../../enterprise/dispatch.js');

function createGhTrap(root) {
  const binDir = path.join(root, 'bin');
  const callsPath = path.join(root, 'gh-calls.jsonl');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(callsPath, '');
  writeExecutable(path.join(binDir, 'gh'), `#!/usr/bin/env node
'use strict';
require('node:fs').appendFileSync(process.env.GH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(91);
`);
  return { binDir, callsPath };
}

function createProjectFixture(root) {
  const projectDir = path.join(root, 'project');
  const specDir = path.join(projectDir, 'docs', 'pocket', 'spec', PLAN_ID);
  const planDir = path.join(projectDir, 'docs', 'pocket', 'plans', PLAN_ID);
  const pocketDir = path.join(projectDir, '.pocket');
  const phaseContent = '# Phase 1\n\nValid committed phase evidence.\n';
  mkdirSync(specDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  mkdirSync(pocketDir, { recursive: true });
  writeFileSync(path.join(planDir, PHASE_PATH), phaseContent);
  return { projectDir, specDir, planDir, pocketDir, phaseContent };
}

function seedProjectLifecycle(project) {
  const seeded = seedLifecycleEvent({
    specDir: project.specDir,
    planDir: project.planDir,
    planId: PLAN_ID,
    type: 'phase-complete',
    branch: 'feature/symlink-boundary',
    artifacts: [{
      root: 'plan',
      kind: 'phase-evidence',
      path: PHASE_PATH,
      sha256: sha256Hex(project.phaseContent),
      revision: 1,
    }],
  });
  const lifecyclePath = require('../../cli/lib/lifecycle-store').lifecyclePathFor(project.specDir);
  const lifecycleBefore = parseJson(readFileSync(lifecyclePath, 'utf8'), 'seeded lifecycle state');
  const eventId = seeded.event.event_id;
  assert.equal(lifecycleBefore.plan.revision, 1, 'fixture must start with one committed lifecycle revision');
  assert.equal(lifecycleBefore.events.length, 1, 'fixture must start with exactly one journal event');
  assert.equal(lifecycleBefore.events[0].type, 'phase-complete');
  assert.equal(lifecycleBefore.events[0].event_id, eventId);
  assert.equal(lifecycleBefore.events[0].delivery.status, 'pending');
  return { seeded, lifecyclePath, lifecycleBefore, eventId };
}

function createExternalPlanFixture(root, phaseContent, seededEvent) {
  const externalPlanDir = path.join(root, 'external-plan');
  const externalPhasePath = path.join(externalPlanDir, PHASE_PATH);
  const externalLogPath = path.join(externalPlanDir, 'log.json');
  const externalPhaseBytes = phaseContent;
  const externalLogBytes = `${JSON.stringify({
    phases: [{ file: PHASE_PATH, tasks: [] }],
  }, null, 2)}\n`;
  mkdirSync(externalPlanDir, { recursive: true });
  writeFileSync(externalPhasePath, externalPhaseBytes);
  writeFileSync(externalLogPath, externalLogBytes);
  assert.equal(sha256Hex(externalPhaseBytes), seededEvent.artifact_refs[0].sha256,
    'external phase sentinel must otherwise match the committed evidence');
  return {
    externalPlanDir,
    externalPhasePath,
    externalLogPath,
    externalPhaseBytes,
    externalLogBytes,
  };
}

function registerEnterpriseDispatcher(project) {
  const registration = {
    schema: 1,
    adapter_contract: 1,
    argv: [process.execPath, ENTERPRISE_DISPATCH, project.projectDir],
    events: ['phase-complete'],
    timeout_ms: 30_000,
  };
  writeFileSync(path.join(project.pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify(registration, null, 2)}\n`);
}

function createSymlinkFixture(root) {
  const project = createProjectFixture(root);
  const lifecycle = seedProjectLifecycle(project);
  const external = createExternalPlanFixture(root, project.phaseContent, lifecycle.seeded.event);
  rmSync(project.planDir, { recursive: true, force: true });
  symlinkSync(external.externalPlanDir, project.planDir, 'dir');
  registerEnterpriseDispatcher(project);
  return {
    projectDir: project.projectDir,
    specDir: project.specDir,
    planDir: project.planDir,
    externalPhasePath: external.externalPhasePath,
    externalLogPath: external.externalLogPath,
    externalPhaseBytes: external.externalPhaseBytes,
    externalLogBytes: external.externalLogBytes,
    lifecyclePath: lifecycle.lifecyclePath,
    lifecycleBefore: lifecycle.lifecycleBefore,
    eventId: lifecycle.eventId,
  };
}

function assertSymlinkEscapeRejected(fixture, trap) {
  const result = runCli(
    ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
    {
      cwd: fixture.projectDir,
      env: {
        PATH: `${trap.binDir}${path.delimiter}${process.env.PATH || ''}`,
        GH_CALLS: trap.callsPath,
        POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK,
      },
    },
  );
  const envelope = parseJson(result.stdout.trim(), 'symlink-boundary drain response');
  assert.equal(result.code, 0, `Core drain should report bounded delivery outcome: ${result.stdout}${result.stderr}`);
  assert.equal(envelope.ok, true, `Core drain should return a delivery result: ${JSON.stringify(envelope)}`);
  assert.equal(envelope.command, 'lifecycle drain');
  assert.equal(envelope.contract, 3);
  assert.equal(envelope.data.deliveries.length, 1, 'the committed phase event must reach registered-adapter dispatch');

  const delivery = envelope.data.deliveries[0];
  assert.equal(delivery.event_id, fixture.eventId, 'the registered Enterprise response must preserve the committed event identity');
  assert.equal(delivery.revision, 1);
  assert.ok(['retryable', 'terminal'].includes(delivery.status), 'the rejected delivery must remain bounded');
  assert.equal(readFileSync(trap.callsPath, 'utf8'), '', 'the symlink escape must not invoke fake GitHub');
  assert.equal(delivery.error.code, 'ADAPTER_PROTOCOL_HANDLER_FAILED',
    'Enterprise must reject the physical plan-root escape before phase evidence reaches its handler');
  assert.equal(readFileSync(fixture.externalPhasePath, 'utf8'), fixture.externalPhaseBytes,
    'external phase evidence bytes must remain unchanged');
  assert.equal(readFileSync(fixture.externalLogPath, 'utf8'), fixture.externalLogBytes,
    'external plan log bytes must remain unchanged');

  const after = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'lifecycle state after symlink-boundary drain');
  assert.equal(after.plan.revision, fixture.lifecycleBefore.plan.revision, 'drain must not create a lifecycle revision');
  assert.deepEqual(after.plan.state, fixture.lifecycleBefore.plan.state, 'drain must preserve committed lifecycle state');
  assert.equal(after.events.length, fixture.lifecycleBefore.events.length, 'drain must not append a journal event');
  assert.deepEqual(
    after.events.map((event) => event.event_id),
    fixture.lifecycleBefore.events.map((event) => event.event_id),
    'drain must preserve every committed event ID',
  );
  assert.equal(after.events[0].event_id, fixture.eventId);
  assert.equal(after.events[0].delivery.attempts, 1, 'Core may record only the one bounded delivery attempt');
  assert.ok(['retryable', 'terminal'].includes(after.events[0].delivery.status));
  assert.equal(envelope.data.revision, fixture.lifecycleBefore.plan.revision);
}

test('Core drain rejects a registered Enterprise adapter plan-root symlink escape without side effects', () => {
  // Given Core has committed one valid phase-complete event and the bundled
  // Enterprise dispatcher is registered with the explicit project-root argv,
  // When the in-project plan directory is replaced by a symlink to an external
  // temp root and Core runs public lifecycle drain, Then Enterprise rejects the
  // physical escape before reading plan evidence or invoking GitHub. The event
  // identity/revision/journal remain stable and external sentinel bytes persist.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-enterprise-symlink-'));
  try {
    const fixture = createSymlinkFixture(root);
    const trap = createGhTrap(root);
    assertSymlinkEscapeRejected(fixture, trap);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
