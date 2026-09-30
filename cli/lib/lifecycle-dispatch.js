'use strict';

// Local Core dispatch for committed lifecycle events. The registered adapter
// remains an opaque executable; Core only passes the neutral event document.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { CliError } = require('./envelope');
const { writeFileAtomicSync } = require('./atomic-file');
const { readLog } = require('./logjson');
const { validateAdapterResponse } = require('./lifecycle-contract');
const { acquireLifecycleGuard: acquireGuard, releaseLifecycleGuard: releaseGuard } = require('./lifecycle-lock');
const { readLifecycleDoc, updateEventDelivery } = require('./lifecycle-store');

const REGISTRATION_PATH = path.join('.pocket', 'lifecycle-adapter.json');
const CLAIM_LEASE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

function ownerProcessIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !err || !['ESRCH', 'EINVAL'].includes(err.code);
  }
}

function acquireClaimGuard(lockPath) {
  try {
    return acquireGuard(lockPath);
  } catch {
    throw new CliError('LIFECYCLE_CLAIM_FAILED', 'could not serialize lifecycle claim acquisition');
  }
}

function releaseClaimGuard(guard) {
  try {
    releaseGuard(guard);
  } catch {
    throw new CliError('LIFECYCLE_CLAIM_FAILED', 'could not release lifecycle claim guard');
  }
}

function acquireEventClaim(specDir, planId, eventId) {
  const lockPath = path.join(specDir, '.lifecycle.lock');
  const guard = acquireClaimGuard(lockPath);
  if (!guard) return null;

  try {
    const clock = new Date(process.env.POCKETTO_LIFECYCLE_NOW || Date.now());
    if (Number.isNaN(clock.getTime())) {
      throw new CliError('LIFECYCLE_BAD_CLOCK', 'lifecycle clock must be a valid timestamp');
    }
    const now = clock.getTime();
    if (fs.existsSync(lockPath)) {
      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch (err) {
        if (!err || err.code !== 'ENOENT') return null;
      }
      if (existing) {
        const expiresAt = Date.parse(existing.lease_expires_at);
        if (!Number.isFinite(expiresAt) || expiresAt > now || ownerProcessIsAlive(existing.owner_pid)) return null;
        fs.unlinkSync(lockPath);
      }
    }

    const ownerId = randomUUID();
    const claimedAt = clock.toISOString();
    const record = {
      plan_id: planId,
      event_id: eventId,
      owner_id: ownerId,
      owner_pid: process.pid,
      claimed_at: claimedAt,
      lease_expires_at: new Date(now + CLAIM_LEASE_MS).toISOString(),
    };

    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err && err.code === 'EEXIST') return null;
      throw new CliError('LIFECYCLE_CLAIM_FAILED', `could not claim lifecycle plan ${planId}`);
    }

    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
    } catch (err) {
      try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
      throw new CliError('LIFECYCLE_CLAIM_FAILED', `could not persist lifecycle claim for ${eventId}: ${err.message}`);
    }
    return { lockPath, owner_id: ownerId };
  } finally {
    releaseClaimGuard(guard);
  }
}

function releaseEventClaim(claim) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(claim.lockPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw new CliError('LIFECYCLE_CLAIM_FAILED', 'could not verify lifecycle claim owner before release');
  }
  if (record.owner_id !== claim.owner_id) return;
  try {
    fs.unlinkSync(claim.lockPath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      throw new CliError('LIFECYCLE_CLAIM_FAILED', 'could not release lifecycle claim');
    }
  }
}

function highestContiguousSucceededRevision(doc) {
  const byRevision = new Map(doc.events.map((event) => [event.revision, event]));
  let revision = 0;
  while (byRevision.get(revision + 1)?.delivery.status === 'succeeded') revision += 1;
  return revision;
}

function protocolFailure(code, message, retryable = true) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function currentTimeMs() {
  const now = new Date(process.env.POCKETTO_LIFECYCLE_NOW || Date.now()).getTime();
  if (!Number.isFinite(now)) throw new CliError('LIFECYCLE_BAD_CLOCK', 'lifecycle clock must be a valid timestamp');
  return now;
}

function safeErrorCode(code, fallback = 'ADAPTER_PROTOCOL_ERROR') {
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : fallback;
}

