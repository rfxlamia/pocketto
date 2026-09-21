#!/usr/bin/env node
'use strict';

// Enterprise-owned CLI (T7, Cycle 1): `install` and `preflight` only.
// Keeps all adapter policy in Enterprise-only files; Core sees only the
// opaque registration record. Makes zero GitHub calls on every path.

const registration = require('./registration');

function usage() {
  return 'Usage: enterprise/cli.js install <project-root> --argv <executable> [--argv <arg> ...] [--json]\n'
    + '       enterprise/cli.js preflight <project-root> [--json]';
}

function parseArgvArgs(argv) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--argv') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: '--argv requires a value.' };
      }
      values.push(value);
      i += 1;
    }
  }
  return { values };
}

function main(argv) {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');

  if (command === 'install') {
    const positional = rest.find((a) => !a.startsWith('--'));
    if (!positional) {
      const message = `install requires a project root.\n${usage()}`;
      if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-install', data: null, error: { code: 'ENTERPRISE_INSTALL_FAILED', message } }));
      else console.error(message);
      process.exitCode = 1;
      return;
    }
    const parsed = parseArgvArgs(rest);
    if (parsed.error) {
      if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-install', data: null, error: { code: 'ENTERPRISE_INSTALL_FAILED', message: parsed.error } }));
      else console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    if (parsed.values.length === 0) {
      const message = 'install requires at least one --argv executable entry.';
      if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-install', data: null, error: { code: 'ENTERPRISE_INSTALL_FAILED', message } }));
      else console.error(message);
      process.exitCode = 1;
      return;
    }
    const res = registration.installRegistration(positional, { argv: parsed.values });
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
    const positional = rest.find((a) => !a.startsWith('--'));
    if (!positional) {
      const message = `preflight requires a project root.\n${usage()}`;
      if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-preflight', data: null, error: { code: 'ENTERPRISE_CORE_MISSING', message } }));
      else console.error(message);
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
        data: { path: res.path, record: res.record, core: res.core },
        error: null,
      }));
    } else {
      console.log(`Enterprise preflight passed: ${res.path}`);
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

module.exports = { main };
