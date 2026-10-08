'use strict';

const { execFileSync, spawn } = require('node:child_process');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'cli', 'index.js');
const FIXED_CLOCK = '2026-09-19T12:00:00.000Z';

function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

function parseJson(content, context = 'JSON input') {
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Could not parse ${context}: ${err.message}`, { cause: err });
  }
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

function createLifecycleProject(root, { planId = 'demo-plan', projectName = 'project' } = {}) {
  const projectDir = path.join(root, projectName);
  const specDir = path.join(projectDir, 'spec', planId);
  const planDir = path.join(projectDir, 'plans', planId);
  const pocketDir = path.join(projectDir, '.pocket');
  mkdirSync(specDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  mkdirSync(pocketDir, { recursive: true });
  return { projectDir, specDir, planDir, pocketDir };
}

// Every seed attempt asserts persistence before the scenario continues.
function seedLifecycleEvent({ specDir, planDir = null, planId, type, artifacts, now = FIXED_CLOCK, branch }) {
  const { commitTransition } = require('../../cli/lib/lifecycle-store');
  const result = commitTransition({
    specDir,
    planDir,
    planId,
    type,
    artifacts,
    ...(branch ? { branch } : {}),
    deps: { now: () => now },
  });
  assertSeeded(result, `event seed should succeed: ${JSON.stringify(result)}`);
  return result;
}

function assertSeeded(result, message) {
  const assert = require('node:assert/strict');
  assert.equal(result.ok, true, message);
  return result;
}

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
  return filePath;
}

function writeAdapterPackageMetadata(adapterPath) {
  const absoluteAdapterPath = path.resolve(adapterPath);
  const packageRoot = path.dirname(absoluteAdapterPath);
  const adapterRelPath = path.relative(packageRoot, absoluteAdapterPath).split(path.sep).join('/');
  const coreRelPath = 'core.js';
  const coreRole = (host) => ({
    host,
    kind: 'core',
    includes: [coreRelPath],
    requires: [],
    forbidden_paths: ['enterprise/'],
    forbidden_content: ['ENTERPRISE_ONLY_SURFACE'],
  });
  const enterpriseRole = (host, coreRoleName) => ({
    host,
    kind: 'enterprise',
    includes: [adapterRelPath],
    requires: [coreRoleName],
    forbidden_paths: ['core/'],
    forbidden_content: ['CORE_ONLY_SURFACE'],
  });

  writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'test-lifecycle-adapter',
    version: '4.0.0',
  }, null, 2)}\n`);
  writeFileSync(path.join(packageRoot, 'surfaces.json'), `${JSON.stringify({
    schema: 1,
    release: { major: 4 },
    roles: {
      'pi/core': coreRole('pi'),
      'pi/enterprise': enterpriseRole('pi', 'pi/core'),
      'claude/core': coreRole('claude'),
      'claude/enterprise': enterpriseRole('claude', 'claude/core'),
    },
  }, null, 2)}\n`);
  writeFileSync(path.join(packageRoot, coreRelPath), '// Test-only Core surface marker.\n');
}

function registerAdapter(pocketDir, adapterPath, {
  adapterContract = 1,
  events = ['spec-approved', 'phase-complete', 'plan-closed'],
  timeoutMs = 30_000,
} = {}) {
  writeAdapterPackageMetadata(adapterPath);
  const registration = {
    schema: 1,
    adapter_contract: adapterContract,
    argv: [adapterPath],
    events,
    timeout_ms: timeoutMs,
  };
  writeFileSync(path.join(pocketDir, 'lifecycle-adapter.json'), `${JSON.stringify(registration, null, 2)}\n`);
  return registration;
}

function readJsonLines(filePath) {
  const content = readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  return content.split(String.fromCharCode(10)).filter(Boolean).map((line) => parseJson(line, filePath));
}

function startDrainWorker(specDir, cwd, env) {
  const child = spawn('node', [CLI, 'lifecycle', 'drain', specDir, '--json', '--contract', '3'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const spawned = new Promise((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  const done = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.once('error', (err) => resolve({ code: -1, signal: null, stdout, stderr: `${stderr}${err.message}` }));
  });
  return { child, spawned, done };
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(filePath);
}

module.exports = {
  CLI,
  FIXED_CLOCK,
  chmodSync,
  execFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  path,
  parseJson,
  readFileSync,
  rmSync,
  runCli,
  sha256Hex,
  createLifecycleProject,
  seedLifecycleEvent,
  startDrainWorker,
  waitForFile,
  writeExecutable,
  registerAdapter,
  readJsonLines,
  spawn,
  tmpdir,
  writeFileSync,
};
