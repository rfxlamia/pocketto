#!/usr/bin/env node
'use strict';

// Registered Enterprise event-file executable. Core supplies the explicit
// project root before the event file and the fixed JSON contract flags.
// This module is Enterprise-only; Core remains an opaque subprocess caller.

const fs = require('node:fs');
const path = require('node:path');
const { dispatchEvent, serializeResponse } = require('./adapter');
const { handleSpecApproved } = require('./issue-handler');
const { handlePhaseComplete } = require('./phase-handler');
const { handlePhaseClosed } = require('./phase-closed-handler');
const { handlePlanClosed } = require('./closure-handler');
const { loadContext } = require('./phase-handler-context');
const { defaultRunner } = require('./github');
const { createLifecycleDelivery } = require('./lifecycle-delivery');

const handlers = {
  'spec-approved': (event, options) => handleSpecApproved(event, options),
  'phase-complete': (event, options) => {
    loadContext(event, { projectRoot: options.projectRoot });
    return handlePhaseComplete(event, options);
  },
  'plan-closed': (event, options) => {
    const context = loadContext(event, { projectRoot: options.projectRoot });
    return handlePlanClosed(event, {
      ...options,
      projectRoot: context.root,
      specDir: context.specDir,
      planDir: context.planDir,
    });
  },
  'phase-closed': (event, options) => handlePhaseClosed(event, options),
};

function eventIdOf(event) {
  return event && typeof event.event_id === 'string' && event.event_id.length > 0
    ? event.event_id
    : 'unknown-event';
}

function makeFailure(eventId, code, message, retryable = true) {
  const id = typeof eventId === 'string' && eventId.length > 0 ? eventId : 'unknown-event';
  return serializeResponse({
    event_id: id,
    status: retryable ? 'retryable' : 'terminal',
    error: { code, retryable, message },
  }, id === 'unknown-event' ? undefined : id);
}

function readEventFile(eventFile) {
  try {
    return JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  } catch {
    return null;
  }
}

function parseInvocation(argv, runtimeRoot = process.cwd()) {
  const args = Array.isArray(argv) ? argv : [];
  const legacyInvocation = args.length === 5;
  const projectRoot = legacyInvocation ? args[0] : runtimeRoot;
  const eventFile = legacyInvocation ? args[1] : args[0];
  const flagOffset = legacyInvocation ? 2 : 1;
  const event = typeof eventFile === 'string' && path.isAbsolute(eventFile)
    ? readEventFile(eventFile)
    : null;
  const eventId = eventIdOf(event);

  if ((args.length !== 4 && !legacyInvocation)
      || typeof projectRoot !== 'string'
      || !path.isAbsolute(projectRoot)
      || typeof eventFile !== 'string'
      || !path.isAbsolute(eventFile)
      || args[flagOffset] !== '--json'
      || args[flagOffset + 1] !== '--contract'
      || args[flagOffset + 2] !== '3') {
    return { event, eventId, error: makeFailure(eventId, 'ADAPTER_ARGUMENTS_INVALID',
      'Expected <event-file> --json --contract 3 from an absolute working directory, or legacy <project-root> <event-file> --json --contract 3; no handler or GitHub call ran.') };
  }
  if (event === null) {
    return { event: null, eventId, error: makeFailure(eventId, 'ADAPTER_EVENT_FILE_INVALID',
      'Lifecycle event file is unreadable or malformed; no handler or GitHub call ran.') };
  }
  return { projectRoot, event, eventId, error: null };
}

function run(argv = process.argv.slice(2)) {
  const invocation = parseInvocation(argv);
  let response = invocation.error;
  if (!response) {
    try {
      response = dispatchEvent(invocation.event, {
        projectRoot: invocation.projectRoot,
        handlers,
        ghRunner: defaultRunner,
        coreContract: 3,
        lifecycleDelivery: createLifecycleDelivery(invocation.projectRoot),
      });
    } catch {
      response = makeFailure(invocation.eventId, 'ADAPTER_DISPATCH_FAILED',
        'Enterprise event dispatch failed before a bounded response was produced.');
    }
  }
  // Core expects exactly one raw bounded adapter response object on stdout.
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return response;
}

if (require.main === module) run();

module.exports = { handlers, parseInvocation, run };
