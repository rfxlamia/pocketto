'use strict';

// Display-only ignored-artifact notices for phase-closed and plan-closed outcomes (T14). Shared by the
// phase-closed handler, the plan-closed wrapper, and lifecycle delivery. This module must not require
// those modules: the dependency runs one way, so no require cycle can form.

const fs = require('node:fs');
const path = require('node:path');
const { ADAPTER_NOTICE_MAX_COUNT, ADAPTER_NOTICE_MAX_MESSAGE_LENGTH } = require('../cli/lib/lifecycle-contract');
const { pocketArtifactProbePaths, ignoredArtifactWarning } = require('../cli/lib/artifact-ignore');
const { redactSecrets } = require('./retry');
const { PhaseHandlerError } = require('./phase-handler-errors');
const { loadContext } = require('./phase-handler-context');

function phaseKeyOf(event) {
  const ref = event.artifact_refs.find((artifact) => artifact.root === 'plan' && artifact.kind === 'phase-evidence');
  const match = ref && typeof ref.path === 'string' ? /phase[-_](\d+)/i.exec(ref.path) : null;
  if (!match) throw new PhaseHandlerError('PHASE_IDENTITY_UNPROVEN', 'Cannot derive phase identity from the phase-evidence artifact.');
  return `phase-${Number(match[1])}`;
}

// Replay compares only the locally stored proof. No artifact is re-read and no gh call runs.
// Display-only ignored-artifact notice. The message is the consequence and the fix, then as many
// repo-relative paths as fit, then "…and N more". It must pass the Core notice bound both as built
// and after adapter redaction; serializeNotices drops a notice that fails either check.
function ignoredArtifactNotice(warning, root) {
  const paths = [...new Set(warning.paths.map((p) => path.relative(root, p).split(path.sep).join('/')))];
  const head = `${warning.consequence} Fix: git add -f each listed path, or remove its rule from .gitignore. `
    + `Pocket never edits .gitignore. Ignored: `;
  const fits = (message) => message.length <= ADAPTER_NOTICE_MAX_MESSAGE_LENGTH
    && redactSecrets(message).length <= ADAPTER_NOTICE_MAX_MESSAGE_LENGTH;
  for (let shown = paths.length; shown >= 0; shown -= 1) {
    const remaining = paths.length - shown;
    const list = paths.slice(0, shown).join(', ');
    const more = remaining === 0 ? '' : `…and ${remaining} more`;
    const tail = shown === 0 ? more : (remaining === 0 ? list : `${list}, ${more}`);
    const message = `${head}${tail}`;
    if (fits(message)) return { code: 'POCKET_ARTIFACTS_IGNORED', message };
  }
  return { code: 'POCKET_ARTIFACTS_IGNORED', message: `Ignored Pocket artifacts: …and ${paths.length} more` };
}

// Probes the artifacts of the given phase orders from already-resolved directories.
// Returns null when nothing is ignored or the directories cannot be resolved; never throws.
function ignoredNoticeFor({ root, planDir, specDir, phaseOrders }) {
  try {
    const physicalRoot = fs.realpathSync(root);
    const physicalPlanDir = fs.realpathSync(planDir);
    const physicalSpecDir = fs.realpathSync(specDir);
    // Each phase repeats the plan-level and spec-level paths, so the probe list is deduplicated.
    const probes = [...new Set(phaseOrders.flatMap((phaseOrder) => pocketArtifactProbePaths({
      planDir: physicalPlanDir,
      specDir: physicalSpecDir,
      phaseOrder,
    })))];
    const warning = ignoredArtifactWarning(physicalRoot, probes, { audience: 'enterprise' });
    return warning ? ignoredArtifactNotice(warning, physicalRoot) : null;
  } catch {
    return null;
  }
}

// Appends the notice after the existing notices, keeping status and every other field unchanged.
function withIgnoredArtifactNotice(response, notice) {
  if (!notice || !response) return response;
  const existing = Array.isArray(response.notices) ? response.notices : [];
  if (existing.length >= ADAPTER_NOTICE_MAX_COUNT) return response;
  return { ...response, notices: [...existing, notice] };
}

// Phase orders a plan closure covers: every phase in log.json, or phase 1 when log.json cannot be read.
function planPhaseOrders(planDir) {
  try {
    const log = JSON.parse(fs.readFileSync(path.join(planDir, 'log.json'), 'utf8'));
    const count = log && Array.isArray(log.phases) ? log.phases.length : 0;
    return count > 0 ? Array.from({ length: count }, (_, index) => index + 1) : [1];
  } catch {
    return [1];
  }
}

// Notice for a phase-closed or plan-closed event from directories the caller has resolved.
// Returns null for any other event type, when nothing is ignored, or when the directories do not resolve.
function ignoredNoticeForEvent(event, { projectRoot, planDir, specDir }) {
  try {
    if (!event) return null;
    let phaseOrders;
    if (event.type === 'phase-closed') phaseOrders = [Number(phaseKeyOf(event).slice('phase-'.length))];
    else if (event.type === 'plan-closed') phaseOrders = planPhaseOrders(planDir);
    else return null;
    return ignoredNoticeFor({ root: projectRoot, planDir, specDir, phaseOrders });
  } catch {
    return null;
  }
}

// Notice for a prepare-stage response of a phase-closed or plan-closed event. The caller passes the
// delivery context resolver, so this module never requires lifecycle-delivery. A response produced
// before the plan directory resolves gets none.
function prepareNoticeFor(projectRoot, event, resolveDeliveryContext) {
  if (!event || (event.type !== 'phase-closed' && event.type !== 'plan-closed')) return null;
  try {
    const context = resolveDeliveryContext(projectRoot, event.plan_id);
    const loaded = loadContext(event, { projectRoot: context.registeredProjectRoot, specDir: context.specDir });
    return ignoredNoticeForEvent(event, { projectRoot: loaded.root, planDir: loaded.planDir, specDir: loaded.specDir });
  } catch {
    return null;
  }
}

// Attaches the prepare-stage notice to a prepared result when that result carries a response.
function withPrepareNotice(prepared, projectRoot, event, resolveDeliveryContext) {
  if (!prepared.response) return prepared;
  return { ...prepared, response: withIgnoredArtifactNotice(prepared.response, prepareNoticeFor(projectRoot, event, resolveDeliveryContext)) };
}

// Rewritten completion responses are built fresh and would drop the handler's notices. Carry them over.
function carryHandlerNotices(completed, handlerResponse) {
  const notices = Array.isArray(handlerResponse.notices) ? handlerResponse.notices : [];
  if (completed === handlerResponse || notices.length === 0 || Array.isArray(completed.notices)) return completed;
  return { ...completed, notices };
}

module.exports = {
  phaseKeyOf,
  ignoredArtifactNotice,
  ignoredNoticeFor,
  ignoredNoticeForEvent,
  withIgnoredArtifactNotice,
  withPrepareNotice,
  carryHandlerNotices,
};
