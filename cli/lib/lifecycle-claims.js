'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CliError } = require('./envelope');
const { writeFileAtomicSync } = require('./atomic-file');
const { acquireLifecycleGuard: acquireGuard, releaseLifecycleGuard: releaseGuard } = require('./lifecycle-lock');

const CLAIM_LEASE_MS = 60_000;
// Budget for the delivery fsync after spawnSync returns. An in-flight claim
// is leased for the granted adapter timeout plus this margin, so a second
// drain cannot reclaim an invocation that is still inside its timeout.
const CLAIM_RELEASE_MARGIN_MS = 30_000;

function acquireClaimGuard(lockPath, options) {
  try {
    return acquireGuard(lockPath, options);
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

function recoverExpiredEventClaim(lockPath, now) {
  if (!fs.existsSync(lockPath)) return true;
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return false;
  }
  if (!existing) return true;
  const expiresAt = Date.parse(existing.lease_expires_at);
  // Lease expiry is the reclaim gate. owner_pid liveness is not: the kernel
  // can reuse that pid, and a live lookalike would pin the event forever.
  if (!Number.isFinite(expiresAt) || expiresAt > now) return false;
  fs.unlinkSync(lockPath);
  return true;
}

function persistEventClaim(lockPath, record, planId, eventId) {
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
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
  return true;
}

function claimClock() {
  const clock = new Date(process.env.POCKETTO_LIFECYCLE_NOW || Date.now());
  if (Number.isNaN(clock.getTime())) {
    throw new CliError('LIFECYCLE_BAD_CLOCK', 'lifecycle clock must be a valid timestamp');
  }
  return clock;
}

function readClaimRecord(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new CliError('LIFECYCLE_CLAIM_FAILED', 'could not verify lifecycle claim owner');
  }
}

function withOwnedClaim(claim, mutate) {
  const guard = acquireClaimGuard(claim.lockPath, { wait: true });
  try {
    const record = readClaimRecord(claim.lockPath);
    if (!record || record.owner_id !== claim.owner_id) return false;
    return mutate(record);
  } finally {
    releaseClaimGuard(guard);
  }
}

function acquireEventClaim(specDir, planId, eventId) {
  const lockPath = path.join(specDir, '.lifecycle.lock');
  const guard = acquireClaimGuard(lockPath);
  if (!guard) return null;

  try {
    const clock = claimClock();
    const now = clock.getTime();
    if (!recoverExpiredEventClaim(lockPath, now)) return null;

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

    if (!persistEventClaim(lockPath, record, planId, eventId)) return null;
    return { lockPath, owner_id: ownerId };
  } finally {
    releaseClaimGuard(guard);
  }
}

function extendEventClaim(claim, holdMs) {
  if (!Number.isFinite(holdMs) || holdMs < 1) {
    throw new CliError('LIFECYCLE_CLAIM_FAILED', 'in-flight lifecycle claim lease must be a positive duration');
  }
  return withOwnedClaim(claim, (record) => {
    const now = claimClock().getTime();
    record.lease_expires_at = new Date(now + holdMs).toISOString();
    try {
      writeFileAtomicSync(claim.lockPath, `${JSON.stringify(record)}\n`);
    } catch (err) {
      throw new CliError('LIFECYCLE_CLAIM_FAILED', `could not refresh lifecycle claim: ${err.message}`);
    }
    return true;
  });
}

function releaseEventClaim(claim) {
  withOwnedClaim(claim, () => {
    try {
      fs.unlinkSync(claim.lockPath);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        throw new CliError('LIFECYCLE_CLAIM_FAILED', 'could not release lifecycle claim');
      }
    }
    return true;
  });
}

module.exports = {
  CLAIM_LEASE_MS,
  CLAIM_RELEASE_MARGIN_MS,
  acquireEventClaim,
  extendEventClaim,
  releaseEventClaim,
};
