'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, createLifecycleProject, parseJson, readJsonLines, registerAdapter,
  runCli, seedLifecycleEvent, sha256Hex, tmpdir, writeExecutable,
} = require('./common');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function seedOrderedEvents(specDir, planDir) {
  const specContent = 'approved spec\n';
  const phaseOneContent = 'phase one evidence\n';
  const phaseTwoContent = 'phase two evidence\n';
  writeFileSync(path.join(specDir, 'spec.md'), specContent);
  writeFileSync(path.join(planDir, 'phase-one.md'), phaseOneContent);
  writeFileSync(path.join(planDir, 'phase-two.md'), phaseTwoContent);
  const seed = (type, rootName, kind, relativePath, content, revision) => seedLifecycleEvent({
    specDir,
    planDir: type === 'spec-approved' ? null : planDir,
    planId: 'demo-plan',
    type,
    artifacts: [{ root: rootName, kind, path: relativePath, sha256: sha256Hex(content), revision }],
  }).event;
  seed('spec-approved', 'spec', 'spec-doc', 'spec.md', specContent, 1);
  seed('phase-complete', 'plan', 'phase-evidence', 'phase-one.md', phaseOneContent, 1);
  seed('phase-complete', 'plan', 'phase-evidence', 'phase-two.md', phaseTwoContent, 2);
  return require('../../cli/lib/lifecycle-store').lifecyclePathFor(specDir);
}

function createOrderingAdapter(root, pocketDir) {
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  const adapterPath = writeExecutable(path.join(root, 'fake-adapter'), `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) {
  process.stderr.write('event file argument is missing\\n');
  process.exit(2);
}
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const delayMs = { 1: 150, 2: 75, 3: 0 }[event.revision] || 0;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id, revision: event.revision }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
  registerAdapter(pocketDir, adapterPath);
  return callsPath;
}

function createOrderingFixture(root) {
  const project = createLifecycleProject(root);
  const lifecyclePath = seedOrderedEvents(project.specDir, project.planDir);
  const before = parseJson(readFileSync(lifecyclePath, 'utf8'), 'lifecycle state before drain');
  before.events[1].delivery.status = 'retryable';
  before.events[1].delivery.attempts = 1;
  writeFileSync(lifecyclePath, `${JSON.stringify(before, null, 2)}\n`);
  return {
    ...project,
    lifecyclePath,
    before,
    originalEventIds: before.events.map((event) => event.event_id),
    callsPath: createOrderingAdapter(root, project.pocketDir),
  };
}

function assertOrderedDelivery(fixture) {
  const result = runCli(
    ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
    {
      cwd: fixture.projectDir,
      env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: fixture.callsPath },
    },
  );
  const envelope = parseJson(result.stdout.trim(), 'ordered drain response');
  assert.equal(envelope.ok, true, `public lifecycle drain should succeed: ${JSON.stringify(envelope)}${result.stderr}`);
  assert.equal(result.code, 0);
  assert.equal(envelope.command, 'lifecycle drain');
  assert.equal(envelope.contract, 3);
  assert.deepEqual(
    readJsonLines(fixture.callsPath),
    fixture.before.events.map((event) => ({ event_id: event.event_id, revision: event.revision })),
    'adapter completion order must remain serial and ascending by revision',
  );
  const after = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'lifecycle state after drain');
  assert.equal(after.plan.revision, fixture.before.plan.revision, 'drain must not create a lifecycle revision');
  assert.equal(after.events.length, fixture.before.events.length, 'drain must not append lifecycle events');
  assert.deepEqual(after.events.map((event) => event.event_id), fixture.originalEventIds, 'drain must preserve every original event ID');
}

test('lifecycle drain delivers contiguous events serially in revision order without creating events', () => {
  // Given pending/retryable events for one plan at contiguous revisions 1, 2, and 3,
  // When public `lifecycle drain` runs with a temporary plan and fake adapter,
  // Then it dispatches serially in ascending revision, creates no event, and
  // preserves each original event ID. The fixed clock and lifecycle store/files are real.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-order-'));
  try {
    assertOrderedDelivery(createOrderingFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