function failureDeliveryPatch(error, attempts, nowMs) {
  const retryable = error.retryable !== false;
  const canRetry = retryable && attempts < MAX_DELIVERY_ATTEMPTS;
  const code = safeErrorCode(error.code);
  if (canRetry) {
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    return {
      status: 'retryable',
      next_attempt_at: new Date(nowMs + delay).toISOString(),
      manual_resolution: false,
      error: {
        code,
        retryable: true,
        message: 'registered lifecycle adapter returned a retryable protocol failure',
        attempts,
      },
    };
  }
  return {
    status: 'terminal',
    next_attempt_at: null,
    manual_resolution: true,
    error: {
      code: attempts >= MAX_DELIVERY_ATTEMPTS ? 'MAX_ADAPTER_ATTEMPTS_EXCEEDED' : code,
      retryable: false,
      message: attempts >= MAX_DELIVERY_ATTEMPTS
        ? 'maximum lifecycle adapter attempts reached; manual resolution required'
        : 'registered lifecycle adapter requires manual resolution',
      attempts,
    },
  };
}

function responseDeliveryPatch(response, attempts, nowMs) {
  const proof = {};
  for (const key of ['proof_ref', 'proof_hash']) {
    if (Object.prototype.hasOwnProperty.call(response, key)) proof[key] = response[key];
  }
  if (response.status === 'succeeded') {
    return {
      ...proof,
      status: 'succeeded',
      error: null,
      next_attempt_at: null,
      manual_resolution: false,
    };
  }
  if (response.status === 'retryable') {
    const adapterError = response.error || {
      code: 'ADAPTER_RETRYABLE',
      retryable: true,
      message: 'adapter requested a retry',
    };
    const outcome = failureDeliveryPatch(
      protocolFailure(
        safeErrorCode(adapterError.code),
        'registered lifecycle adapter reported a retryable outcome',
        adapterError.retryable,
      ),
      attempts,
      nowMs,
    );
    return { ...proof, ...outcome };
  }
  if (response.status === 'terminal') {
    const adapterError = response.error || {
      code: 'ADAPTER_TERMINAL',
      retryable: false,
      message: 'adapter requested manual resolution',
    };
    return {
      ...proof,
      ...failureDeliveryPatch(
        protocolFailure(
          safeErrorCode(adapterError.code, 'ADAPTER_TERMINAL'),
          'registered lifecycle adapter requires manual resolution',
          false,
        ),
        attempts,
        nowMs,
      ),
    };
  }
  if (attempts >= MAX_DELIVERY_ATTEMPTS || (response.error && response.error.retryable === false)) {
    const reconciliationError = response.error || {
      code: 'ADAPTER_RECONCILIATION_LIMIT',
      retryable: false,
      message: 'adapter requires manual reconciliation',
    };
    return {
      ...proof,
      ...failureDeliveryPatch(
        protocolFailure(
          safeErrorCode(reconciliationError.code, 'ADAPTER_RECONCILIATION_LIMIT'),
          'adapter requires manual resolution after bounded reconciliation attempts',
          false,
        ),
        attempts,
        nowMs,
      ),
    };
  }
  return {
    ...proof,
    status: 'reconciling',
    error: response.error ? {
      code: safeErrorCode(response.error.code),
      retryable: response.error.retryable,
      message: 'registered lifecycle adapter reported an outcome requiring reconciliation',
      attempts,
    } : null,
    next_attempt_at: null,
    manual_resolution: false,
  };
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
    || registration.timeout_ms > 30_000
  ) {
    return { registration: null, error: protocolFailure('ADAPTER_REGISTRATION_INVALID', 'lifecycle adapter registration is invalid') };
  }
  return { registration, error: null };
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
      const timedOut = result.error.code === 'ETIMEDOUT' || result.error.errno === 'ETIMEDOUT';
      throw protocolFailure(
        timedOut ? 'ADAPTER_TIMEOUT' : 'ADAPTER_EXECUTION_FAILED',
        timedOut ? 'registered lifecycle adapter timed out' : 'registered lifecycle adapter could not be executed',
      );
    }
    if (result.status !== 0) {
      throw protocolFailure('ADAPTER_EXIT_NON_ZERO', 'registered lifecycle adapter exited unsuccessfully');
    }

    let response;
    try {
      response = JSON.parse(String(result.stdout || '').trim());
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
  } finally {
    fs.rmSync(eventDir, { recursive: true, force: true });
  }
}

