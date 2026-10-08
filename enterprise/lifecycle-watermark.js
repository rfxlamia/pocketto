'use strict';

const { lifecycleEventProofFromMetadata } = require('./lifecycle-proof');

const LIFECYCLE_DELIVERY_SCHEMA = 1;
const LIFECYCLE_DELIVERY_FIELDS = ['schema', 'plan_id', 'last_applied_revision'];

function lifecycleDeliveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateLifecycleDelivery(metadata, planId) {
  const delivery = metadata.lifecycle_delivery;
  if (delivery === undefined) {
    return { schema: LIFECYCLE_DELIVERY_SCHEMA, plan_id: planId, last_applied_revision: 0 };
  }
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)
      || Object.keys(delivery).some((key) => !LIFECYCLE_DELIVERY_FIELDS.includes(key))
      || LIFECYCLE_DELIVERY_FIELDS.some((key) => !(key in delivery))
      || delivery.schema !== LIFECYCLE_DELIVERY_SCHEMA
      || delivery.plan_id !== planId
      || !Number.isInteger(delivery.last_applied_revision)
      || delivery.last_applied_revision < 0) {
    throw lifecycleDeliveryError('LIFECYCLE_DELIVERY_INVALID', 'Enterprise lifecycle delivery watermark is malformed or belongs to a different plan. Resolve metadata before retrying.');
  }
  return delivery;
}

function readLifecycleDelivery(specDir, planId, context, readMetaFor) {
  return validateLifecycleDelivery(readMetaFor(specDir, context), planId);
}

function recoverLifecycleDelivery(specDir, event, context, metaIO) {
  const metadata = metaIO.readMetaFor(specDir, context);
  const current = validateLifecycleDelivery(metadata, event.plan_id);
  if (event.revision > current.last_applied_revision + 1) return { proof: null };

  const proof = lifecycleEventProofFromMetadata(metadata, event);
  const delivery = event.delivery || {};
  if (!proof || delivery.proof_ref !== proof.proof_ref || delivery.proof_hash !== proof.proof_hash) {
    return { proof: null };
  }
  if (event.revision <= current.last_applied_revision) return { proof, delivery: current };
  if (event.revision !== current.last_applied_revision + 1) return { proof: null };

  const next = {
    schema: LIFECYCLE_DELIVERY_SCHEMA,
    plan_id: event.plan_id,
    last_applied_revision: event.revision,
  };
  metadata.lifecycle_delivery = next;
  try {
    metaIO.writeMetaFor(specDir, metadata, context);
  } catch (error) {
    return { proof, error };
  }
  return { proof, delivery: next };
}

function advanceLifecycleDelivery(specDir, planId, revision, context, metaIO) {
  const metadata = metaIO.readMetaFor(specDir, context);
  const current = validateLifecycleDelivery(metadata, planId);
  if (revision <= current.last_applied_revision) return current;
  if (revision !== current.last_applied_revision + 1) {
    throw lifecycleDeliveryError('REVISION_GAP', `Lifecycle revision ${revision} cannot advance the watermark from ${current.last_applied_revision}.`);
  }
  const delivery = {
    schema: LIFECYCLE_DELIVERY_SCHEMA,
    plan_id: planId,
    last_applied_revision: revision,
  };
  metadata.lifecycle_delivery = delivery;
  metaIO.writeMetaFor(specDir, metadata, context);
  return delivery;
}

module.exports = {
  LIFECYCLE_DELIVERY_SCHEMA,
  readLifecycleDelivery,
  recoverLifecycleDelivery,
  advanceLifecycleDelivery,
};
