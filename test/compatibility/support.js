'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const enterpriseRegistration = require('../../enterprise/registration');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'cli', 'index.js');
const ENTERPRISE_CLI = path.join(ROOT, 'enterprise', 'cli.js');
const V3_FIXTURE = path.join(__dirname, '..', 'fixtures', 'v3-plan');

function tempDirectory(t, prefix = 'pocket-compat-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function copyV3Plan(t) {
  const tempRoot = tempDirectory(t);
  const specDir = path.join(tempRoot, 'v3-plan');
  fs.cpSync(V3_FIXTURE, specDir, { recursive: true });
  return { tempRoot, specDir };
}

function snapshotTree(root) {
  const snapshot = [];
  const walk = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = path.join(relative, entry.name);
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(childPath, childRelative);
      else if (entry.isFile()) snapshot.push([childRelative, fs.readFileSync(childPath).toString('base64')]);
      else if (entry.isSymbolicLink()) snapshot.push([childRelative, `symlink:${fs.readlinkSync(childPath)}`]);
    }
  };
  walk(root);
  return snapshot;
}

function runCli(args, options = {}) {
  const nodeArgs = [];
  if (options.preload) nodeArgs.push('--require', options.preload);
  nodeArgs.push(options.entrypoint || CLI, ...args);
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    env: options.env || process.env,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout.trim());
  } catch {
    // Preserve stdout/stderr for a useful assertion message.
  }
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, json };
}

function installRecordingRemoteBoundary(specDir, tempRoot, { adapterMajor } = {}) {
  const pocketDir = path.join(specDir, '.pocket');
  fs.mkdirSync(pocketDir, { recursive: true });
  const remoteCalls = path.join(tempRoot, 'remote-calls.jsonl');
  const ghCalls = path.join(tempRoot, 'gh-calls.jsonl');
  fs.writeFileSync(remoteCalls, '');
  fs.writeFileSync(ghCalls, '');

  const adapter = path.join(tempRoot, 'recording-adapter.js');
  fs.writeFileSync(adapter, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const eventFile = process.argv.find((arg) => arg.endsWith('.json') && fs.existsSync(arg));
const event = eventFile ? JSON.parse(fs.readFileSync(eventFile, 'utf8')) : { event_id: 'missing-event' };
fs.appendFileSync(process.env.REMOTE_CALLS, JSON.stringify({ event_id: event.event_id }) + '\\n');
process.stdout.write(JSON.stringify({ event_id: event.event_id, status: 'succeeded' }) + '\\n');
`, { mode: 0o755 });
  if (Number.isInteger(adapterMajor)) {
    fs.writeFileSync(path.join(tempRoot, 'package.json'), `${JSON.stringify({
      name: 'test-enterprise-adapter',
      version: `${adapterMajor}.0.0`,
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(tempRoot, 'surfaces.json'), `${JSON.stringify({
      schema: 1,
      release: { major: adapterMajor },
      roles: {
        'pi/enterprise': { kind: 'enterprise', includes: ['recording-adapter.js'] },
      },
    }, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify({
    schema: 1,
    adapter_contract: 1,
    argv: [process.execPath, adapter],
    events: ['spec-approved', 'phase-complete', 'plan-closed'],
    timeout_ms: 30000,
  }, null, 2)}\n`);

  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const gh = path.join(binDir, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env node\n'use strict';\nrequire('node:fs').appendFileSync(process.env.GH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });
  return { remoteCalls, ghCalls, binDir };
}

function createAtomicObserver(tempRoot, targetPath) {
  const preload = path.join(tempRoot, 'atomic-observer.cjs');
  const trace = path.join(tempRoot, 'atomic-trace.jsonl');
  fs.writeFileSync(trace, '');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(process.env.ATOMIC_TARGET || ${JSON.stringify(targetPath)});
const trace = process.env.ATOMIC_TRACE;
const writeFileSync = fs.writeFileSync;
const renameSync = fs.renameSync;
fs.writeFileSync = function (file, ...args) {
  if (typeof file === 'string' && path.resolve(file) === target) {
    fs.appendFileSync(trace, JSON.stringify({ operation: 'direct-write' }) + '\\n');
  }
  return writeFileSync.call(this, file, ...args);
};
fs.renameSync = function (from, to) {
  if (typeof to === 'string' && path.resolve(to) === target) {
    fs.appendFileSync(trace, JSON.stringify({ operation: 'rename', source: path.basename(from) }) + '\\n');
  }
  return renameSync.call(this, from, to);
};
`);
  return { preload, trace };
}


module.exports = {
  test, assert, fs, os, path, spawnSync, enterpriseRegistration,
  ROOT, CLI, ENTERPRISE_CLI, V3_FIXTURE,
  tempDirectory, copyV3Plan, snapshotTree, runCli,
  installRecordingRemoteBoundary, createAtomicObserver,
};
