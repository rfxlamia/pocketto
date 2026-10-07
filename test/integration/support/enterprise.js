'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ENTERPRISE_CLI, REPO_ROOT, REPOSITORY, ISSUE_NUMBER } = require('./constants');
const { runProcess } = require('./process');
const { writeFile } = require('./files');

function installEnterpriseAdapter(fixture) {
  const result = runProcess(process.execPath, [ENTERPRISE_CLI, 'install', fixture.root, '--json'], {
    cwd: REPO_ROOT,
    env: fixture.env,
  });
  const json = parseJson(result.stdout);
  assertInstall(result, json, 'Enterprise registration');
  return json.data;
}

function installFakeAdapter(fixture, tracePath, { recordRemoteEffects = false } = {}) {
  const adapterPath = createFakeAdapterFile(fixture.root, recordRemoteEffects);
  fs.chmodSync(adapterPath, 0o755);
  const env = { ...fixture.env, FAKE_ADAPTER_TRACE: tracePath };
  const result = runProcess(process.execPath, [
    ENTERPRISE_CLI, 'install', fixture.root, '--argv', adapterPath, '--json',
  ], { cwd: REPO_ROOT, env });
  const json = parseJson(result.stdout);
  assertInstall(result, json, 'fake adapter registration');
  return env;
}

function createFakeAdapterFile(root, recordRemoteEffects) {
  const adapterPath = path.join(root, 'fake-adapter.js');
  writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fake-enterprise-fixture', version: '4.0.0' }, null, 2));
  writeFile(path.join(root, 'surfaces.json'), JSON.stringify({
    schema: 1, release: { major: 4 },
    roles: { 'test/enterprise': { kind: 'enterprise', includes: ['fake-adapter.js'] } },
  }, null, 2));
  fs.writeFileSync(adapterPath, fakeAdapterScript(recordRemoteEffects));
  return adapterPath;
}

function fakeAdapterScript(recordRemoteEffects) {
  const remoteMutation = recordRemoteEffects ? `const { execFileSync } = require('node:child_process');
const body = '<!-- lifecycle-revision -->\\nrevision=' + event.revision;
execFileSync('gh', ['api', 'repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/comments', '-f', 'body=' + body], { stdio: 'ignore' });
` : '';
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const event = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
${remoteMutation}fs.appendFileSync(process.env.FAKE_ADAPTER_TRACE, JSON.stringify({ event_id: event.event_id, revision: event.revision }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded', proof_ref: 'test:proof', proof_hash: '${'a'.repeat(64)}' }) + '\\n');
`;
}

function parseJson(output) {
  try { return JSON.parse(output); } catch { return null; }
}

function assertInstall(result, json, label) {
  const assert = require('node:assert/strict');
  assert.equal(result.exit, 0, `${label} must succeed: ${result.stdout}${result.stderr}`);
  assert.ok(json && json.ok, `${label} must return success: ${result.stdout}`);
}

module.exports = { installEnterpriseAdapter, installFakeAdapter };
