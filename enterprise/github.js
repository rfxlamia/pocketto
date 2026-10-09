'use strict';

// Enterprise-only `gh` transport seam (T7, Cycle 3).
//
// All GitHub IDs, `gh` invocations, body-file/JSON transport details, and
// remote ownership rules live here — Core never imports this module. The
// runner is always injectable (default: spawn `gh` with a timeout); tests
// and the adapter pass fakes. No live network is touched unless an
// explicit runner performs it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { classifyGhResult, boundOutcome, redactSecrets } = require('./retry');

const DEFAULT_TIMEOUT_MS = 30000;

function defaultRunner(args, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  try {
    const res = spawnSync('gh', args, { encoding: 'utf8', timeout: timeoutMs });
    return {
      exit: typeof res.status === 'number' ? res.status : 1,
      stdout: typeof res.stdout === 'string' ? res.stdout : '',
      stderr: typeof res.stderr === 'string' ? res.stderr : (res.error ? String(res.error.message || res.error) : ''),
      timedOut: res.error && (res.error.code === 'ETIMEDOUT' || /timed out/i.test(String(res.error.message || ''))) ? true : false,
    };
  } catch (err) {
    return { exit: 1, stdout: '', stderr: err && err.message ? err.message : String(err), timedOut: false };
  }
}

// Runs one `gh` invocation through the injected runner, enforces the
// timeout policy, parses JSON safely when requested, and classifies the
// result. Malformed JSON output is failure — never success.
function runGh(args, opts = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== 'string')) {
    throw new Error('GH_RUNNER_ARGS: gh args must be a non-empty string array');
  }
  const runner = opts.runner || defaultRunner;
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const expectJson = opts.expectJson === true;
  const attemptsMade = typeof opts.attemptsMade === 'number' ? opts.attemptsMade : 1;

  let raw;
  try {
    raw = runner(args.slice(), { timeoutMs });
  } catch (err) {
    raw = { exit: 1, stdout: '', stderr: err && err.message ? err.message : String(err), timedOut: false };
  }
  const result = {
    exit: typeof raw.exit === 'number' ? raw.exit : 1,
    stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
    stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    timedOut: raw.timedOut === true,
  };

  if (result.exit === 0 && expectJson) {
    let data;
    try {
      data = JSON.parse(result.stdout);
    } catch (_) {
      const classification = boundOutcome(classifyGhResult(result, { expectJson: true }), attemptsMade);
      return {
        ok: false,
        data: null,
        raw: { exit: result.exit, stdout: '', stderr: redactSecrets(result.stderr) },
        classification,
      };
    }
    return {
      ok: true,
      data,
      raw: { exit: result.exit, stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr), timedOut: result.timedOut },
      classification: { status: 'succeeded', error: null },
    };
  }

  if (result.exit === 0) {
    return {
      ok: true,
      data: result.stdout,
      raw: { exit: result.exit, stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr), timedOut: result.timedOut },
      classification: { status: 'succeeded', error: null },
    };
  }

  const classification = boundOutcome(classifyGhResult(result, { expectJson }), attemptsMade);
  return {
    ok: false,
    data: null,
    raw: { exit: result.exit, stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr) },
    classification,
  };
}

// Body-file transport: write a `gh --body-file` payload to a local temp
// file (avoids cross-shell quoting hazards per the create-pr transport
// convention). Returns the temp path for the caller to pass to `gh`.
function writeBodyFile(body, opts = {}) {
  const ownsDir = !opts.dir;
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-body-'));
  let complete = false;
  try {
    const contents = typeof body === 'string' ? body : String(body ?? '');
    for (let attempt = 0; attempt < 10; attempt++) {
      const suffix = crypto.randomBytes(8).toString('hex');
      const file = path.join(dir, `body-${Date.now()}-${process.pid}-${suffix}.md`);
      let fd;
      try {
        fd = fs.openSync(file, 'wx', 0o600);
        fs.writeFileSync(fd, contents, 'utf8');
        complete = true;
        return file;
      } catch (err) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* best-effort close */ }
          fd = undefined;
          try { fs.rmSync(file, { force: true }); } catch { /* best-effort cleanup */ }
        }
        if (err.code !== 'EEXIST' || attempt === 9) throw err;
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* already closed */ }
        }
      }
    }
    throw new Error('Could not allocate a unique request body file.');
  } finally {
    if (!complete && ownsDir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
    }
  }
}

// `gh api` has no `--body-file`. `-F body=@file` is its file transport:
// the body is read from disk and is not interpolated by a shell.
function bodyFileField(bodyFile) {
  return ['-F', `body=@${bodyFile}`];
}

module.exports = { runGh, writeBodyFile, bodyFileField, defaultRunner, DEFAULT_TIMEOUT_MS };
