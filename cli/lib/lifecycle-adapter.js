'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateAdapterResponse } = require('./lifecycle-contract');
const { protocolFailure } = require('./lifecycle-retry');

const REGISTRATION_PATH = path.join('.pocket', 'lifecycle-adapter.json');
// Enterprise install accepts the same ceiling (registration-record.js).
// A lower Core bound rejects a legal install as ADAPTER_REGISTRATION_INVALID.
const MAX_ADAPTER_TIMEOUT_MS = 600_000;

function resolveProjectRoot(startDir) {
  if (typeof startDir !== 'string' || startDir.length === 0) return null;
  let dir = path.resolve(startDir);
  const filesystemRoot = path.parse(dir).root;
  while (true) {
    if (fs.existsSync(path.join(dir, REGISTRATION_PATH)) || fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    if (dir === filesystemRoot) return path.resolve(startDir);
    dir = path.dirname(dir);
  }
}

function readAdapterRegistration(projectDir) {
  const registrationPath = path.resolve(projectDir, REGISTRATION_PATH);
  if (!fs.existsSync(registrationPath)) {
    return { registration: null, error: protocolFailure('ADAPTER_NOT_REGISTERED', 'lifecycle adapter registration is missing') };
  }

  let registration;
  try {
    registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  } catch {
    return { registration: null, error: protocolFailure('ADAPTER_REGISTRATION_MALFORMED', 'lifecycle adapter registration is malformed') };
  }
  if (!registration || typeof registration !== 'object' || Array.isArray(registration)) {
    return { registration: null, error: protocolFailure('ADAPTER_REGISTRATION_INVALID', 'lifecycle adapter registration is invalid') };
  }
  if (registration.adapter_contract !== 1) {
    return { registration: null, error: protocolFailure('ADAPTER_CONTRACT_MISMATCH', 'registered lifecycle adapter contract is incompatible') };
  }
  if (
    registration.schema !== 1
    || !Array.isArray(registration.argv)
    || registration.argv.length === 0
    || registration.argv.some((arg) => typeof arg !== 'string' || arg.length === 0)
    || !Array.isArray(registration.events)
    || registration.events.some((event) => typeof event !== 'string')
    || !Number.isInteger(registration.timeout_ms)
    || registration.timeout_ms < 1
    || registration.timeout_ms > MAX_ADAPTER_TIMEOUT_MS
  ) {
    return { registration: null, error: protocolFailure('ADAPTER_REGISTRATION_INVALID', 'lifecycle adapter registration is invalid') };
  }
  return { registration, error: null };
}

function parseAdapterResponse(stdout, event) {
  let response;
  try {
    response = JSON.parse(String(stdout || '').trim());
  } catch {
    throw protocolFailure('ADAPTER_RESPONSE_MALFORMED', 'registered lifecycle adapter returned malformed JSON');
  }
  const validation = validateAdapterResponse(response, event.event_id);
  if (!validation.ok) {
    throw protocolFailure('ADAPTER_RESPONSE_INVALID', 'registered lifecycle adapter returned an invalid response');
  }
  if (response.status === 'succeeded' && response.error) {
    throw protocolFailure('ADAPTER_RESPONSE_INVALID', 'registered lifecycle adapter returned a contradictory success response');
  }
  return response;
}

function invocationFailure(error) {
  const timedOut = error.code === 'ETIMEDOUT' || error.errno === 'ETIMEDOUT';
  return protocolFailure(
    timedOut ? 'ADAPTER_TIMEOUT' : 'ADAPTER_EXECUTION_FAILED',
    timedOut ? 'registered lifecycle adapter timed out' : 'registered lifecycle adapter could not be executed',
  );
}

function invokeAdapter(event, registration, projectRoot) {
  const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketto-lifecycle-event-'));
  const eventPath = path.join(eventDir, 'event.json');
  const cwd = typeof projectRoot === 'string' && projectRoot.length > 0
    ? path.resolve(projectRoot)
    : process.cwd();
  try {
    fs.writeFileSync(eventPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    const args = [
      ...registration.argv.slice(1),
      eventPath,
      '--json',
      '--contract',
      '3',
    ];
    const result = spawnSync(registration.argv[0], args, {
      cwd,
      encoding: 'utf8',
      timeout: registration.timeout_ms,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw invocationFailure(result.error);
    if (result.status !== 0) {
      throw protocolFailure('ADAPTER_EXIT_NON_ZERO', 'registered lifecycle adapter exited unsuccessfully');
    }
    return parseAdapterResponse(result.stdout, event);
  } finally {
    fs.rmSync(eventDir, { recursive: true, force: true });
  }
}

module.exports = {
  MAX_ADAPTER_TIMEOUT_MS,
  invokeAdapter,
  readAdapterRegistration,
  resolveProjectRoot,
};
