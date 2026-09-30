'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');
const FIXED_CLOCK = '2026-09-19T12:00:00.000Z';

function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

function runCli(args, { cwd, env } = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
      code: err.status === null ? 1 : err.status,
    };
  }
}

test('lifecycle drain delivers contiguous events serially in revision order without creating events', () => {
  // Given pending/retryable events for one plan at contiguous revisions 1, 2, and 3,
  // When public `lifecycle drain` runs with a temporary plan and fake adapter,
  // Then it dispatches serially in ascending revision, creates no event, and
  // preserves each original event ID. The fixed clock and lifecycle store/files are real.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-order-'));
  try {
    const projectDir = path.join(root, 'project');
    const specDir = path.join(projectDir, 'spec', 'demo-plan');
    const planDir = path.join(projectDir, 'plans', 'demo-plan');
    const pocketDir = path.join(projectDir, '.pocket');
    mkdirSync(specDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });

    const specContent = 'approved spec\n';
    const phaseOneContent = 'phase one evidence\n';
    const phaseTwoContent = 'phase two evidence\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    writeFileSync(path.join(planDir, 'phase-one.md'), phaseOneContent);
    writeFileSync(path.join(planDir, 'phase-two.md'), phaseTwoContent);

    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const commit = (type, rootName, kind, relativePath, content, evidenceRevision) => {
      const result = commitTransition({
        specDir,
        planDir: type === 'spec-approved' ? null : planDir,
        planId: 'demo-plan',
        type,
        artifacts: [{
          root: rootName,
          kind,
          path: relativePath,
          sha256: sha256Hex(content),
          revision: evidenceRevision,
        }],
        deps: { now: () => FIXED_CLOCK },
      });
      assert.equal(result.ok, true, `event seed should succeed: ${JSON.stringify(result)}`);
      return result.event;
    };

    commit('spec-approved', 'spec', 'spec-doc', 'spec.md', specContent, 1);
    commit('phase-complete', 'plan', 'phase-evidence', 'phase-one.md', phaseOneContent, 1);
    commit('phase-complete', 'plan', 'phase-evidence', 'phase-two.md', phaseTwoContent, 2);

    const lifecyclePath = lifecyclePathFor(specDir);
    const before = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    before.events[1].delivery.status = 'retryable';
    before.events[1].delivery.attempts = 1;
    writeFileSync(lifecyclePath, `${JSON.stringify(before, null, 2)}\n`);
    const originalEventIds = before.events.map((event) => event.event_id);

    const callsPath = path.join(root, 'adapter-calls.jsonl');
    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
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
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved', 'phase-complete', 'plan-closed'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const result = runCli(
      ['lifecycle', 'drain', specDir, '--json', '--contract', '3'],
      {
        cwd: projectDir,
        env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: callsPath },
      },
    );
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(
      envelope.ok,
      true,
      `public lifecycle drain should succeed: ${JSON.stringify(envelope)}${result.stderr}`,
    );
    assert.equal(result.code, 0);
    assert.equal(envelope.command, 'lifecycle drain');
    assert.equal(envelope.contract, 3);

    const delivered = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      delivered,
      before.events.map((event) => ({ event_id: event.event_id, revision: event.revision })),
      'adapter completion order must remain serial and ascending by revision',
    );

    const after = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(after.plan.revision, before.plan.revision, 'drain must not create a lifecycle revision');
    assert.equal(after.events.length, before.events.length, 'drain must not append lifecycle events');
    assert.deepEqual(
      after.events.map((event) => event.event_id),
      originalEventIds,
      'drain must preserve every original event ID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle drain leaves revision gaps pending with an actionable diagnostic', () => {
  // Given revision 5 arrives while revision 4 is unavailable,
  // When public `lifecycle drain` runs,
  // Then revision 5 remains pending and the JSON envelope identifies the plan,
  // blocked revision, missing predecessor, and next actionable recovery step.
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-drain-gap-'));
  try {
    const projectDir = path.join(root, 'project');
    const specDir = path.join(projectDir, 'spec', 'demo-plan');
    const planDir = path.join(projectDir, 'plans', 'demo-plan');
    const pocketDir = path.join(projectDir, '.pocket');
    mkdirSync(specDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    mkdirSync(pocketDir, { recursive: true });

    const specContent = 'approved spec for gap test\n';
    writeFileSync(path.join(specDir, 'spec.md'), specContent);
    const { commitTransition, lifecyclePathFor } = require('../cli/lib/lifecycle-store');
    const seeded = commitTransition({
      specDir,
      planDir: null,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{
        root: 'spec',
        kind: 'spec-doc',
        path: 'spec.md',
        sha256: sha256Hex(specContent),
        revision: 1,
      }],
      deps: { now: () => FIXED_CLOCK },
    });
    assert.equal(seeded.ok, true, `revision 1 seed should succeed: ${JSON.stringify(seeded)}`);

    for (let revision = 2; revision <= 5; revision += 1) {
      const content = `phase ${revision} evidence\n`;
      const relativePath = `phase-${revision}.md`;
      writeFileSync(path.join(planDir, relativePath), content);
      const result = commitTransition({
        specDir,
        planDir,
        planId: 'demo-plan',
        type: 'phase-complete',
        artifacts: [{
          root: 'plan',
          kind: 'phase-evidence',
          path: relativePath,
          sha256: sha256Hex(content),
          revision,
        }],
        deps: { now: () => FIXED_CLOCK },
      });
      assert.equal(result.ok, true, `revision ${revision} seed should succeed: ${JSON.stringify(result)}`);
    }

    const lifecyclePath = lifecyclePathFor(specDir);
    const before = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    before.events = before.events
      .filter((event) => event.revision !== 4)
      .map((event) => {
        if (event.revision < 5) event.delivery.status = 'succeeded';
        return event;
      });
    writeFileSync(lifecyclePath, `${JSON.stringify(before, null, 2)}\n`);

    const callsPath = path.join(root, 'adapter-calls.jsonl');
    writeFileSync(callsPath, '');
    const adapterPath = path.join(root, 'fake-adapter');
    writeFileSync(adapterPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`);
    chmodSync(adapterPath, 0o755);
    writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
      schema: 1,
      adapter_contract: 1,
      argv: [adapterPath],
      events: ['spec-approved', 'phase-complete', 'plan-closed'],
      timeout_ms: 30000,
    }, null, 2)}\n`);

    const result = runCli(
      ['lifecycle', 'drain', specDir, '--json', '--contract', '3'],
      {
        cwd: projectDir,
        env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: callsPath },
      },
    );
    const envelope = JSON.parse(result.stdout.trim());
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

    const after = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
    assert.equal(after.plan.revision, 5);
    assert.equal(after.events.length, before.events.length);
    const revisionFive = after.events.find((event) => event.revision === 5);
    assert.equal(revisionFive.delivery.status, 'pending', 'revision 5 must remain pending behind the gap');
    assert.equal(readFileSync(callsPath, 'utf8'), '', 'revision 5 must not be dispatched out of order');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
