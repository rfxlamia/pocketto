'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { serializeResponse } = require('./adapter');
const enterpriseMeta = require('./meta');
const { loadContext } = require('./phase-handler-context');

const METADATA_ERROR_CODES = {
  'spec-approved': {
    ENTERPRISE_META_MISSING: 'ISSUE_METADATA_MISSING',
    ENTERPRISE_META_PATH_INVALID: 'ISSUE_METADATA_PATH_INVALID',
  },
  'phase-complete': {
    ENTERPRISE_META_MISSING: 'PHASE_METADATA_MISSING',
    ENTERPRISE_META_PATH_INVALID: 'PHASE_METADATA_PATH_INVALID',
  },
  'plan-closed': {
    ENTERPRISE_META_MISSING: 'CLOSEOUT_METADATA_MISSING',
    ENTERPRISE_META_PATH_INVALID: 'CLOSEOUT_METADATA_PATH_INVALID',
  },
};

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function lifecycleDeliveryContext(projectRoot, planId) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)
      || typeof planId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(planId)) {
    throw new Error('invalid lifecycle delivery identity');
  }
  const registeredProjectRoot = path.resolve(projectRoot);
  const root = fs.realpathSync(registeredProjectRoot);
  const specDir = path.resolve(root, 'docs', 'pocket', 'spec', planId);
  const physicalSpecDir = fs.realpathSync(specDir);
  if (!fs.statSync(root).isDirectory() || !fs.statSync(physicalSpecDir).isDirectory()
      || physicalSpecDir !== specDir || physicalSpecDir === root || !isInside(root, physicalSpecDir)) {
    throw new Error('invalid lifecycle delivery metadata directory');
  }
  return { projectRoot: root, registeredProjectRoot, specDir: physicalSpecDir };
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

function retryableDeliveryStateFailure(event) {
  return {
    response: lifecycleDeliveryResponse(event, 'retryable', 'ADAPTER_LIFECYCLE_DELIVERY_INVALID', true,
      'Enterprise lifecycle delivery metadata could not be read because of a temporary I/O failure; retry delivery. No handler or GitHub call ran.'),
  };
}

function lifecycleContextFailure(event, error) {
  if (enterpriseMeta.isTransientIoError(error)) return retryableDeliveryStateFailure(event);
  return {
    response: lifecycleDeliveryResponse(event, 'terminal', 'STALE_ARTIFACT', false,
      'The selected lifecycle plan context is invalid or unsafe; verify the selected plan artifacts. No handler or GitHub call ran.'),
  };
}

function lifecycleMetadataFailure(event, error) {
  if (enterpriseMeta.isTransientIoError(error)) return retryableDeliveryStateFailure(event);
  const code = METADATA_ERROR_CODES[event.type]
    && METADATA_ERROR_CODES[event.type][error && error.code]
    ? METADATA_ERROR_CODES[event.type][error.code]
    : 'ADAPTER_LIFECYCLE_DELIVERY_INVALID';
  const message = code === 'ADAPTER_LIFECYCLE_DELIVERY_INVALID'
    ? 'Enterprise lifecycle delivery metadata is malformed or invalid; resolve it manually. No handler or GitHub call ran.'
    : 'Enterprise lifecycle metadata is missing or has an unsafe path; resolve it manually. No handler or GitHub call ran.';
  return {
    response: lifecycleDeliveryResponse(event, 'terminal', code, false, message),
  };
}

function readDeliveryState(projectRoot, event) {
  let context;
  try {
    context = lifecycleDeliveryContext(projectRoot, event.plan_id);
  } catch (error) {
    return lifecycleContextFailure(event, error);
  }

  try {
    const delivery = enterpriseMeta.readLifecycleDelivery(context.specDir, event.plan_id, context);
    return { context, delivery };
  } catch (error) {
    return lifecycleMetadataFailure(event, error);
  }
}

function revisionGapResponse(event, delivery) {
  const missingRevision = delivery.last_applied_revision + 1;
  return lifecycleDeliveryResponse(event, 'retryable', 'REVISION_GAP', true,
    `Plan ${event.plan_id} cannot apply lifecycle revision ${event.revision} before missing predecessor revision ${missingRevision}. Deliver revision ${missingRevision} for plan ${event.plan_id}, then retry revision ${event.revision}.`);
}

function prepareAlreadyAppliedEvent(event, context) {
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

function staleArtifactError() {
  const error = new Error('Committed lifecycle artifact is missing, unsafe, or no longer matches its SHA-256.');
  error.code = 'STALE_ARTIFACT';
  return error;
}

function validateCommittedArtifacts(event, selectedContext) {
  if (!Array.isArray(event.artifact_refs) || event.artifact_refs.length === 0) throw staleArtifactError();

  for (const ref of event.artifact_refs) {
    if (!ref || (ref.root !== 'spec' && ref.root !== 'plan')
        || typeof ref.path !== 'string' || ref.path.length === 0 || path.isAbsolute(ref.path)
        || ref.path.split(/[\\/]/).includes('..')) {
      throw staleArtifactError();
    }

    const selectedRoot = ref.root === 'spec' ? selectedContext.specDir : selectedContext.planDir;
    if (typeof selectedRoot !== 'string' || !path.isAbsolute(selectedRoot)) throw staleArtifactError();
    const root = fs.realpathSync(selectedRoot);
    if (root !== selectedRoot || !fs.statSync(root).isDirectory()) throw staleArtifactError();

    const candidate = path.resolve(root, ref.path);
    if (candidate === root || !isInside(root, candidate)) throw staleArtifactError();
    const physicalArtifact = fs.realpathSync(candidate);
    if (physicalArtifact === root || !isInside(root, physicalArtifact)) throw staleArtifactError();
    if (!fs.lstatSync(physicalArtifact).isFile()) throw staleArtifactError();

    const bytes = fs.readFileSync(physicalArtifact);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== ref.sha256) throw staleArtifactError();
  }
}

