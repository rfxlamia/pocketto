'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CliError } = require('./envelope');
const { acquireLifecycleGuard: acquireGuard, releaseLifecycleGuard: releaseGuard } = require('./lifecycle-lock');

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
  if (!Number.isFinite(expiresAt) || expiresAt > now || ownerProcessIsAlive(existing.owner_pid)) return false;
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

module.exports = { acquireEventClaim, releaseEventClaim };
