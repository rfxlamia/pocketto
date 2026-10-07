'use strict';

// Atomic same-directory temp-file plus rename writer (T2).
//
// The authoritative lifecycle document must never expose partial state:
// write the full replacement to a temporary file in the SAME directory
// (same filesystem, so rename is atomic) then rename it over the target.
// Node built-ins only. Temporary files are always cleaned up on failure.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

let counter = 0;

function defaultNonce() {
  counter += 1;
  return `${process.pid}-${Date.now()}-${counter}-${randomBytes(4).toString('hex')}`;
}

// Writes `content` (string or Buffer) to `targetPath` atomically.
// Optional overrides (for failure injection in tests):
//   { writeFile, rename, unlink, stat, chmod, nonce }
function writeFileAtomicSync(targetPath, content, opts = {}) {
  const writeFile = opts.writeFile || fs.writeFileSync;
  const rename = opts.rename || fs.renameSync;
  const unlink = opts.unlink || fs.unlinkSync;
  const stat = opts.stat || fs.statSync;
  const chmod = opts.chmod || fs.chmodSync;
  const open = opts.open || fs.openSync;
  const close = opts.close || fs.closeSync;
  const fsync = opts.fsync || fs.fsyncSync;
  const nonce = opts.nonce || defaultNonce;

  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${nonce()}`);
  const data = typeof content === 'string' ? content : Buffer.from(content);

  try {
    writeFile(tmpPath, data);
    // Preserve the existing file mode where applicable: a replaced
    // authoritative document keeps its permissions.
    try {
      const existing = stat(targetPath);
      chmod(tmpPath, existing.mode);
    } catch (modeErr) {
      if (!modeErr || modeErr.code !== 'ENOENT') throw modeErr;
    }
    // Durability: the temp file must reach disk before rename publishes it.
    // A crash between write and fsync must not leave a renamed empty journal.
    const fileFd = open(tmpPath, 'r+');
    try {
      fsync(fileFd);
    } finally {
      close(fileFd);
    }
    rename(tmpPath, targetPath);
    fsyncDirectory(dir, open, close, fsync);
  } catch (err) {
    try {
      unlink(tmpPath);
    } catch (_) {
      // Best-effort cleanup: the temp file must not survive a failure.
    }
    throw err;
  }
  return targetPath;
}

// Directory fsync persists the rename itself. Some platforms reject it;
// the file fsync above is the mandatory half, so a directory failure
// must not turn a published document into a reported persistence error.
function fsyncDirectory(dir, open, close, fsync) {
  let dirFd;
  try {
    dirFd = open(dir, 'r');
    fsync(dirFd);
  } catch {
    // Best-effort. The renamed file content is already fsynced.
  } finally {
    if (dirFd !== undefined) {
      try { close(dirFd); } catch { /* already closed or unsupported */ }
    }
  }
}

module.exports = { writeFileAtomicSync };
