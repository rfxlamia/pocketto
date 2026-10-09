'use strict';

// Explicit v3-to-v4 lifecycle snapshot import. The importer is deliberately
// read-only with respect to every legacy artifact: its only write is the new
// authoritative lifecycle.json document, published through atomic rename.

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { CliError } = require('./envelope');
const { writeFileAtomicSync } = require('./atomic-file');
const { withLifecycleMutation } = require('./lifecycle-lock');

const LIFECYCLE_SCHEMA = 1;
const PLAN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIFECYCLE_FILE = 'lifecycle.json';
const V3_LOG_FILE = 'log.json';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message) {
  return { ok: false, code, message };
}

function assertAllowedFields(value, allowed) {
  if (!isObject(value)) return false;
  return Object.keys(value).every((field) => allowed.includes(field));
}

function resolveLegacyPlanDir(specDir, legacyPath) {
  return path.isAbsolute(legacyPath)
    ? path.resolve(legacyPath)
    : path.resolve(specDir, legacyPath);
}

// Be conservative: any unfamiliar state field or non-WAITING execution state
// could represent progress that the lifecycle snapshot cannot losslessly map.
function isPristineV3Snapshot(log, specDir) {
  if (!assertAllowedFields(log, ['header', 'phases'])) return false;
  const header = log.header;
  if (!assertAllowedFields(header, [
    'plan_dir', 'plan_type', 'status', 'date_started', 'date_completed',
    'baseline_sha', 'pipeline', 'plan_file',
  ])) return false;
  if (
    typeof header.plan_dir !== 'string'
    || header.plan_dir.length === 0
    || !['flat', 'phased'].includes(header.plan_type)
    || header.status !== 'IN_PROGRESS'
    || typeof header.date_started !== 'string'
    || header.date_started.length === 0
    || header.date_completed !== null
    || (header.baseline_sha !== null && typeof header.baseline_sha !== 'string')
    || (header.pipeline !== undefined && !Number.isInteger(header.pipeline))
    || (header.plan_file !== undefined && (typeof header.plan_file !== 'string' || header.plan_file.length === 0))
  ) return false;

  const planDir = resolveLegacyPlanDir(specDir, header.plan_dir);
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) return false;
  if (!Array.isArray(log.phases) || log.phases.length === 0) return false;

  return log.phases.every((phase) => {
    if (!assertAllowedFields(phase, ['order', 'file', 'status', 'tasks', 'corrections'])) return false;
    if (
      !Number.isInteger(phase.order)
      || phase.order < 1
      || typeof phase.file !== 'string'
      || phase.file.length === 0
      || phase.status !== 'WAITING'
      || (phase.corrections !== undefined && (!Array.isArray(phase.corrections) || phase.corrections.length !== 0))
    ) return false;
    if (phase.tasks === undefined) return true;
    if (!Array.isArray(phase.tasks)) return false;
    return phase.tasks.every((task) => {
      if (!assertAllowedFields(task, ['id', 'name', 'status', 'file', 'depends', 'done_sha'])) return false;
      return typeof task.id === 'string'
        && task.id.length > 0
        && typeof task.name === 'string'
        && task.status === 'WAITING'
        && (task.file === undefined || (typeof task.file === 'string' && task.file.length > 0))
        && (task.depends === undefined || task.depends === null || typeof task.depends === 'string')
        && (task.done_sha === undefined || task.done_sha === null);
    });
  });
}

function pinV3RequiredError() {
  return new CliError(
    'PIN_V3_REQUIRED',
    'This v3 plan has execution progress or a non-pristine header. Pin pocketto-pi@3.1.3 with `npx -y pocketto-pi@3.1.3` and finish the plan under v3; migration is refused without changing v3 files.',
  );
}

function readV3Snapshot(specDir) {
  const logPath = path.join(specDir, V3_LOG_FILE);
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new CliError('LIFECYCLE_V3_SNAPSHOT_NOT_FOUND', `v3 log snapshot not found: ${logPath}`);
    }
    throw new CliError('LIFECYCLE_V3_SNAPSHOT_UNREADABLE', `cannot read v3 log snapshot: ${logPath}`);
  }
  let log;
  try {
    log = JSON.parse(raw);
  } catch (err) {
    throw new CliError('LIFECYCLE_V3_SNAPSHOT_INVALID', `v3 log snapshot is not valid JSON: ${err.message}`);
  }
  if (!isPristineV3Snapshot(log, specDir)) throw pinV3RequiredError();
  return log;
}

function lifecycleSnapshot(specDir, log) {
  const planId = path.basename(path.resolve(specDir));
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new CliError('LIFECYCLE_BAD_PLAN_ID', 'spec_dir basename must be a kebab-slug to migrate a v3 plan');
  }
  const planDir = resolveLegacyPlanDir(specDir, log.header.plan_dir);
  return {
    schema: LIFECYCLE_SCHEMA,
    plan: {
      plan_id: planId,
      spec_dir: path.resolve(specDir),
      plan_dir: planDir,
      branch: null,
      state: { approval: 'PENDING', phase_status: {}, status: 'IN_PROGRESS' },
      revision: 0,
    },
    events: [],
  };
}

