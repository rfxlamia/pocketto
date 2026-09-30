'use strict';

// Local Core dispatch for committed lifecycle events. The registered adapter
// remains an opaque executable; Core only passes the neutral event document.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CliError } = require('./envelope');
const { readLifecycleDoc, updateEventDelivery } = require('./lifecycle-store');

const REGISTRATION_PATH = path.join('.pocket', 'lifecycle-adapter.json');

function readAdapterRegistration(projectDir) {
  const registrationPath = path.resolve(projectDir, REGISTRATION_PATH);
  if (!fs.existsSync(registrationPath)) return null;

  let registration;
  try {
    registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  } catch (err) {
    throw new CliError('LIFECYCLE_ADAPTER_INVALID', `cannot read lifecycle adapter registration: ${err.message}`);
  }
  if (
    !registration
    || registration.schema !== 1
    || registration.adapter_contract !== 1
    || !Array.isArray(registration.argv)
    || registration.argv.length === 0
    || registration.argv.some((arg) => typeof arg !== 'string' || arg.length === 0)
    || !Array.isArray(registration.events)
  ) {
    throw new CliError('LIFECYCLE_ADAPTER_INVALID', 'lifecycle adapter registration is invalid');
  }
  return registration;
}

function invokeAdapter(event, registration) {
  const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketto-lifecycle-event-'));
  const eventPath = path.join(eventDir, 'event.json');
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
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: registration.timeout_ms,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
      throw new CliError('LIFECYCLE_ADAPTER_FAILED', 'registered lifecycle adapter invocation failed');
    }
    if (result.status !== 0) {
      throw new CliError('LIFECYCLE_ADAPTER_FAILED', `registered lifecycle adapter exited with status ${result.status}`);
    }

    let response;
    try {
      response = JSON.parse(String(result.stdout || '').trim());
    } catch {
      throw new CliError('LIFECYCLE_ADAPTER_RESPONSE', 'registered lifecycle adapter returned invalid JSON');
    }
    if (!response || response.event_id !== event.event_id || response.status !== 'succeeded') {
      throw new CliError('LIFECYCLE_ADAPTER_RESPONSE', 'registered lifecycle adapter did not confirm the event');
    }
    return response;
  } finally {
    fs.rmSync(eventDir, { recursive: true, force: true });
  }
}

function runDrain({ specDir } = {}) {
  if (typeof specDir !== 'string' || specDir.length === 0) {
    throw new CliError('USAGE', 'Usage: pocketto-pi lifecycle drain <spec_dir>');
  }

  const doc = readLifecycleDoc(specDir);
  if (!doc) throw new CliError('LIFECYCLE_NOT_FOUND', `lifecycle document not found: ${specDir}`);
  const registration = readAdapterRegistration(process.cwd());
  const events = doc.events
    .filter((event) => ['pending', 'retryable'].includes(event.delivery.status))
    .sort((left, right) => left.revision - right.revision);
  const deliveries = [];

  for (const event of events) {
    if (!registration || !registration.events.includes(event.type)) {
      deliveries.push({ event_id: event.event_id, revision: event.revision, status: event.delivery.status, deferred: true });
      continue;
    }

    const attempted = updateEventDelivery(specDir, event.event_id, {
      attempts: event.delivery.attempts + 1,
    });
    if (!attempted.ok) throw new CliError(attempted.code, attempted.message);

    invokeAdapter(attempted.event, registration);

    const completed = updateEventDelivery(specDir, event.event_id, { status: 'succeeded' });
    if (!completed.ok) throw new CliError(completed.code, completed.message);
    deliveries.push({
      event_id: completed.event.event_id,
      revision: completed.event.revision,
      status: completed.event.delivery.status,
      deferred: false,
    });
  }

  return {
    command: 'lifecycle drain',
    exit: 0,
    human: [`Processed ${deliveries.filter((delivery) => !delivery.deferred).length} lifecycle event(s).`],
    data: {
      plan_id: doc.plan.plan_id,
      revision: doc.plan.revision,
      deliveries,
    },
  };
}

module.exports = { runDrain };
