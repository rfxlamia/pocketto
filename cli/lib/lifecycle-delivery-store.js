'use strict';

// Delivery validation stays pure; this coordinator owns mutation and persistence.
function createDeliveryWriter({
  readLifecycleDoc,
  lifecyclePathFor,
  serializeDoc,
  writeFileAtomicSync,
  fail,
  validateDeliveryPatch,
}) {
  return function updateEventDeliveryUnlocked(specDir, eventId, patch) {
    const doc = readLifecycleDoc(specDir);
    if (!doc) return fail('LIFECYCLE_NOT_FOUND', 'lifecycle document does not exist');
    const event = doc.events.find((candidate) => candidate.event_id === eventId);
    if (!event) return fail('LIFECYCLE_EVENT_NOT_FOUND', `event not found: ${eventId}`);
    const validation = validateDeliveryPatch(event, patch);
    if (!validation.ok) return validation;
    event.delivery = validation.delivery;

    try {
      writeFileAtomicSync(lifecyclePathFor(specDir), serializeDoc(doc));
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      return fail('LIFECYCLE_PERSISTENCE', `lifecycle persistence failed: ${detail}`);
    }
    return { ok: true, event };
  };
}

module.exports = { createDeliveryWriter };
