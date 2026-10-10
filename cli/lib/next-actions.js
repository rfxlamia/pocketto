'use strict';

// Core-only `next_actions` builder. Every command is a FIXED template. The only
// interpolated value is the resolved spec directory, POSIX single-quoted so the
// shell expands nothing inside it. No adapter response, notice, error message,
// or delivery text ever reaches a command or a reason.

const path = require('node:path');
const { readLifecycleDoc } = require('./lifecycle-store');
const { hasAdapterRegistration } = require('./lifecycle-transition');
const { ACTIVE_DELIVERY_STATUSES } = require('./lifecycle-drain');

const DRAIN_REASON = 'Lifecycle events are pending delivery to the registered adapter; run the lifecycle drain.';

// POSIX single quoting: inside '...' nothing is expanded; an embedded quote
// is written as '\'' (close, escaped quote, reopen).
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function drainAction(specDir) {
  return {
    required: true,
    command: `npx -y pocketto-pi lifecycle drain ${shellQuote(path.resolve(specDir))} --json --contract 3`,
    reason: DRAIN_REASON,
  };
}

function hasActiveDelivery(doc) {
  const events = doc && Array.isArray(doc.events) ? doc.events : [];
  return events.some((event) => ACTIVE_DELIVERY_STATUSES.has(event && event.delivery && event.delivery.status));
}

// [] unless a registered adapter exists AND the lifecycle doc holds an event
// still awaiting delivery. Advisory only: unreadable state yields [] rather
// than blocking the command that asked.
function pendingDrainActions({ specDir = null, projectDir = null } = {}) {
  if (!specDir || !projectDir) return [];
  try {
    if (!hasAdapterRegistration(projectDir)) return [];
    if (!hasActiveDelivery(readLifecycleDoc(specDir))) return [];
    return [drainAction(specDir)];
  } catch {
    return [];
  }
}

module.exports = { drainAction, pendingDrainActions };
