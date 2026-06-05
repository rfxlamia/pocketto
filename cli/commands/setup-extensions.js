'use strict';

// `pocketto-pi setup-extensions` — install the Pi extensions Pocket depends on
// by shelling out to `pi install`. Non-interactive: installs REQUIRED by
// default; `--all` / `--recommended` also install the recommended set.
// Idempotent (skips already-installed). The `pi` invocation goes through an
// injectable `runner` so the command is unit-testable without the real `pi`
// binary or the network.

const { spawnSync } = require('node:child_process');
const { CliError } = require('../lib/envelope');
const { REQUIRED, RECOMMENDED, readInstalledSet } = require('../lib/extensions');

// Single runner contract: runner(...piArgs) -> { status, stdout, stderr }.
// status === 0 is success; 127 signals `pi` is not on PATH. The default shells
// out to the real `pi`.
function defaultRunner(...args) {
  const res = spawnSync('pi', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) {
    return { status: 127, stdout: '', stderr: String(res.error.message || res.error) };
  }
  return { status: res.status == null ? 1 : res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function run({ env = process.env, runner = defaultRunner, all = false, recommended = false } = {}) {
  const targets = all || recommended ? [...REQUIRED, ...RECOMMENDED] : [...REQUIRED];

  // Precheck via the same runner so tests never hit a real `pi`.
  const probe = runner('--version');
  if (!probe || probe.status === 127) {
    throw new CliError(
      'PI_NOT_FOUND',
      '`pi` was not found on your PATH. Install Pi first (https://pi.dev), then re-run: npx pocketto-pi setup-extensions',
    );
  }

  const installedBefore = readInstalledSet(env);
  const installed = [];
  const skipped = [];
  const failed = [];

  for (const ext of targets) {
    if (installedBefore.has(ext.name)) {
      skipped.push(ext.name);
      continue;
    }
    const res = runner('install', `npm:${ext.name}`);
    if (res && res.status === 0) {
      installed.push(ext.name);
    } else {
      const stderr = res ? (res.stderr || '').trim() : '';
      failed.push({ name: ext.name, status: res ? res.status : null, stderr });
    }
  }

  // Informational re-read only. Success is the runner exit code above — `pi
  // install` may not reflect packages[] synchronously, so a still-missing
  // entry is a non-fatal note, never a failure.
  const unconfirmed = [];
  if (installed.length) {
    const installedAfter = readInstalledSet(env);
    for (const name of installed) {
      if (!installedAfter.has(name)) unconfirmed.push(name);
    }
  }

  const human = [];
  if (installed.length) human.push(`Installed: ${installed.join(', ')}`);
  if (skipped.length) human.push(`Already present (skipped): ${skipped.join(', ')}`);
  if (unconfirmed.length) {
    human.push(`Note: ${unconfirmed.join(', ')} installed but not yet reflected in settings.json — restart pi if it isn't picked up.`);
  }
  if (failed.length) {
    human.push(`Failed: ${failed.map((f) => f.name).join(', ')}`);
    for (const f of failed) {
      const first = f.stderr.split('\n')[0];
      if (first) human.push(`  ${f.name}: ${first}`);
    }
  }
  if (!human.length) human.push('Nothing to do — all target extensions are already installed.');

  return {
    command: 'setup-extensions',
    exit: failed.length ? 1 : 0,
    human,
    data: {
      ok: failed.length === 0,
      installed,
      skipped,
      unconfirmed,
      failed: failed.map((f) => f.name),
    },
  };
}

module.exports = { run, defaultRunner };
