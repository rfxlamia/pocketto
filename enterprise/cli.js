#!/usr/bin/env node
'use strict';

// Enterprise-owned CLI (T7, Cycle 1): `install` and `preflight` only.
// Keeps all adapter policy in Enterprise-only files; Core sees only the
// opaque registration record. Makes zero GitHub calls on every path.

const path = require('node:path');
const registration = require('./registration');

function usage() {
  return 'Usage: enterprise/cli.js install <project-root> [--argv <executable> [--argv <arg> ...]] [--json]\n'
    + '       enterprise/cli.js preflight <project-root> [--json]';
}

function defaultRunnerArgv(projectRoot) {
  return [process.execPath, path.resolve(__dirname, 'dispatch.js'), path.resolve(projectRoot)];
}

function parseCommandArgs(argv, allowRunnerArgv = false) {
  const positionals = [];
  const runnerArgs = [];
  const json = argv.includes('--json');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      // Already recorded before parsing so errors still honor a trailing --json.
    } else if (arg === '--argv' && allowRunnerArgv) {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: '--argv requires a value.', json, positionals, runnerArgs };
      }
      runnerArgs.push(value);
      i += 1;
    } else if (arg.startsWith('--')) {
      const valueSeparator = arg.search(/[=:]/);
      const optionName = valueSeparator === -1 ? arg : arg.slice(0, valueSeparator);
      const valueNote = valueSeparator === -1 ? '' : ' (inline value redacted)';
      return { error: `Unknown option: ${optionName}${valueNote}`, json, positionals, runnerArgs };
    } else if (arg.length > 0) {
      positionals.push(arg);
    } else {
      return { error: 'Project root cannot be empty.', json, positionals, runnerArgs };
    }
  }
  return { positionals, runnerArgs, json };
}

function main(argv) {
  const [command, ...rest] = argv;
  const json = argv.includes('--json');

  if (command === 'install') {
    const parsed = parseCommandArgs(rest, true);
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
    const res = registration.installRegistration(positional, { argv: runnerArgv });
    if (!res.ok) {
      if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-install', data: null, error: { code: res.code, message: res.message } }));
      else console.error(`${res.code}: ${res.message}`);
      process.exitCode = 1;
      return;
    }
    if (json) console.log(JSON.stringify({ ok: true, command: 'enterprise-install', data: { path: res.path, record: res.record }, error: null }));
    else console.log(`Enterprise adapter installed: ${res.path}`);
    return;
  }

  if (command === 'preflight') {
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
    return;
  }

  const message = usage();
  if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise', data: null, error: { code: 'ENTERPRISE_UNKNOWN_COMMAND', message } }));
  else console.error(message);
  process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main, defaultRunnerArgv };
