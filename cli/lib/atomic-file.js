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
    rename(tmpPath, targetPath);
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

module.exports = { writeFileAtomicSync };
