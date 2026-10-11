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
    + '       enterprise/cli.js publish-phase <project-root> <spec_dir> <phase_key> [--json]\n'
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

function publishPhaseFailure(json, code, message) {
  if (json) console.log(JSON.stringify({ ok: false, command: 'enterprise-publish-phase', data: null, error: { code, message } }));
  else console.error(`${code}: ${message}`);
  process.exitCode = 1;
}

// Manual repair entry point: the same publisher as the phase-closed handler, with the same
// consent rules. It never forces, rebases, or writes lifecycle events.
function publishStackedPhase(projectRootArg, specDirArg, phaseKey) {
  const { loadContext } = require('./phase-handler-context');
  const { readPhaseEvidence } = require('./phase-handler-evidence');
  const { PhaseHandlerError } = require('./phase-handler-errors');
  const { publishPhase } = require('./phase-stack');
  const closed = require('./phase-closed-handler');
  const projectRoot = fs.realpathSync(path.resolve(projectRootArg));
  const preflight = registration.preflight(projectRoot);
  if (!preflight.ok) throw new PhaseHandlerError(preflight.code, preflight.message);
  const specDir = fs.realpathSync(path.resolve(specDirArg));
  const planId = path.basename(specDir);
  const context = loadContext({ plan_id: planId }, { projectRoot, specDir });
  if (!context.stacked) {
    throw new PhaseHandlerError('PHASE_CLOSED_NOT_STACKED', 'publish-phase applies only to stacked plans; no phase PR was published.');
  }
  const events = Array.isArray(context.lifecycle.events) ? context.lifecycle.events : [];
  const event = events.find((candidate) => candidate.type === 'phase-closed' && closed.phaseKeyOf(candidate) === phaseKey);
  if (!event) {
    throw new PhaseHandlerError('PHASE_CLOSED_EVENT_REQUIRED', `No phase-closed event exists for ${phaseKey}; run log handoff first.`);
  }
  // Reading the evidence verifies every artifact ref (snapshot included) against its recorded hash.
  const phase = closed.phaseFor(context, readPhaseEvidence(event, context));
  const published = publishPhase({
    projectRoot: context.root,
    specDir: context.specDir,
    planId,
    phase,
    closeoutSnapshot: closed.readCloseoutSnapshot(event, context),
    registration: preflight.record,
    options: {},
  });
  return {
    phase_key: phase.key,
    pr_number: published.pr.number,
    pr_url: published.pr.url,
    created: published.created,
    notices: [published.notice],
  };
}

function runPublishPhase(rest) {
  const parsed = parseCommandArgs(rest);
  const json = parsed.json;
  const [projectRoot, specDir, phaseKey] = parsed.positionals;
  let reason = parsed.error;
  if (!reason && parsed.positionals.length !== 3) reason = 'publish-phase requires <project-root> <spec_dir> <phase_key>.';
  if (!reason && !/^phase-[1-9]\d*$/.test(phaseKey)) reason = 'phase_key must look like phase-1.';
  if (reason) return publishPhaseFailure(json, 'ENTERPRISE_PUBLISH_INVALID', `${reason}\n${usage()}`);
  let data;
  try {
    data = publishStackedPhase(projectRoot, specDir, phaseKey);
  } catch (err) {
    const code = err && typeof err.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(err.code) ? err.code : 'PUBLISH_PHASE_FAILED';
    return publishPhaseFailure(json, code, err && err.message ? err.message : String(err));
  }
  if (json) console.log(JSON.stringify({ ok: true, command: 'enterprise-publish-phase', data, error: null }));
  else console.log(`${data.created ? 'Created' : 'Reused'} PR #${data.pr_number} for ${data.phase_key}: ${data.pr_url}`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'install') return runInstall(rest);
  if (command === 'preflight') return runPreflight(rest);
  if (command === 'consent-push') return runConsentPush(rest);
  if (command === 'publish-phase') return runPublishPhase(rest);

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
