'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK, createLifecycleProject, parseJson, registerAdapter, runCli,
  seedLifecycleEvent, sha256Hex, tmpdir, writeExecutable,
} = require('./common');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function seedGapEvents(specDir, planDir) {
  const specContent = 'approved spec for gap test\n';
  writeFileSync(path.join(specDir, 'spec.md'), specContent);
  seedLifecycleEvent({
    specDir,
    planId: 'demo-plan',
    type: 'spec-approved',
    artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: sha256Hex(specContent), revision: 1 }],
  });
  for (let revision = 2; revision <= 5; revision += 1) {
    const content = `phase ${revision} evidence\n`;
    const relativePath = `phase-${revision}.md`;
    writeFileSync(path.join(planDir, relativePath), content);
    seedLifecycleEvent({
      specDir,
      planDir,
      planId: 'demo-plan',
      type: 'phase-complete',
      artifacts: [{ root: 'plan', kind: 'phase-evidence', path: relativePath, sha256: sha256Hex(content), revision }],
    });
  }

  const lifecyclePath = require('../../cli/lib/lifecycle-store').lifecyclePathFor(specDir);
  const before = parseJson(readFileSync(lifecyclePath, 'utf8'), 'lifecycle state before gap drain');
  before.events = before.events
    .filter((event) => event.revision !== 4)
    .map((event) => {
      if (event.revision < 5) event.delivery.status = 'succeeded';
      return event;
    });
  writeFileSync(lifecyclePath, `${JSON.stringify(before, null, 2)}\n`);
  return { lifecyclePath, before };
}

function createGapAdapter(root, pocketDir) {
  const callsPath = path.join(root, 'adapter-calls.jsonl');
  writeFileSync(callsPath, '');
  const adapterPath = writeExecutable(path.join(root, 'fake-adapter'), `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
  registerAdapter(pocketDir, adapterPath);
  return callsPath;
}

function assertGapRemainsPending(fixture) {
  const result = runCli(
    ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
    {
      cwd: fixture.projectDir,
      env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: fixture.callsPath },
    },
  );
  const envelope = parseJson(result.stdout.trim(), 'gap drain response');
  assert.equal(envelope.ok, true, `lifecycle drain should return a gap result: ${JSON.stringify(envelope)}`);
  assert.equal(envelope.command, 'lifecycle drain');
  assert.equal(envelope.contract, 3);
  const gaps = Array.isArray(envelope.data.gaps) ? envelope.data.gaps : [];
  assert.equal(gaps.length, 1, 'drain must classify the blocked revision gap');
  assert.equal(gaps[0].plan_id, 'demo-plan');
  assert.equal(gaps[0].blocked_revision, 5);
  assert.equal(gaps[0].missing_predecessor, 4);
  assert.ok(
    typeof gaps[0].next_step === 'string'
      && /4/.test(gaps[0].next_step)
      && /(restore|replay|recover)/i.test(gaps[0].next_step),
    'gap diagnostic must give an actionable recovery step for revision 4',
  );
  const after = parseJson(readFileSync(fixture.lifecyclePath, 'utf8'), 'lifecycle state after gap drain');
  assert.equal(after.plan.revision, 5);
  assert.equal(after.events.length, fixture.before.events.length);
  const revisionFive = after.events.find((event) => event.revision === 5);
  assert.equal(revisionFive.delivery.status, 'pending', 'revision 5 must remain pending behind the gap');
  assert.equal(readFileSync(fixture.callsPath, 'utf8'), '', 'revision 5 must not be dispatched out of order');
}

test('lifecycle drain leaves revision gaps pending with an actionable diagnostic', () => {
  // Given revision 5 arrives while revision 4 is unavailable,
  // When public `lifecycle drain` runs,
  // Then revision 5 remains pending and the JSON envelope identifies the plan,
  // blocked revision, missing predecessor, and next actionable recovery step.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-gap-'));
  try {
    const project = createLifecycleProject(root);
    const state = seedGapEvents(project.specDir, project.planDir);
    assertGapRemainsPending({
      ...project,
      ...state,
      callsPath: createGapAdapter(root, project.pocketDir),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
