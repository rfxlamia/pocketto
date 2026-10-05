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
const enterpriseMeta = require('./meta');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function lifecycleDeliveryContext(projectRoot, planId) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)
      || typeof planId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(planId)) {
    throw new Error('invalid lifecycle delivery identity');
  }
  const root = fs.realpathSync(projectRoot);
  const specDir = path.resolve(root, 'docs', 'pocket', 'spec', planId);
  const physicalSpecDir = fs.realpathSync(specDir);
  if (!fs.statSync(root).isDirectory() || !fs.statSync(physicalSpecDir).isDirectory()
      || physicalSpecDir !== specDir || physicalSpecDir === root || !isInside(root, physicalSpecDir)) {
    throw new Error('invalid lifecycle delivery metadata directory');
  }
  return { projectRoot: root, specDir: physicalSpecDir };
}

const WATERMARK_WRITE_FAILURE_MESSAGE = 'Canonical event proof is durable but the Enterprise lifecycle watermark could not be saved. Retry delivery; the existing proof will be reconciled before remote mutation.';

function lifecycleDeliverySuccess(event, proof) {
  return serializeResponse({
    event_id: event.event_id,
    status: 'succeeded',
    proof_ref: proof.proof_ref,
    proof_hash: proof.proof_hash,
  }, event.event_id);
}

function lifecycleDeliveryResponse(event, status, code, retryable, message, proof) {
  const response = {
    event_id: event.event_id,
    status,
    error: { code, retryable, message },
  };
  if (proof) {
    response.proof_ref = proof.proof_ref;
    response.proof_hash = proof.proof_hash;
  }
  return serializeResponse(response, event.event_id);
}

function createLifecycleDelivery(projectRoot) {
  return {
    prepare(event) {
      let context;
      let delivery;
      try {
        context = lifecycleDeliveryContext(projectRoot, event.plan_id);
        delivery = enterpriseMeta.readLifecycleDelivery(context.specDir, event.plan_id, context);
      } catch {
        return {
          response: lifecycleDeliveryResponse(event, 'retryable', 'ADAPTER_LIFECYCLE_DELIVERY_INVALID', true,
            'Enterprise lifecycle delivery metadata could not be read or validated safely; no handler or GitHub call ran.'),
        };
      }

      if (event.revision > delivery.last_applied_revision + 1) {
        const missingRevision = delivery.last_applied_revision + 1;
        return {
          response: lifecycleDeliveryResponse(event, 'retryable', 'REVISION_GAP', true,
            `Plan ${event.plan_id} cannot apply lifecycle revision ${event.revision} before missing predecessor revision ${missingRevision}. Deliver revision ${missingRevision} for plan ${event.plan_id}, then retry revision ${event.revision}.`),
        };
      }

      if (event.revision <= delivery.last_applied_revision) {
        let proof;
        try {
          proof = enterpriseMeta.lifecycleEventProof(context.specDir, event, context);
        } catch {
          return {
            response: lifecycleDeliveryResponse(event, 'retryable', 'ADAPTER_LIFECYCLE_PROOF_UNAVAILABLE', true,
              'The persisted proof for this applied lifecycle revision could not be read; retry after metadata is available.'),
          };
        }
        if (!proof) {
          return {
            response: lifecycleDeliveryResponse(event, 'terminal', 'ADAPTER_LIFECYCLE_PROOF_MISSING', false,
              `Lifecycle revision ${event.revision} for plan ${event.plan_id} is already applied but has no matching persisted event proof; resolve Enterprise metadata manually.`),
          };
        }
        return {
          event: {
            ...event,
            delivery: {
              ...event.delivery,
              status: 'succeeded',
              proof_ref: proof.proof_ref,
              proof_hash: proof.proof_hash,
            },
          },
          state: { context, replay: true },
        };
      }

      if (event.delivery.status === 'reconciling'
          && event.revision === delivery.last_applied_revision + 1) {
        let recovery;
        try {
          recovery = enterpriseMeta.recoverLifecycleDelivery(context.specDir, event, context);
        } catch {
          return {
            response: lifecycleDeliveryResponse(event, 'retryable', 'ADAPTER_LIFECYCLE_PROOF_UNAVAILABLE', true,
              'The persisted proof for this reconciling lifecycle event could not be read; retry after metadata is available.'),
          };
        }
        if (recovery && recovery.proof) {
          if (recovery.error) {
            return {
              response: lifecycleDeliveryResponse(event, 'reconciling', 'LIFECYCLE_WATERMARK_WRITE_FAILED', true,
                WATERMARK_WRITE_FAILURE_MESSAGE, recovery.proof),
            };
          }
          return { response: lifecycleDeliverySuccess(event, recovery.proof) };
        }
      }

      return { event, state: { context, replay: false } };
    },

    complete(event, response, state) {
      if (!state || state.replay || response.status !== 'succeeded') return response;
      if (typeof response.proof_ref !== 'string' || typeof response.proof_hash !== 'string') {
        return lifecycleDeliveryResponse(event, 'reconciling', 'ADAPTER_PROOF_NOT_DURABLE', true,
          'Enterprise handler reported success without an event-bound canonical proof; retry delivery after resolving proof persistence.');
      }

      let proof;
      try {
        proof = enterpriseMeta.lifecycleEventProof(state.context.specDir, event, state.context);
      } catch {
        return lifecycleDeliveryResponse(event, 'reconciling', 'ADAPTER_PROOF_READ_FAILED', true,
          'Enterprise handler succeeded but its canonical proof could not be read; retry delivery to reconcile proof before mutation.', response);
      }
      if (!proof || proof.proof_ref !== response.proof_ref || proof.proof_hash !== response.proof_hash) {
        return lifecycleDeliveryResponse(event, 'reconciling', 'ADAPTER_PROOF_NOT_DURABLE', true,
          'Enterprise handler success does not match a durable event-bound canonical proof; retry delivery to reconcile proof before mutation.', response);
      }

      try {
        enterpriseMeta.advanceLifecycleDelivery(
          state.context.specDir,
          event.plan_id,
          event.revision,
          state.context
        );
      } catch {
        return lifecycleDeliveryResponse(event, 'reconciling', 'LIFECYCLE_WATERMARK_WRITE_FAILED', true,
          WATERMARK_WRITE_FAILURE_MESSAGE, response);
      }
      return response;
    },
  };
}

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
