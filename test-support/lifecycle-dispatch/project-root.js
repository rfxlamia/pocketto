'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmpdir } = require('node:os');
const {
  FIXED_CLOCK, createLifecycleProject, mkdtempSync, parseJson, path, readFileSync,
  registerAdapter, rmSync, runCli, seedLifecycleEvent, sha256Hex, writeExecutable, writeFileSync,
} = require('./common');
const { readAdapterRegistration, MAX_ADAPTER_TIMEOUT_MS } = require('../../cli/lib/lifecycle-adapter');

function adapterSource() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventPath = process.argv.slice(2).find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
if (!eventPath) process.exit(2);
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
fs.appendFileSync(process.env.ADAPTER_CALLS, event.event_id + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`;
}

test('lifecycle drain resolves adapter registration from the plan project, not process.cwd', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-project-root-'));
  try {
    const fixture = createLifecycleProject(root);
    const specContent = 'approved spec for project-root drain\n';
    writeFileSync(path.join(fixture.specDir, 'spec.md'), specContent);
    const seeded = seedLifecycleEvent({
      specDir: fixture.specDir,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: sha256Hex(specContent), revision: 1 }],
    });
    const callsPath = path.join(root, 'adapter-calls.txt');
    writeFileSync(callsPath, '');
    const adapterPath = writeExecutable(path.join(root, 'fake-adapter.js'), adapterSource());
    registerAdapter(fixture.pocketDir, adapterPath, { events: ['spec-approved'] });

    const result = runCli(
      ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
      { cwd: tmpdir(), env: { ADAPTER_CALLS: callsPath, POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK } },
    );
    const envelope = parseJson(result.stdout.trim(), 'project-root drain');
    assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.equal(envelope.data.deliveries[0].status, 'succeeded');
    assert.equal(readFileSync(callsPath, 'utf8').trim(), seeded.event.event_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle drain leaves a missing adapter pending without a delivery mutation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-missing-adapter-'));
  try {
    const fixture = createLifecycleProject(root);
    const specContent = 'approved spec without an adapter\n';
    writeFileSync(path.join(fixture.specDir, 'spec.md'), specContent);
    seedLifecycleEvent({
      specDir: fixture.specDir,
      planId: 'demo-plan',
      type: 'spec-approved',
      artifacts: [{ root: 'spec', kind: 'spec-doc', path: 'spec.md', sha256: sha256Hex(specContent), revision: 1 }],
    });
    const lifecyclePath = path.join(fixture.specDir, 'lifecycle.json');
    const before = readFileSync(lifecyclePath, 'utf8');
    const result = runCli(
      ['lifecycle', 'drain', fixture.specDir, '--json', '--contract', '3'],
      { cwd: tmpdir(), env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK } },
    );
    const envelope = parseJson(result.stdout.trim(), 'missing-adapter drain');
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.equal(envelope.data.deliveries[0].status, 'pending');
    assert.equal(envelope.data.deliveries[0].error.code, 'ADAPTER_NOT_REGISTERED');
    assert.equal(readFileSync(lifecyclePath, 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core accepts the Enterprise adapter timeout ceiling and rejects one millisecond past it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-timeout-bound-'));
  try {
    const pocketDir = path.join(root, '.pocket');
    const { mkdirSync } = require('node:fs');
    mkdirSync(pocketDir, { recursive: true });
    const registrationPath = path.join(pocketDir, 'lifecycle-adapter.json');
    for (const timeoutMs of [MAX_ADAPTER_TIMEOUT_MS, MAX_ADAPTER_TIMEOUT_MS + 1]) {
      writeFileSync(registrationPath, `${JSON.stringify({
        schema: 1,
        adapter_contract: 1,
        argv: ['/usr/bin/true'],
        events: ['spec-approved'],
        timeout_ms: timeoutMs,
      })}\n`);
      const loaded = readAdapterRegistration(root);
      if (timeoutMs === MAX_ADAPTER_TIMEOUT_MS) {
        assert.equal(loaded.error, null);
        assert.equal(loaded.registration.timeout_ms, MAX_ADAPTER_TIMEOUT_MS);
      } else {
        assert.equal(loaded.error.code, 'ADAPTER_REGISTRATION_INVALID');
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