function initializeProjection(planDir, logPath) {
  let projection = null;
  if (fs.existsSync(logPath)) {
    try {
      projection = readLog(logPath);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }

  if (!projection || !projection.header || !Array.isArray(projection.phases)) {
    if (fs.existsSync(logPath)) fs.rmSync(logPath);
    const logCommand = require('../commands/log');
    logCommand.run({ sub: 'init', positionals: [planDir] });
    projection = readLog(logPath);
  }
  if (!projection.header || !Array.isArray(projection.phases)) {
    throw new CliError('LIFECYCLE_REPAIR_FAILED', `could not rebuild lifecycle projection: ${logPath}`);
  }
  return projection;
}

function projectionPathKey(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function applyLifecycleProjection(doc, projection) {
  const phases = projection.phases;
  const events = [...doc.events].sort((left, right) => left.revision - right.revision);
  for (const event of events) {
    if (event.type !== 'phase-complete') continue;
    for (const ref of event.artifact_refs || []) {
      if (ref.root !== 'plan' || ref.kind !== 'phase-evidence') continue;
      const phase = phases.find((candidate) => projectionPathKey(candidate.file) === projectionPathKey(ref.path));
      if (phase && phase.status === 'WAITING') phase.status = 'REVIEW';
    }
  }

  const planState = (doc.plan && doc.plan.state) || {};
  if (planState.status === 'DONE') {
    for (const phase of phases) phase.status = 'DONE';
    projection.header.status = 'DONE';
    const closeEvent = events.find((event) => event.type === 'plan-closed');
    if (closeEvent && typeof closeEvent.occurred_at === 'string') {
      projection.header.date_completed = closeEvent.occurred_at.slice(0, 10);
    }
  } else {
    projection.header.status = 'IN_PROGRESS';
    projection.header.date_completed = null;
  }
  return projection;
}

function runDrain({ specDir } = {}) {
  if (typeof specDir !== 'string' || specDir.length === 0) {
    throw new CliError('USAGE', 'Usage: pocketto-pi lifecycle drain <spec_dir>');
  }

  const doc = readLifecycleDoc(specDir);
  if (!doc) throw new CliError('LIFECYCLE_NOT_FOUND', `lifecycle document not found: ${specDir}`);
  const adapter = readAdapterRegistration(process.cwd());
  const events = doc.events
    .filter((event) => ['pending', 'retryable', 'claimed', 'reconciling'].includes(event.delivery.status))
    .sort((left, right) => left.revision - right.revision);
  const deliveries = [];
  const gaps = [];

  for (const queuedEvent of events) {
    let currentDoc = readLifecycleDoc(specDir);
    let event = currentDoc && currentDoc.events.find((candidate) => candidate.event_id === queuedEvent.event_id);
    if (!event || !['pending', 'retryable', 'claimed', 'reconciling'].includes(event.delivery.status)) continue;

    let now = currentTimeMs();
    if (event.delivery.status === 'retryable' && typeof event.delivery.next_attempt_at === 'string') {
      const nextAttempt = Date.parse(event.delivery.next_attempt_at);
      if (Number.isFinite(nextAttempt) && now < nextAttempt) {
        deliveries.push({
          event_id: event.event_id,
          revision: event.revision,
          status: event.delivery.status,
          deferred: true,
          reason: 'retry-backoff',
          next_attempt_at: event.delivery.next_attempt_at,
        });
        break;
      }
    }

    let contiguousRevision = highestContiguousSucceededRevision(currentDoc);
    if (event.revision <= contiguousRevision) continue;
    const expectedRevision = contiguousRevision + 1;
    if (event.revision > expectedRevision) {
      gaps.push({
        plan_id: currentDoc.plan.plan_id,
        blocked_revision: event.revision,
        missing_predecessor: expectedRevision,
        next_step: `Restore or replay lifecycle revision ${expectedRevision} for plan ${currentDoc.plan.plan_id}, then rerun lifecycle drain.`,
      });
      deliveries.push({
        event_id: event.event_id,
        revision: event.revision,
        status: event.delivery.status,
        deferred: true,
        blocked_by_gap: true,
      });
      break;
    }

    const claim = acquireEventClaim(specDir, currentDoc.plan.plan_id, event.event_id);
    if (!claim) {
      deliveries.push({
        event_id: event.event_id,
        revision: event.revision,
        status: event.delivery.status,
        deferred: true,
        reason: 'claim-held',
      });
      break;
    }

    let releaseClaim = true;
    try {
      currentDoc = readLifecycleDoc(specDir);
      event = currentDoc && currentDoc.events.find((candidate) => candidate.event_id === queuedEvent.event_id);
      if (!event || !['pending', 'retryable', 'claimed', 'reconciling'].includes(event.delivery.status)) continue;

      now = currentTimeMs();
      if (event.delivery.status === 'retryable' && typeof event.delivery.next_attempt_at === 'string') {
        const nextAttempt = Date.parse(event.delivery.next_attempt_at);
        if (Number.isFinite(nextAttempt) && now < nextAttempt) {
          deliveries.push({
            event_id: event.event_id,
            revision: event.revision,
            status: event.delivery.status,
            deferred: true,
            reason: 'retry-backoff',
            next_attempt_at: event.delivery.next_attempt_at,
          });
          break;
        }
      }

      contiguousRevision = highestContiguousSucceededRevision(currentDoc);
      if (event.revision <= contiguousRevision) continue;
      const latestExpectedRevision = contiguousRevision + 1;
      if (event.revision > latestExpectedRevision) {
        gaps.push({
          plan_id: currentDoc.plan.plan_id,
          blocked_revision: event.revision,
          missing_predecessor: latestExpectedRevision,
          next_step: `Restore or replay lifecycle revision ${latestExpectedRevision} for plan ${currentDoc.plan.plan_id}, then rerun lifecycle drain.`,
        });
        deliveries.push({
          event_id: event.event_id,
          revision: event.revision,
          status: event.delivery.status,
          deferred: true,
          blocked_by_gap: true,
        });
        break;
      }

      const attempts = event.delivery.attempts + 1;
      const attempted = updateEventDelivery(specDir, event.event_id, {
        status: 'claimed',
        attempts,
        error: null,
        next_attempt_at: null,
        manual_resolution: false,
      });
      if (!attempted.ok) throw new CliError(attempted.code, attempted.message);

      let response = null;
      let failure = adapter.error;
      if (!failure && !adapter.registration.events.includes(event.type)) {
        failure = protocolFailure('ADAPTER_EVENT_UNSUPPORTED', 'registered lifecycle adapter does not support this event type');
      }
      if (!failure) {
        try {
          response = invokeAdapter(attempted.event, adapter.registration);
        } catch (err) {
          failure = err && typeof err.code === 'string'
            ? protocolFailure(err.code, 'registered lifecycle adapter failed protocol validation', err.retryable !== false)
            : protocolFailure('ADAPTER_PROTOCOL_ERROR', 'registered lifecycle adapter failed protocol validation');
        }
      }

      let persisted;
      if (failure) {
        const outcome = failureDeliveryPatch(failure, attempts, currentTimeMs());
        persisted = updateEventDelivery(specDir, event.event_id, outcome);
      } else {
        const outcome = responseDeliveryPatch(response, attempts, currentTimeMs());
        persisted = updateEventDelivery(specDir, event.event_id, outcome);
      }
      if (!persisted.ok) {
        releaseClaim = false;
        throw new CliError(persisted.code, persisted.message);
      }

      const delivery = persisted.event.delivery;
      const result = {
        event_id: persisted.event.event_id,
        revision: persisted.event.revision,
        status: delivery.status,
        deferred: delivery.status !== 'succeeded',
      };
      if (delivery.error) result.error = delivery.error;
      if (delivery.next_attempt_at) result.next_attempt_at = delivery.next_attempt_at;
      deliveries.push(result);
      if (delivery.status !== 'succeeded') break;
    } finally {
      if (releaseClaim) releaseEventClaim(claim);
    }
  }

  return {
    command: 'lifecycle drain',
    exit: 0,
    human: [`Processed ${deliveries.filter((delivery) => delivery.status === 'succeeded').length} lifecycle event(s).`],
    data: {
      plan_id: doc.plan.plan_id,
      revision: doc.plan.revision,
      deliveries,
      gaps,
    },
  };
}

function runRepair({ specDir } = {}) {
  if (typeof specDir !== 'string' || specDir.length === 0) {
    throw new CliError('USAGE', 'Usage: pocketto-pi lifecycle repair <spec_dir>');
  }

  const doc = readLifecycleDoc(specDir);
  if (!doc) throw new CliError('LIFECYCLE_NOT_FOUND', `lifecycle document not found: ${specDir}`);
  if (!doc.plan || typeof doc.plan.plan_dir !== 'string' || doc.plan.plan_dir.length === 0) {
    throw new CliError('LIFECYCLE_PLAN_DIR_REQUIRED', 'lifecycle repair requires a committed plan_dir');
  }

  const planDir = path.resolve(doc.plan.plan_dir);
  const logPath = path.join(planDir, 'log.json');
  const projection = initializeProjection(planDir, logPath);
  applyLifecycleProjection(doc, projection);
  const serialized = `${JSON.stringify(projection, null, 2)}\n`;
  const current = fs.readFileSync(logPath, 'utf8');
  if (current !== serialized) {
    try {
      writeFileAtomicSync(logPath, serialized);
    } catch (err) {
      throw new CliError('LIFECYCLE_REPAIR_FAILED', `could not write repaired projection: ${err.message}`);
    }
  }

  return {
    command: 'lifecycle repair',
    exit: 0,
    human: [`Rebuilt ${logPath} from committed lifecycle state (revision ${doc.plan.revision}).`],
    data: {
      plan_id: doc.plan.plan_id,
      plan_dir: planDir,
      log_path: logPath,
      revision: doc.plan.revision,
      journal_length: doc.events.length,
    },
  };
}

module.exports = { runDrain, runRepair };
