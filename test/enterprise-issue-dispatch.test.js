'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { invokeAdapter, readAdapterRegistration } = require('../cli/lib/lifecycle-adapter');
const enterpriseRegistration = require('../enterprise/registration');

const DISPATCH = path.resolve(__dirname, '../enterprise/dispatch.js');
const PLAN_ID = 'spec-root-escape-plan';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readFakeGhCalls(tracePath) {
  const contents = fs.readFileSync(tracePath, 'utf8').trim();
  return contents ? contents.split('\n').map((line) => JSON.parse(line)) : [];
}

test('registered spec-approved rejects an external spec directory symlink before GitHub or metadata writes', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-issue-dispatch-project-'));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-issue-dispatch-external-'));
  t.after(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  });

  const specDir = path.join(projectRoot, 'docs', 'pocket', 'spec', PLAN_ID);
  const externalSpecDir = path.join(externalRoot, PLAN_ID);
  fs.mkdirSync(path.dirname(specDir), { recursive: true });
  fs.mkdirSync(externalSpecDir, { recursive: true });

  const approvedSpec = '# Approved specification\n\nExternal directory symlink fixture.\n';
  const approvedSpecPath = path.join(externalSpecDir, 'approved-spec.md');
  fs.writeFileSync(approvedSpecPath, approvedSpec);
  const sentinelBytes = Buffer.from('{\n  "sentinel": "external metadata must remain unchanged"\n}\n');
  const externalMetadataPath = path.join(externalSpecDir, '.pocket-meta.json');
  fs.writeFileSync(externalMetadataPath, sentinelBytes);
  fs.symlinkSync(externalSpecDir, specDir, 'dir');

  const event = {
    event_id: `${PLAN_ID}:spec-approved:r1`,
    plan_id: PLAN_ID,
    type: 'spec-approved',
    revision: 1,
    occurred_at: '2026-09-19T12:00:00.000Z',
    artifact_refs: [{
      root: 'spec',
      kind: 'approved-spec',
      path: 'approved-spec.md',
      sha256: sha256(approvedSpec),
      revision: 1,
    }],
    payload_hash: 'a'.repeat(64),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 0 },
  };

  const tracePath = path.join(projectRoot, 'fake-gh.jsonl');
  fs.writeFileSync(tracePath, '');
  const binDir = path.join(projectRoot, 'fake-bin');
  fs.mkdirSync(binDir);
  const fakeGhPath = path.join(binDir, 'gh');
  fs.writeFileSync(fakeGhPath, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_TRACE, JSON.stringify(args) + '\\n');
process.exit(1);
`, { mode: 0o755 });
  fs.chmodSync(fakeGhPath, 0o755);

  const previousPath = process.env.PATH;
  const previousTrace = process.env.FAKE_GH_TRACE;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
  process.env.FAKE_GH_TRACE = tracePath;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTrace === undefined) delete process.env.FAKE_GH_TRACE;
    else process.env.FAKE_GH_TRACE = previousTrace;
  });

  const installed = enterpriseRegistration.installRegistration(projectRoot, {
    argv: [process.execPath, DISPATCH, projectRoot],
    events: ['spec-approved'],
  });
  assert.equal(installed.ok, true, `Enterprise registration setup failed: ${JSON.stringify(installed)}`);
  const loaded = readAdapterRegistration(projectRoot);
  assert.equal(loaded.error, null, loaded.error && loaded.error.message);
  assert.deepEqual(loaded.registration.argv, [process.execPath, DISPATCH, projectRoot]);

  const response = invokeAdapter(event, loaded.registration);

  assert.equal(readFakeGhCalls(tracePath).length, 0,
    'the external spec directory symlink must be rejected before any fake-GH call');
  assert.equal(response.event_id, event.event_id, 'the bounded response must preserve the original event ID');
  assert.notEqual(response.status, 'succeeded', 'an external spec directory must fail closed');
  assert.deepEqual(fs.readFileSync(externalMetadataPath), sentinelBytes,
    'external .pocket-meta.json bytes must remain unchanged');
});
