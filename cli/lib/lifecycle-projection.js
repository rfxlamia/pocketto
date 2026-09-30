'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CliError } = require('./envelope');
const { writeFileAtomicSync } = require('./atomic-file');
const { readLog } = require('./logjson');
const { readLifecycleDoc } = require('./lifecycle-store');

function taskIdsDeclaredByPhaseFile(planDir, phaseFile) {
  const phasePath = path.resolve(planDir, phaseFile);
  const relative = path.relative(planDir, phasePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;

  let content;
  try {
    content = fs.readFileSync(phasePath, 'utf8');
  } catch {
    return null;
  }

  const ids = new Set();
  for (const match of content.matchAll(/^### Task (\d+):/gm)) ids.add(`T${Number(match[1])}`);
  for (const match of content.matchAll(/^\|\s*(T\d+)\s*\|/gm)) ids.add(match[1]);
  for (const match of content.matchAll(/-\s*\*\*(T\d+):\*\*/gm)) ids.add(match[1]);
  return [...ids];
}

function taskRowsAreValid(tasks) {
  return !tasks.some((task) => (
    !task
    || typeof task !== 'object'
    || Array.isArray(task)
    || typeof task.id !== 'string'
    || task.id.length === 0
    || typeof task.name !== 'string'
    || !['BLOCKED', 'DONE', 'REVIEW', 'WAITING'].includes(task.status)
    || (Object.prototype.hasOwnProperty.call(task, 'done_sha')
      && task.done_sha !== null
      && (typeof task.done_sha !== 'string' || task.done_sha.length === 0))
  ));
}

function taskRowsMatchDeclarations(tasks, declaredTaskIds) {
  if (Array.isArray(declaredTaskIds) && declaredTaskIds.length > 0) {
    const actual = tasks.map((task) => task.id).sort();
    const declared = [...declaredTaskIds].sort();
    if (actual.length !== declared.length || actual.some((id, index) => id !== declared[index])) return false;
  }
  return true;
}

function correctionsAreValid(phase) {
  if (!Object.prototype.hasOwnProperty.call(phase, 'corrections')) return true;
  return Array.isArray(phase.corrections) && !phase.corrections.some((correction) => (
    !correction
    || typeof correction !== 'object'
    || Array.isArray(correction)
    || typeof correction.sha !== 'string'
    || correction.sha.length === 0
    || !Array.isArray(correction.files)
    || correction.files.some((file) => typeof file !== 'string')
    || (Object.prototype.hasOwnProperty.call(correction, 'for_task')
      && typeof correction.for_task !== 'string')
  ));
}

function projectionHasCompleteTaskState(planDir, phase) {
  if (!phase || typeof phase !== 'object' || Array.isArray(phase)) return false;
  if (typeof phase.file !== 'string' || phase.file.length === 0) return false;
  if (!['BLOCKED', 'DONE', 'REVIEW', 'WAITING'].includes(phase.status)) return false;

  const declaredTaskIds = taskIdsDeclaredByPhaseFile(planDir, phase.file);
  if (!Array.isArray(phase.tasks)) {
    // `tasks` is omitted for taskless phases in log.json. Accept that shape
    // only when the phase source is readable and declares no task identities.
    return !Object.prototype.hasOwnProperty.call(phase, 'tasks')
      && Array.isArray(declaredTaskIds)
      && declaredTaskIds.length === 0;
  }

  const tasks = phase.tasks;
  return taskRowsAreValid(tasks)
    && taskRowsMatchDeclarations(tasks, declaredTaskIds)
    && correctionsAreValid(phase);
}

function projectionHasCompleteRepairState(planDir, projection) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return false;
  const { header, phases } = projection;
  if (!header || typeof header !== 'object' || Array.isArray(header) || !Array.isArray(phases) || phases.length === 0) {
    return false;
  }
  const requiredHeaderFields = [
    'plan_dir', 'plan_type', 'status', 'date_started', 'date_completed', 'baseline_sha', 'pipeline',
  ];
  if (requiredHeaderFields.some((field) => !Object.prototype.hasOwnProperty.call(header, field))) return false;
  if (
    typeof header.plan_dir !== 'string'
    || path.resolve(header.plan_dir) !== planDir
    || !['flat', 'phased'].includes(header.plan_type)
    || !['IN_PROGRESS', 'DONE'].includes(header.status)
    || typeof header.date_started !== 'string'
    || (header.date_completed !== null && typeof header.date_completed !== 'string')
    || (header.baseline_sha !== null && (typeof header.baseline_sha !== 'string' || header.baseline_sha.length === 0))
    || !Number.isInteger(header.pipeline)
  ) return false;

  return phases.every((phase) => (
    phase
    && typeof phase === 'object'
    && !Array.isArray(phase)
    && Number.isInteger(phase.order)
    && phase.order > 0
    && projectionHasCompleteTaskState(planDir, phase)
  ));
}

function unrecoverableProjectionError(logPath) {
  return new CliError(
    'LIFECYCLE_REPAIR_STATE_UNRECOVERABLE',
    `cannot safely reconstruct the complete task projection from lifecycle.json; restore ${logPath} from a trusted backup before retrying lifecycle repair`,
  );
}

function initializeProjection(planDir, logPath) {
  if (!fs.existsSync(logPath)) throw unrecoverableProjectionError(logPath);

  let projection;
  try {
    projection = readLog(logPath);
  } catch (err) {
    if (err instanceof SyntaxError || (err && err.code === 'ENOENT')) {
      throw unrecoverableProjectionError(logPath);
    }
    throw new CliError('LIFECYCLE_REPAIR_FAILED', `could not read lifecycle projection: ${logPath}`);
  }

  if (!projectionHasCompleteRepairState(planDir, projection)) {
    throw unrecoverableProjectionError(logPath);
  }
  return projection;
}

function projectionPathKey(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function applyLifecycleProjection(doc, projection) {
  const phases = projection.phases;
  const events = [...doc.events].sort((left, right) => left.revision - right.revision);
  for (const event of events) {
    if (event.type !== 'phase-complete') continue;
    for (const ref of event.artifact_refs || []) {
      if (ref.root !== 'plan' || ref.kind !== 'phase-evidence') continue;
      const phase = phases.find((candidate) => projectionPathKey(candidate.file) === projectionPathKey(ref.path));
      if (phase && phase.status === 'WAITING') phase.status = 'REVIEW';
    }
  }

  const planState = (doc.plan && doc.plan.state) || {};
  if (planState.status === 'DONE') {
    for (const phase of phases) phase.status = 'DONE';
    projection.header.status = 'DONE';
    const closeEvent = events.find((event) => event.type === 'plan-closed');
    if (closeEvent && typeof closeEvent.occurred_at === 'string') {
      projection.header.date_completed = closeEvent.occurred_at.slice(0, 10);
    }
  } else {
    projection.header.status = 'IN_PROGRESS';
    projection.header.date_completed = null;
  }
  return projection;
}

function runRepair({ specDir } = {}) {
  if (typeof specDir !== 'string' || specDir.length === 0) {
    throw new CliError('USAGE', 'Usage: pocketto-pi lifecycle repair <spec_dir>');
  }

  const doc = readLifecycleDoc(specDir);
  if (!doc) throw new CliError('LIFECYCLE_NOT_FOUND', `lifecycle document not found: ${specDir}`);
  if (!doc.plan || typeof doc.plan.plan_dir !== 'string' || doc.plan.plan_dir.length === 0) {
    throw new CliError('LIFECYCLE_PLAN_DIR_REQUIRED', 'lifecycle repair requires a committed plan_dir');
  }

  const planDir = path.resolve(doc.plan.plan_dir);
  const logPath = path.join(planDir, 'log.json');
  const projection = initializeProjection(planDir, logPath);
  applyLifecycleProjection(doc, projection);
  const serialized = `${JSON.stringify(projection, null, 2)}\n`;
  const current = fs.readFileSync(logPath, 'utf8');
  if (current !== serialized) {
    try {
      writeFileAtomicSync(logPath, serialized);
    } catch (err) {
      throw new CliError('LIFECYCLE_REPAIR_FAILED', `could not write repaired projection: ${err.message}`);
    }
  }

  return {
    command: 'lifecycle repair',
    exit: 0,
    human: [`Rebuilt ${logPath} from committed lifecycle state (revision ${doc.plan.revision}).`],
    data: {
      plan_id: doc.plan.plan_id,
      plan_dir: planDir,
      log_path: logPath,
      revision: doc.plan.revision,
      journal_length: doc.events.length,
    },
  };
}

module.exports = {
  applyLifecycleProjection,
  initializeProjection,
  runRepair,
};
