'use strict';

const { CliError } = require('./envelope');
const { readLifecycleDoc, updateEventDelivery } = require('./lifecycle-store');
const { CLAIM_LEASE_MS, CLAIM_RELEASE_MARGIN_MS, acquireEventClaim, extendEventClaim, releaseEventClaim } = require('./lifecycle-claims');
const { invokeAdapter, resolveProjectRoot } = require('./lifecycle-adapter');
const { preflightAdapter } = require('./lifecycle-adapter-compatibility');
const { failureDeliveryPatch, protocolFailure, responseDeliveryPatch } = require('./lifecycle-retry');

const ACTIVE_DELIVERY_STATUSES = new Set(['pending', 'retryable', 'claimed', 'reconciling']);
// Fail-closed preflight: the event stays at its current delivery status.
// Counting these as attempts would turn a missing or mismatched adapter
// into a terminal event and block later replay of the original ID.
const NON_BURNING_ADAPTER_CODES = new Set([
  'ADAPTER_NOT_REGISTERED',
  'ADAPTER_MAJOR_UNVERIFIED',
  'ADAPTER_MAJOR_UNSUPPORTED',
  'ADAPTER_MAJOR_MISMATCH',
]);

function highestContiguousSucceededRevision(doc) {
  const byRevision = new Map(doc.events.map((event) => [event.revision, event]));
  let revision = 0;
  while (byRevision.get(revision + 1)?.delivery.status === 'succeeded') revision += 1;
  return revision;
}

function currentTimeMs() {
  const now = new Date(process.env.POCKETTO_LIFECYCLE_NOW || Date.now()).getTime();
  if (!Number.isFinite(now)) throw new CliError('LIFECYCLE_BAD_CLOCK', 'lifecycle clock must be a valid timestamp');
  return now;
}

function recordGap(doc, event, expectedRevision, deliveries, gaps) {
  gaps.push({
    plan_id: doc.plan.plan_id,
    blocked_revision: event.revision,
    missing_predecessor: expectedRevision,
    next_step: `Restore or replay lifecycle revision ${expectedRevision} for plan ${doc.plan.plan_id}, then rerun lifecycle drain.`,
  });
  deliveries.push({
    event_id: event.event_id,
    revision: event.revision,
    status: event.delivery.status,
    deferred: true,
    blocked_by_gap: true,
  });
}

function inspectEvent(specDir, eventId, deliveries, gaps) {
  const doc = readLifecycleDoc(specDir);
  const event = doc && doc.events.find((candidate) => candidate.event_id === eventId);
  if (!event || !ACTIVE_DELIVERY_STATUSES.has(event.delivery.status)) return { action: 'skip' };

  const now = currentTimeMs();
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
      return { action: 'stop' };
    }
  }

  const contiguousRevision = highestContiguousSucceededRevision(doc);
  if (event.revision <= contiguousRevision) return { action: 'skip' };
  const expectedRevision = contiguousRevision + 1;
  if (event.revision > expectedRevision) {
    recordGap(doc, event, expectedRevision, deliveries, gaps);
    return { action: 'stop' };
  }
  return { action: 'ready', doc, event };
}

function recordHeldClaim(event, deliveries) {
  deliveries.push({
    event_id: event.event_id,
    revision: event.revision,
    status: event.delivery.status,
    deferred: true,
    reason: 'claim-held',
  });
}

function recordUnavailable(event, adapterError, deliveries) {
  deliveries.push({
    event_id: event.event_id,
    revision: event.revision,
    status: event.delivery.status,
    deferred: true,
    reason: 'adapter-unavailable',
    error: {
      code: adapterError.code,
      retryable: true,
      message: adapterError.message,
    },
  });
}