function serializeLifecycle(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function matchesLifecycleIdentity(doc, specDir, planId) {
  return isObject(doc)
    && doc.schema === LIFECYCLE_SCHEMA
    && isObject(doc.plan)
    && doc.plan.plan_id === planId
    && typeof doc.plan.spec_dir === 'string'
    && path.resolve(doc.plan.spec_dir) === path.resolve(specDir)
    && Number.isInteger(doc.plan.revision)
    && doc.plan.revision >= 0
    && Array.isArray(doc.events);
}

function readExistingLifecycle(specDir, planId) {
  const lifecyclePath = path.join(specDir, LIFECYCLE_FILE);
  if (!fs.existsSync(lifecyclePath)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  } catch {
    return fail('LIFECYCLE_ALREADY_EXISTS', `lifecycle document is unreadable and will not be replaced: ${lifecyclePath}`);
  }
  if (!matchesLifecycleIdentity(doc, specDir, planId)) {
    return fail('LIFECYCLE_ALREADY_EXISTS', `lifecycle document belongs to another or unsupported state and will not be replaced: ${lifecyclePath}`);
  }
  return { ok: true, doc, created: false };
}

function migrationResult(outcome) {
  const replayed = outcome.created === false;
  return {
    command: 'lifecycle migrate',
    exit: 0,
    human: [replayed
      ? `v3 migration already exists for ${outcome.doc.plan.plan_id}; lifecycle revision remains ${outcome.doc.plan.revision}.`
      : `Migrated pristine v3 snapshot for ${outcome.doc.plan.plan_id} to lifecycle.json (revision 0; no event emitted).`],
    data: {
      plan_id: outcome.doc.plan.plan_id,
      revision: outcome.doc.plan.revision,
      event_count: outcome.doc.events.length,
      created: !replayed,
      idempotent: replayed,
    },
  };
}

function runMigration({ specDir, from } = {}) {
  if (typeof specDir !== 'string' || specDir.length === 0) {
    throw new CliError('USAGE', 'Usage: pocketto-pi lifecycle migrate <spec_dir> --from v3');
  }
  if (from !== 'v3') {
    throw new CliError('LIFECYCLE_MIGRATION_SOURCE_UNSUPPORTED', "lifecycle migrate requires '--from v3'");
  }
  const absoluteSpecDir = path.resolve(specDir);
  let stat;
  try {
    stat = fs.statSync(absoluteSpecDir);
  } catch {
    throw new CliError('LIFECYCLE_BAD_SPEC_DIR', `spec_dir does not exist: ${absoluteSpecDir}`);
  }
  if (!stat.isDirectory()) {
    throw new CliError('LIFECYCLE_BAD_SPEC_DIR', `spec_dir is not a directory: ${absoluteSpecDir}`);
  }

  const planId = path.basename(absoluteSpecDir);
  const outcome = withLifecycleMutation(absoluteSpecDir, () => {
    const existing = readExistingLifecycle(absoluteSpecDir, planId);
    if (existing && existing.ok === false) return existing;
    // An identity match is not a finished migration. Replay succeeds only when
    // the v3 log is still pristine and the journal is still that snapshot.
    const log = readV3Snapshot(absoluteSpecDir);
    if (existing) {
      const expected = lifecycleSnapshot(absoluteSpecDir, log);
      if (!isDeepStrictEqual(existing.doc, expected)) {
        return fail(
          'LIFECYCLE_ALREADY_EXISTS',
          `lifecycle document is not the pristine v3 migration snapshot and will not be replaced: ${path.join(absoluteSpecDir, LIFECYCLE_FILE)}`,
        );
      }
      return existing;
    }
    const doc = lifecycleSnapshot(absoluteSpecDir, log);
    try {
      writeFileAtomicSync(path.join(absoluteSpecDir, LIFECYCLE_FILE), serializeLifecycle(doc));
    } catch (err) {
      return fail('LIFECYCLE_MIGRATION_PERSISTENCE', `could not atomically create lifecycle.json: ${err.message}`);
    }
    return { ok: true, doc, created: true };
  });

  if (!outcome || outcome.ok === false) {
    const code = outcome && outcome.code ? outcome.code : 'LIFECYCLE_MIGRATION_FAILED';
    const message = outcome && outcome.message ? outcome.message : 'could not serialize v3 lifecycle migration';
    throw new CliError(code, message);
  }
  return migrationResult(outcome);
}

module.exports = {
  LIFECYCLE_SCHEMA,
  LIFECYCLE_FILE,
  V3_LOG_FILE,
  isPristineV3Snapshot,
  lifecycleSnapshot,
  runMigration,
};
