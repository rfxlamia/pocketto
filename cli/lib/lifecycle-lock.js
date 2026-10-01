'use strict';

// Short-lived filesystem guard shared by per-plan claim acquisition and
// lifecycle.json read-modify-write operations.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const OWNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function confirmedDead(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // Only ESRCH proves death. Permission errors and invalid/unknown PIDs
    // remain busy so an unverifiable owner is never bypassed.
    return Boolean(err && err.code === 'ESRCH');
  }
}

function readGuardRecord(guardPath) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { missing: true };
    return { unknown: true };
  }
  if (
    !record
    || !OWNER_ID_PATTERN.test(record.owner_id)
    || !Number.isInteger(record.owner_pid)
    || record.owner_pid < 1
  ) return { unknown: true };
  return { record };
}

function createGuard(guardPath) {
  for (;;) {
    const ownerId = randomUUID();
    const tempPath = `${guardPath}.tmp-${ownerId}`;
    const record = { owner_id: ownerId, owner_pid: process.pid };
    let descriptor = null;
    try {
      descriptor = fs.openSync(tempPath, 'wx', 0o600);
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }

    try {
      // Publish only after the complete owner record is durable; a crash
      // during creation must not expose an unidentifiable empty guard.
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      try {
        fs.linkSync(tempPath, guardPath);
      } catch (err) {
        if (err && err.code === 'EEXIST') return null;
        throw err;
      }
      return { guardPath, owner_id: ownerId };
    } finally {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }
}

function waitForGuardChange() {
  Atomics.wait(WAIT_BUFFER, 0, 0, 10);
}

function acquireLifecycleGuard(lockPath, { wait = false } = {}) {
  const baseGuardPath = `${lockPath}.guard`;
  for (;;) {
    const visited = new Set();
    let candidatePath = baseGuardPath;
    let retry = false;

    for (;;) {
      if (visited.has(candidatePath)) {
        retry = true;
        break;
      }
      visited.add(candidatePath);

      const guard = createGuard(candidatePath);
      if (guard) return guard;

      const existing = readGuardRecord(candidatePath);
      if (existing.missing) continue;
      if (existing.unknown || !confirmedDead(existing.record.owner_pid)) {
        if (!wait) return null;
        waitForGuardChange();
        retry = true;
        break;
      }

      // Do not unlink a stale path: another contender could replace it with
      // a live guard between the liveness check and unlink. All contenders
      // derive the same successor from the dead owner's UUID and race through
      // exclusive creation, so only one successor can become the guard.
      candidatePath = `${baseGuardPath}.recovery-${existing.record.owner_id}`;
    }

    if (retry && !wait) return null;
    if (retry) waitForGuardChange();
  }
}

function releaseLifecycleGuard(guard) {
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
    if (!err || err.code !== 'ENOENT') throw err;
  }
}

function hasSpecDirectory(specDir) {
  try {
    return fs.statSync(specDir).isDirectory();
  } catch {
    return false;
  }
}

function withLifecycleMutation(specDir, mutate) {
  let guard;
  try {
    guard = acquireLifecycleGuard(path.join(specDir, '.lifecycle.lock'), { wait: true });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    return {
      ok: false,
      code: 'LIFECYCLE_MUTATION_LOCK_FAILED',
      message: `could not serialize lifecycle mutation: ${detail}`,
    };
  }

  try {
    return mutate();
  } finally {
    releaseLifecycleGuard(guard);
  }
}

module.exports = {
  acquireLifecycleGuard,
  releaseLifecycleGuard,
  hasSpecDirectory,
  withLifecycleMutation,
};