function selectedArtifactContext(event, context) {
  if (event.type === 'spec-approved') return { specDir: context.specDir };
  if (event.type === 'phase-complete' || event.type === 'plan-closed') {
    return loadContext(event, {
      projectRoot: context.registeredProjectRoot,
      specDir: context.specDir,
    });
  }
  throw staleArtifactError();
}

function lifecycleArtifactFailure(event, error) {
  const retryable = enterpriseMeta.isTransientIoError(error)
    || Boolean(error && error.status === 'retryable' && error.retryable === true);
  return {
    response: lifecycleDeliveryResponse(event, retryable ? 'retryable' : 'terminal',
      retryable ? 'ARTIFACT_READ_FAILED' : 'STALE_ARTIFACT', retryable,
      retryable
        ? 'A committed lifecycle artifact could not be validated because of a temporary I/O failure; retry delivery. No handler or GitHub call ran.'
        : 'A committed lifecycle artifact is missing, changed, or unsafe for the selected root. No handler or GitHub call ran.'),
  };
}

function recoverReconcilingEvent(event, context, delivery) {
  if (event.delivery.status !== 'reconciling'
      || event.revision !== delivery.last_applied_revision + 1) return null;

  try {
    const selectedContext = selectedArtifactContext(event, context);
    validateCommittedArtifacts(event, selectedContext);
  } catch (error) {
    return lifecycleArtifactFailure(event, error);
  }

  let recovery;
  try {
    recovery = enterpriseMeta.recoverLifecycleDelivery(context.specDir, event, context);
  } catch {
    return {
      response: lifecycleDeliveryResponse(event, 'retryable', 'ADAPTER_LIFECYCLE_PROOF_UNAVAILABLE', true,
        'The persisted proof for this reconciling lifecycle event could not be read; retry after metadata is available.'),
    };
  }
  if (!recovery || !recovery.proof) return null;
  if (recovery.error) {
    return {
      response: lifecycleDeliveryResponse(event, 'reconciling', 'LIFECYCLE_WATERMARK_WRITE_FAILED', true,
        WATERMARK_WRITE_FAILURE_MESSAGE, recovery.proof),
    };
  }
  return { response: lifecycleDeliverySuccess(event, recovery.proof) };
}

function prepareLifecycleDelivery(projectRoot, event) {
  const loaded = readDeliveryState(projectRoot, event);
  if (loaded.response) return loaded;
  const { context, delivery } = loaded;
  if (event.revision > delivery.last_applied_revision + 1) {
    return { response: revisionGapResponse(event, delivery) };
  }
  if (event.revision <= delivery.last_applied_revision) {
    return prepareAlreadyAppliedEvent(event, context);
  }
  const recovered = recoverReconcilingEvent(event, context, delivery);
  if (recovered) return recovered;
  return { event, state: { context, replay: false } };
}

function readDurableHandlerProof(event, response, state) {
  if (typeof response.proof_ref !== 'string' || typeof response.proof_hash !== 'string') {
    return {
      response: lifecycleDeliveryResponse(event, 'reconciling', 'ADAPTER_PROOF_NOT_DURABLE', true,
        'Enterprise handler reported success without an event-bound canonical proof; retry delivery after resolving proof persistence.'),
    };
  }

  let proof;
  try {
    proof = enterpriseMeta.lifecycleEventProof(state.context.specDir, event, state.context);
  } catch {
    return {
      response: lifecycleDeliveryResponse(event, 'reconciling', 'ADAPTER_PROOF_READ_FAILED', true,
        'Enterprise handler succeeded but its canonical proof could not be read; retry delivery to reconcile proof before mutation.', response),
    };
  }
  if (!proof || proof.proof_ref !== response.proof_ref || proof.proof_hash !== response.proof_hash) {
    return {
      response: lifecycleDeliveryResponse(event, 'reconciling', 'ADAPTER_PROOF_NOT_DURABLE', true,
        'Enterprise handler success does not match a durable event-bound canonical proof; retry delivery to reconcile proof before mutation.', response),
    };
  }
  return { proof };
}

function completeLifecycleDelivery(event, response, state) {
  if (!state || state.replay || response.status !== 'succeeded') return response;
  const persisted = readDurableHandlerProof(event, response, state);
  if (persisted.response) return persisted.response;

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
}

function createLifecycleDelivery(projectRoot) {
  return {
    prepare: (event) => prepareLifecycleDelivery(projectRoot, event),
    complete: completeLifecycleDelivery,
  };
}

module.exports = { createLifecycleDelivery };
