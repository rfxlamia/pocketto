'use strict';

// Short-lived filesystem guard shared by per-plan claim acquisition and
// lifecycle.json read-modify-write operations.

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function acquireLifecycleGuard(lockPath, { wait = false } = {}) {
  const guardPath = `${lockPath}.guard`;
  for (;;) {
    const ownerId = randomUUID();
    let descriptor;
    try {
      descriptor = fs.openSync(guardPath, 'wx', 0o600);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        if (!wait) return null;
        // The owner performs only synchronous local file operations. Wait
        // briefly and retry instead of failing a concurrent document update.
        Atomics.wait(WAIT_BUFFER, 0, 0, 10);
        continue;
      }
      throw err;
    }

    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ owner_id: ownerId, owner_pid: process.pid })}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
    } catch (err) {
      try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(guardPath); } catch {}
      throw err;
    }
    return { guardPath, owner_id: ownerId };
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

module.exports = { acquireLifecycleGuard, releaseLifecycleGuard };
