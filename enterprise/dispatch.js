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
const { handlePlanClosed } = require('./closure-handler');
const { loadContext } = require('./phase-handler-context');
const { defaultRunner } = require('./github');

const handlers = {
  'spec-approved': (event, options) => handleSpecApproved(event, options),
  'phase-complete': (event, options) => handlePhaseComplete(event, options),
  'plan-closed': (event, options) => {
    const context = loadContext(event, { projectRoot: options.projectRoot });
    return handlePlanClosed(event, {
      ...options,
      projectRoot: context.root,
      specDir: context.specDir,
      planDir: context.planDir,
    });
  },
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

function parseInvocation(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const projectRoot = args[0];
  const eventFile = args[1];
  const event = typeof eventFile === 'string' && path.isAbsolute(eventFile)
    ? readEventFile(eventFile)
    : null;
  const eventId = eventIdOf(event);

  if (args.length !== 5
      || typeof projectRoot !== 'string'
      || !path.isAbsolute(projectRoot)
      || typeof eventFile !== 'string'
      || !path.isAbsolute(eventFile)
      || args[2] !== '--json'
      || args[3] !== '--contract'
      || args[4] !== '3') {
    return { event, eventId, error: makeFailure(eventId, 'ADAPTER_ARGUMENTS_INVALID',
      'Expected <project-root> <event-file> --json --contract 3; no handler or GitHub call ran.') };
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