function attemptDelivery(specDir, event, adapter, projectRoot) {
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
      response = invokeAdapter(attempted.event, adapter.registration, projectRoot);
    } catch (err) {
      failure = err && typeof err.code === 'string'
        ? protocolFailure(err.code, 'registered lifecycle adapter failed protocol validation', err.retryable !== false)
        : protocolFailure('ADAPTER_PROTOCOL_ERROR', 'registered lifecycle adapter failed protocol validation');
    }
  }

  const nowMs = currentTimeMs();
  const outcome = failure
    ? failureDeliveryPatch(failure, attempts, nowMs)
    : responseDeliveryPatch(response, attempts, nowMs);
  const persisted = updateEventDelivery(specDir, event.event_id, outcome);
  return persisted;
}

function persistedDeliveryResult(persisted) {
  const delivery = persisted.event.delivery;
  const result = {
    event_id: persisted.event.event_id,
    revision: persisted.event.revision,
    status: delivery.status,
    deferred: delivery.status !== 'succeeded',
  };
  if (delivery.error) result.error = delivery.error;
  if (delivery.next_attempt_at) result.next_attempt_at = delivery.next_attempt_at;
  return { result, delivery };
}

function inFlightHoldMs(adapter) {
  if (!adapter || adapter.error || !adapter.registration) return null;
  const timeout = adapter.registration.timeout_ms;
  if (!Number.isInteger(timeout) || timeout < 1) return null;
  // The idle lease stays 60s. Cover the granted timeout when it is longer,
  // plus a margin for the delivery write that follows spawnSync.
  return Math.max(CLAIM_LEASE_MS, timeout + CLAIM_RELEASE_MARGIN_MS);
}

function processClaimedEvent(specDir, eventId, claim, adapter, projectRoot, deliveries, gaps) {
  let releaseClaim = true;
  try {
    const inspection = inspectEvent(specDir, eventId, deliveries, gaps);
    if (inspection.action === 'skip') return 'continue';
    if (inspection.action !== 'ready') return 'stop';

    const holdMs = inFlightHoldMs(adapter);
    if (holdMs !== null && !extendEventClaim(claim, holdMs)) {
      releaseClaim = false;
      recordHeldClaim(inspection.event, deliveries);
      return 'stop';
    }

    const persisted = attemptDelivery(specDir, inspection.event, adapter, projectRoot);
    if (!persisted.ok) {
      releaseClaim = false;
      throw new CliError(persisted.code, persisted.message);
    }
    const { result, delivery } = persistedDeliveryResult(persisted);
    deliveries.push(result);
    if (delivery.status !== 'succeeded') return 'stop';
    return 'continue';
  } finally {
    if (releaseClaim) releaseEventClaim(claim);
  }
}

function runDrain({ specDir } = {}) {
  if (typeof specDir !== 'string' || specDir.length === 0) {
    throw new CliError('USAGE', 'Usage: pocketto-pi lifecycle drain <spec_dir>');
  }

  const doc = readLifecycleDoc(specDir);
  if (!doc) throw new CliError('LIFECYCLE_NOT_FOUND', `lifecycle document not found: ${specDir}`);
  const projectRoot = resolveProjectRoot(specDir);
  const adapter = preflightAdapter(projectRoot);
  const holdForAdapter = Boolean(adapter.error && NON_BURNING_ADAPTER_CODES.has(adapter.error.code));
  const events = doc.events
    .filter((event) => ACTIVE_DELIVERY_STATUSES.has(event.delivery.status))
    .sort((left, right) => left.revision - right.revision);
  const deliveries = [];
  const gaps = [];

  for (const queuedEvent of events) {
    const inspection = inspectEvent(specDir, queuedEvent.event_id, deliveries, gaps);
    if (inspection.action === 'skip') continue;
    if (inspection.action !== 'ready') break;
    if (holdForAdapter) {
      recordUnavailable(inspection.event, adapter.error, deliveries);
      break;
    }

    const claim = acquireEventClaim(specDir, inspection.doc.plan.plan_id, inspection.event.event_id);
    if (!claim) {
      recordHeldClaim(inspection.event, deliveries);
      break;
    }
    if (processClaimedEvent(specDir, queuedEvent.event_id, claim, adapter, projectRoot, deliveries, gaps) === 'stop') break;
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

module.exports = { runDrain };
