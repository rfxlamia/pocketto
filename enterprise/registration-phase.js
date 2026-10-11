'use strict';

// Enterprise-only optional registration fields: phase_branches and push_consent.
// Core never reads these. They are validated and resolved here so the neutral
// registration record in registration-record.js stays small. This is a leaf
// module: it must not require registration-record.js back.
const { detectMode } = require('../cli/lib/mode');

const OPTIONAL_REGISTRATION_FIELDS = ['phase_branches', 'push_consent'];
const PHASE_BRANCHES_MODES = ['stacked', 'none'];
// The only push consent a registration may carry. Consent never permits force.
const PUSH_CONSENT_PHASE_BRANCHES = Object.freeze({ scope: 'pocket-phase-branches', force: false });

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Copies the optional phase fields onto a record under construction.
function applyPhaseFields(record, { phaseBranches, pushConsent } = {}) {
  if (phaseBranches !== undefined) record.phase_branches = phaseBranches;
  if (pushConsent !== undefined) record.push_consent = isPlainObject(pushConsent) ? { ...pushConsent } : pushConsent;
  return record;
}

function isFixedPushConsent(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  return keys === 'force,scope'
    && value.scope === PUSH_CONSENT_PHASE_BRANCHES.scope
    && value.force === PUSH_CONSENT_PHASE_BRANCHES.force;
}

// Returns null when the optional phase fields are valid, otherwise { code, message }.
function validatePhaseFields(record) {
  if ('phase_branches' in record && !PHASE_BRANCHES_MODES.includes(record.phase_branches)) {
    return {
      code: 'ENTERPRISE_REGISTRATION_MALFORMED',
      message: 'Adapter registration phase_branches must be "stacked" or "none". Re-run enterprise install to repair it.',
    };
  }
  if ('push_consent' in record && !isFixedPushConsent(record.push_consent)) {
    return {
      code: 'ENTERPRISE_REGISTRATION_MALFORMED',
      message: 'Adapter registration push_consent must be the fixed phase-branches consent without force. Re-run enterprise install to repair it.',
    };
  }
  return null;
}

// main-local publishes to the base branch without phase branches, so it always
// wins over a requested stacked strategy, and the override is reported.
function resolvePhaseBranches(projectRoot, requested) {
  let mode;
  try {
    mode = detectMode(projectRoot);
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
  if (mode.branch_strategy === 'main-local') {
    const warning = requested === 'stacked'
      ? {
        code: 'PHASE_BRANCHES_MAIN_LOCAL',
        message: 'phase_branches stacked was overridden to none because Pocket Enterprise branch_strategy is main-local.',
      }
      : undefined;
    return { value: 'none', warning };
  }
  return { value: requested === undefined ? 'stacked' : requested, warning: undefined };
}

// Validates install flags and resolves the effective phase strategy.
// Returns { error: { code, message } } or { phaseBranches, pushConsent, warning }.
// Input is checked before the main-local override so an invalid value is never masked.
function resolvePhaseInstall(projectRoot, opts = {}) {
  if (opts.phaseBranches !== undefined && !PHASE_BRANCHES_MODES.includes(opts.phaseBranches)) {
    return {
      error: {
        code: 'ENTERPRISE_INSTALL_FAILED',
        message: `--phase-branches must be one of: ${PHASE_BRANCHES_MODES.join(', ')}.`,
      },
    };
  }
  if (opts.pushConsent !== undefined && opts.pushConsent !== 'phase-branches') {
    return {
      error: {
        code: 'ENTERPRISE_INSTALL_FAILED',
        message: '--push-consent must be one of: phase-branches.',
      },
    };
  }
  const resolved = resolvePhaseBranches(projectRoot, opts.phaseBranches);
  if (resolved.error) {
    return {
      error: {
        code: 'ENTERPRISE_INSTALL_FAILED',
        message: `Enterprise adapter install failed: ${resolved.error}`,
      },
    };
  }
  return {
    phaseBranches: resolved.value,
    // The CLI token `phase-branches` maps to the fixed consent object; nothing else is accepted.
    pushConsent: opts.pushConsent === 'phase-branches' ? PUSH_CONSENT_PHASE_BRANCHES : undefined,
    warning: resolved.warning,
  };
}

module.exports = {
  OPTIONAL_REGISTRATION_FIELDS,
  PHASE_BRANCHES_MODES,
  PUSH_CONSENT_PHASE_BRANCHES,
  applyPhaseFields,
  resolvePhaseInstall,
  validatePhaseFields,
};
