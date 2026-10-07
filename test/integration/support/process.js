'use strict';

const { spawn, spawnSync } = require('node:child_process');

function runProcess(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  return {
    exit: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
  };
}

function startProcess(command, args, { cwd, env = process.env } = {}) {
  const child = spawn(command, args, { cwd, env, encoding: 'utf8' });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({
      exit: typeof status === 'number' ? status : 1,
      signal,
      stdout,
      stderr,
    }));
  });
  return { child, done };
}

async function waitForFile(filePath, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (require('node:fs').existsSync(filePath)) return;
    if (child.exitCode !== null) throw new Error(`worker exited before creating ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

module.exports = { runProcess, startProcess, waitForFile };
