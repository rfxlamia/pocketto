#!/usr/bin/env node
'use strict';

// Enterprise-owned CLI (T7, Cycle 1): `install` and `preflight` only.
// Keeps all adapter policy in Enterprise-only files; Core sees only the
// opaque registration record. Makes zero GitHub calls on every path.

const fs = require('node:fs');
const path = require('node:path');
const registration = require('./registration');
const enterpriseMeta = require('./meta');

// Install flags that take exactly one value. Validation of the value itself
// lives in registration-record.js so the CLI and direct callers share it.
const INSTALL_VALUE_FLAGS = ['--phase-branches', '--push-consent'];

function usage() {
  return 'Usage: enterprise/cli.js install <project-root> [--argv <executable> [--argv <arg> ...]] [--phase-branches <stacked|none>] [--push-consent phase-branches] [--json]\n'
    + '       enterprise/cli.js consent-push <project-root> <spec_dir> <phase_key> --sha <40-hex> [--json]\n'
    + '       enterprise/cli.js preflight <project-root> [--json]';
}

function defaultRunnerArgv(projectRoot) {
  return [process.execPath, path.resolve(__dirname, 'dispatch.js'), path.resolve(projectRoot)];
}

function parseCommandArgs(argv, { allowRunnerArgv = false, valueFlags = [] } = {}) {
  const positionals = [];
  const runnerArgs = [];
  const values = {};
  const json = argv.includes('--json');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      // Already recorded before parsing so errors still honor a trailing --json.
    } else if (arg === '--argv' && allowRunnerArgv) {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: '--argv requires a value.', json, positionals, runnerArgs, values };
      }
      runnerArgs.push(value);
      i += 1;
    } else if (valueFlags.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: `${arg} requires a value.`, json, positionals, runnerArgs, values };
      }
      values[arg] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      const valueSeparator = arg.search(/[=:]/);
      const optionName = valueSeparator === -1 ? arg : arg.slice(0, valueSeparator);
      const valueNote = valueSeparator === -1 ? '' : ' (inline value redacted)';
      return { error: `Unknown option: ${optionName}${valueNote}`, json, positionals, runnerArgs, values };
    } else if (arg.length > 0) {
      positionals.push(arg);
    } else {
      return { error: 'Project root cannot be empty.', json, positionals, runnerArgs, values };
    }
  }
  return { positionals, runnerArgs, values, json };
}

function runInstall(rest) {
  const parsed = parseCommandArgs(rest, { allowRunnerArgv: true, valueFlags: INSTALL_VALUE_FLAGS });
  const json = parsed.json;
  const positional = parsed.positionals[0];
  if (parsed.error || parsed.positionals.length !== 1) {
    const reason = parsed.error || (positional ? 'install accepts exactly one project root.' : 'install requires a project root.');
    const errorMessage = `${reason}\n${usage()}`;
    if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-install', data: null, error: { code: 'ENTERPRISE_INSTALL_FAILED', message: errorMessage } }));
    else console.error(errorMessage);
    process.exitCode = 1;
    return;
  }
  const runnerArgv = parsed.runnerArgs.length > 0
    ? parsed.runnerArgs
    : defaultRunnerArgv(positional);
  const res = registration.installRegistration(positional, {
    argv: runnerArgv,
    phaseBranches: parsed.values['--phase-branches'],
    pushConsent: parsed.values['--push-consent'],
  });
  if (!res.ok) {
    if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-install', data: null, error: { code: res.code, message: res.message } }));
    else console.error(`${res.code}: ${res.message}`);
    process.exitCode = 1;
    return;
  }
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      command: 'enterprise-install',
      data: { path: res.path, record: res.record, ...(res.warning ? { warning: res.warning } : {}) },
      error: null,
    }));
  } else {
    console.log(`Enterprise adapter installed: ${res.path}`);
    if (res.warning) console.warn(`${res.warning.code}: ${res.warning.message}`);
  }
}

function runPreflight(rest) {
  const parsed = parseCommandArgs(rest);
  const json = parsed.json;
  const positional = parsed.positionals[0];
  if (parsed.error || parsed.positionals.length !== 1) {
    const reason = parsed.error || (positional ? 'preflight accepts exactly one project root.' : 'preflight requires a project root.');
    const errorMessage = `${reason}\n${usage()}`;
    if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-preflight', data: null, error: { code: 'ENTERPRISE_CORE_MISSING', message: errorMessage } }));
    else console.error(errorMessage);
    process.exitCode = 1;
    return;
  }
  const res = registration.preflight(positional);
  if (!res.ok) {
    if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-preflight', data: null, error: { code: res.code, message: res.message } }));
    else console.error(`${res.code}: ${res.message}`);
    process.exitCode = 1;
    return;
  }
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      command: 'enterprise-preflight',
      data: {
        path: res.path,
        record: res.record,
        core: res.core,
        ...(res.warning ? { warning: res.warning } : {}),
      },
      error: null,
    }));
  } else {
    console.log(`Enterprise preflight passed: ${res.path}`);
    if (res.warning) console.warn(`${res.warning.code}: ${res.warning.message}`);
  }
}

function runConsentPush(rest) {
  const parsed = parseCommandArgs(rest, { valueFlags: ['--sha'] });
  const json = parsed.json;
  const [projectRootArg, specDirArg, phaseKey] = parsed.positionals;
  const sha = parsed.values['--sha'];
  let reason = parsed.error;
  if (!reason && parsed.positionals.length !== 3) reason = 'consent-push requires <project-root> <spec_dir> <phase_key>.';
  if (!reason && sha === undefined) reason = '--sha <40-hex> is required.';
  if (reason) {
    const message = `${reason}\n${usage()}`;
    if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-consent-push', data: null, error: { code: 'ENTERPRISE_CONSENT_INVALID', message } }));
    else console.error(message);
    process.exitCode = 1;
    return;
  }
  let approval;
  try {
    // Both paths are resolved physically; the metadata seam rejects unresolved or escaping paths.
    const projectRoot = fs.realpathSync(path.resolve(projectRootArg));
    const specDir = fs.realpathSync(path.resolve(specDirArg));
    approval = enterpriseMeta.setPushApproval(specDir, phaseKey, { sha }, { projectRoot, specDir });
  } catch (err) {
    const code = err && typeof err.code === 'string' && err.code.startsWith('ENTERPRISE_') ? err.code : 'ENTERPRISE_META_PATH_INVALID';
    const message = err && typeof err.message === 'string' && err.code === code ? err.message : 'Metadata path must resolve to a regular file inside the selected plan spec directory.';
    if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-consent-push', data: null, error: { code, message } }));
    else console.error(`${code}: ${message}`);
    process.exitCode = 1;
    return;
  }
  if (json) console.log(JSON.stringify({ ok: true, command: 'enterprise-consent-push', data: { phase: phaseKey, push_approval: approval }, error: null }));
  else console.log(`Recorded push approval for ${phaseKey} at ${approval.sha}`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'install') return runInstall(rest);
  if (command === 'preflight') return runPreflight(rest);
  if (command === 'consent-push') return runConsentPush(rest);

  const json = argv.includes('--json');
  const message = usage();
  if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise', data: null, error: { code: 'ENTERPRISE_UNKNOWN_COMMAND', message } }));
  else console.error(message);
  process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main, defaultRunnerArgv };
