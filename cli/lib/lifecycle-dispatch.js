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
const { readLifecycleDoc, updateEventDelivery } = require('./lifecycle-store');

const REGISTRATION_PATH = path.join('.pocket', 'lifecycle-adapter.json');
const CLAIM_LEASE_MS = 60_000;

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
  const guardPath = `${lockPath}.guard`;
  const ownerId = randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(guardPath, 'wx', 0o600);
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw new CliError('LIFECYCLE_CLAIM_FAILED', 'could not serialize lifecycle claim acquisition');
  }

  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ owner_id: ownerId, owner_pid: process.pid })}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
  } catch (err) {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(guardPath); } catch {}
    throw new CliError('LIFECYCLE_CLAIM_FAILED', `could not persist claim guard: ${err.message}`);
  }
  return { guardPath, owner_id: ownerId };
}

function releaseClaimGuard(guard) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(guard.guardPath, 'utf8'));
  } catch {
    return;
  }
  if (record.owner_id !== guard.owner_id) return;
  try {
    fs.unlinkSync(guard.guardPath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      throw new CliError('LIFECYCLE_CLAIM_FAILED', 'could not release lifecycle claim guard');
    }
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
  const registration = readAdapterRegistration(process.cwd());
  const events = doc.events
    .filter((event) => ['pending', 'retryable', 'claimed'].includes(event.delivery.status))
    .sort((left, right) => left.revision - right.revision);
  const deliveries = [];
  const gaps = [];

  if (registration) {
    for (const queuedEvent of events) {
      let currentDoc = readLifecycleDoc(specDir);
      let event = currentDoc && currentDoc.events.find((candidate) => candidate.event_id === queuedEvent.event_id);
      if (!event || !['pending', 'retryable', 'claimed'].includes(event.delivery.status)) continue;

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
      if (!registration.events.includes(event.type)) {
        deliveries.push({ event_id: event.event_id, revision: event.revision, status: event.delivery.status, deferred: true });
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
        if (!event || !['pending', 'retryable', 'claimed'].includes(event.delivery.status)) continue;

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

        const attempted = updateEventDelivery(specDir, event.event_id, {
          status: 'claimed',
          attempts: event.delivery.attempts + 1,
        });
        if (!attempted.ok) throw new CliError(attempted.code, attempted.message);

        try {
          invokeAdapter(attempted.event, registration);
        } catch (err) {
          const retryable = updateEventDelivery(specDir, event.event_id, { status: 'retryable' });
          if (!retryable.ok) {
            releaseClaim = false;
            throw new CliError(retryable.code, retryable.message);
          }
          throw err;
        }

        const completed = updateEventDelivery(specDir, event.event_id, { status: 'succeeded' });
        if (!completed.ok) {
          releaseClaim = false;
          throw new CliError(completed.code, completed.message);
        }
        deliveries.push({
          event_id: completed.event.event_id,
          revision: completed.event.revision,
          status: completed.event.delivery.status,
          deferred: false,
        });
      } finally {
        if (releaseClaim) releaseEventClaim(claim);
      }
    }
  } else {
    for (const event of events) {
      deliveries.push({ event_id: event.event_id, revision: event.revision, status: event.delivery.status, deferred: true });
    }
  }

  return {
    command: 'lifecycle drain',
    exit: 0,
    human: [`Processed ${deliveries.filter((delivery) => !delivery.deferred).length} lifecycle event(s).`],
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
