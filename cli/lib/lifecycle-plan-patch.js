'use strict';

// planPatch validation and merge (T2). Branch identity lives in `plan`, never
// in event fields. Only `phase_branches` and per-phase `{ branch, base_branch }`
// entries are accepted; anything else is rejected before any document mutation.

const PLAN_PATCH_FIELDS = ['phase_branches', 'phases'];
const PHASE_ENTRY_FIELDS = ['branch', 'base_branch'];
const PHASE_KEY_PATTERN = /^phase-\d+$/;

function fail(code, message) {
  return { ok: false, code, message };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePlanPatch(patch) {
  const bad = (message) => fail('LIFECYCLE_BAD_PLAN_PATCH', `invalid planPatch: ${message}`);
  if (!isPlainObject(patch)) return bad('must be an object');
  const keys = Object.keys(patch);
  if (keys.length === 0) return bad('must not be empty');
  for (const key of keys) {
    if (!PLAN_PATCH_FIELDS.includes(key)) return bad(`unsupported field ${key}`);
  }
  if ('phase_branches' in patch && !isPlainObject(patch.phase_branches)) {
    return bad('phase_branches must be an object');
  }
  if ('phases' in patch) {
    if (!isPlainObject(patch.phases)) return bad('phases must be an object');
    for (const [phaseKey, entry] of Object.entries(patch.phases)) {
      if (!PHASE_KEY_PATTERN.test(phaseKey)) return bad(`phase key must match phase-N: ${phaseKey}`);
      if (!isPlainObject(entry)) return bad(`${phaseKey} must be an object`);
      for (const field of Object.keys(entry)) {
        if (!PHASE_ENTRY_FIELDS.includes(field)) return bad(`${phaseKey} has unsupported field ${field}`);
      }
      for (const field of PHASE_ENTRY_FIELDS) {
        if (typeof entry[field] !== 'string' || entry[field].length === 0) {
          return bad(`${phaseKey}.${field} must be a non-empty string`);
        }
      }
    }
  }
  return { ok: true, code: null, message: null };
}

// Merges a validated planPatch into `plan`. Existing unrelated fields and
// other phase entries are preserved; a patched phase keeps any fields the
// patch does not name.
function applyPlanPatch(plan, patch) {
  if ('phase_branches' in patch) {
    plan.phase_branches = { ...(plan.phase_branches || {}), ...patch.phase_branches };
  }
  if ('phases' in patch) {
    plan.phases = { ...(plan.phases || {}) };
    for (const [phaseKey, entry] of Object.entries(patch.phases)) {
      plan.phases[phaseKey] = { ...(plan.phases[phaseKey] || {}), ...entry };
    }
  }
}

module.exports = {
  validatePlanPatch,
  applyPlanPatch,
};
