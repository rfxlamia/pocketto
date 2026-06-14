'use strict';

// Port of pocket-log-init.py / pocket-log-update.py / pocket-log-close.py.
// log.json schema is unchanged — fully backward compatible with existing plans.
// git-SHA tracking (baseline_sha / done_sha) preserved from the bin/* versions.

const path = require('node:path');
const { readFileSync, existsSync, statSync, readdirSync } = require('node:fs');
const { CliError } = require('../lib/envelope');
const { readLog, writeLog, todayISO } = require('../lib/logjson');
const { getGitSha, getCommitFiles, getRangeFiles, commitExists } = require('../lib/git');

const VALID_STATUSES = ['BLOCKED', 'DONE', 'REVIEW', 'WAITING']; // sorted, for messages
const VALID_SET = new Set(VALID_STATUSES);

// ─── SHARED ─────────────────────────────────────────────────────────────────

function extractTasks(phaseFile) {
  if (!existsSync(phaseFile)) return [];
  const content = readFileSync(phaseFile, 'utf8');
  const tasks = [];
  const re = /^### Task (\d+): (.+)$/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const num = parseInt(m[1], 10);
    const raw = m[2].trim();
    const dep = raw.match(/\[depends:\s*([^\]]+)\]/);
    const depends = dep ? dep[1].trim() : null;
    const name = raw.replace(/\s*\[.*?\]/g, '').trim();
    const entry = { id: `T${num}`, name, status: 'WAITING' };
    if (depends) entry.depends = depends;
    tasks.push(entry);
  }
  return tasks;
}

function resolvePlanDir(arg) {
  let st;
  try {
    st = statSync(arg);
  } catch {
    throw new CliError('NOT_FOUND', `'${arg}' is not a file or directory.`);
  }
  if (st.isFile()) return path.dirname(arg);
  if (st.isDirectory()) return arg;
  throw new CliError('NOT_FOUND', `'${arg}' is not a file or directory.`);
}

function collectPlanFiles(planDir) {
  const phaseFiles = readdirSync(planDir)
    .filter((f) => /^execution-plan-phase-\d+\.md$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/phase-(\d+)/)[1], 10);
      const nb = parseInt(b.match(/phase-(\d+)/)[1], 10);
      return na - nb;
    });

  if (phaseFiles.length) {
    return phaseFiles.map((f, i) => {
      const tasks = extractTasks(path.join(planDir, f));
      const entry = { order: i + 1, file: f, status: 'WAITING' };
      if (tasks.length) entry.tasks = tasks;
      return entry;
    });
  }

  const flat = path.join(planDir, 'execution-plan.md');
  if (existsSync(flat)) {
    const tasks = extractTasks(flat);
    const entry = { order: 1, file: 'execution-plan.md', status: 'WAITING' };
    if (tasks.length) entry.tasks = tasks;
    return [entry];
  }

  throw new CliError('NO_PLAN_FILES', `no execution-plan*.md files found in '${planDir}'.`);
}

// file → owning task id, by chaining each DONE task's original range
// (prev..done_sha) in plan order. Last writer within original ranges wins.
// Mirrors pocket-review's linear range model. Correction commits are NOT
// part of any task's original range, so they never appear here.
function buildOwnerMap(planDir, phase, baselineSha) {
  const owner = {};
  let prev = baselineSha;
  for (const t of phase.tasks || []) {
    if (!t.done_sha) continue;
    for (const f of getRangeFiles(planDir, prev, t.done_sha)) owner[f] = t.id;
    prev = t.done_sha;
  }
  return owner;
}

// ─── INIT ───────────────────────────────────────────────────────────────────

function init(positionals) {
  if (positionals.length !== 1) {
    throw new CliError('USAGE', 'Usage: pocketto-pi log init <plan_dir>');
  }
  const planDir = resolvePlanDir(positionals[0]);
  const logPath = path.join(planDir, 'log.json');

  if (existsSync(logPath)) return migrateExisting(planDir, logPath);

  const phases = collectPlanFiles(planDir);
  const planType = phases.length > 1 || phases[0].file.includes('phase') ? 'phased' : 'flat';

  const log = {
    header: {
      plan_dir: planDir,
      plan_type: planType,
      status: 'IN_PROGRESS',
      date_started: todayISO(),
      date_completed: null,
      baseline_sha: getGitSha(planDir),
    },
    phases,
  };
  writeLog(logPath, log);

  const human = [`Created ${logPath}`, `  type    : ${planType}`, `  phases  : ${phases.length}`];
  for (const p of phases) {
    const ids = (p.tasks || []).map((t) => t.id).join(', ');
    human.push(`    [${p.order}] ${p.file} → ${p.status} | tasks: ${ids || 'none'}`);
  }

  return {
    command: 'log init',
    exit: 0,
    human,
    data: { planDir, logPath, planType, migrated: false, phaseCount: phases.length, phases },
  };
}

function migrateExisting(planDir, logPath) {
  const log = readLog(logPath);
  let migrated = 0;
  for (const phase of log.phases) {
    if ('tasks' in phase) continue;
    const tasks = extractTasks(path.join(planDir, phase.file));
    if (!tasks.length) continue;
    const phaseStatus = phase.status || 'WAITING';
    const taskStatus = ['DONE', 'REVIEW', 'BLOCKED'].includes(phaseStatus) ? phaseStatus : 'WAITING';
    for (const t of tasks) t.status = taskStatus;
    phase.tasks = tasks;
    migrated++;
  }

  if (migrated === 0) {
    const human = [`log.json already exists at ${logPath} — no migration needed.`];
    return {
      command: 'log init',
      exit: 0,
      human,
      data: { planDir, logPath, migrated: false, phaseCount: log.phases.length, phases: log.phases },
    };
  }

  writeLog(logPath, log);
  const human = [`Migrated tasks into existing ${logPath}`];
  for (const phase of log.phases) {
    const ids = (phase.tasks || []).map((t) => t.id).join(', ');
    human.push(`  [${phase.order}] ${phase.file} (${phase.status}) → tasks: ${ids || 'none'}`);
  }
  return {
    command: 'log init',
    exit: 0,
    human,
    data: { planDir, logPath, migrated: true, phaseCount: log.phases.length, phases: log.phases },
  };
}

// ─── UPDATE ─────────────────────────────────────────────────────────────────

function update(positionals, taskId) {
  if (positionals.length !== 3) {
    throw new CliError('USAGE', 'Usage: pocketto-pi log update <plan_dir> <phase_file> <status> [--task <task_id>]');
  }
  const [planDirArg, phaseFile, statusArg] = positionals;
  const planDir = resolvePlanDir(planDirArg); // accept a plan file or its directory, like `init`
  const newStatus = statusArg.toUpperCase();
  if (!VALID_SET.has(newStatus)) {
    throw new CliError('BAD_STATUS', `status must be one of [${VALID_STATUSES.join(', ')}], got '${statusArg}'.`);
  }

  const logPath = path.join(planDir, 'log.json');
  if (!existsSync(logPath)) {
    throw new CliError('NO_LOG', `log.json not found at '${logPath}'. Run 'pocketto-pi log init' first.`);
  }

  const log = readLog(logPath);
  const phase = log.phases.find((p) => p.file === phaseFile);
  if (!phase) {
    const available = log.phases.map((p) => p.file);
    throw new CliError('PHASE_NOT_FOUND', `'${phaseFile}' not found in log. Available: ${JSON.stringify(available)}`);
  }

  let human;
  let data;

  if (taskId) {
    const tasks = phase.tasks || [];
    if (!tasks.length) {
      throw new CliError(
        'NO_TASKS',
        `phase '${phaseFile}' has no tasks in log.json. Re-run 'pocketto-pi log init' to inject tasks.`,
      );
    }
    const task = tasks.find((t) => t.id.toUpperCase() === taskId.toUpperCase());
    if (!task) {
      const ids = tasks.map((t) => t.id);
      throw new CliError(
        'TASK_NOT_FOUND',
        `task '${taskId}' not found in phase '${phaseFile}'. Available: ${JSON.stringify(ids)}`,
      );
    }
    const oldStatus = task.status;
    task.status = newStatus;
    let shaCollision = null;
    if (newStatus === 'DONE') {
      const sha = getGitSha(planDir);
      if (sha) {
        task.done_sha = sha;
        // A sibling task in this phase already carries this exact SHA — the
        // signature of a collapsed parallel-group merge. When parallel tasks
        // are merged in a batch and only logged afterwards, every `log update`
        // captures the same final HEAD (one merge commit) instead of each
        // task's own merge commit, which silently empties pocket-review's
        // per-task diff range (<prev_sha>..<done_sha>) for the 2nd+ task.
        // Warn, but don't fail — the status change itself is legitimate.
        const dupes = (phase.tasks || [])
          .filter((t) => t.id !== task.id && t.done_sha === sha)
          .map((t) => t.id);
        if (dupes.length) shaCollision = dupes;
      }
    }
    writeLog(logPath, log);
    human = [`Updated ${phaseFile} / ${task.id} (${task.name}): ${oldStatus} → ${newStatus}`];
    if (shaCollision) {
      human.push(
        `⚠ done_sha ${task.done_sha} is already recorded for ${shaCollision.join(', ')} in this phase.`,
        `  Parallel-group tasks must be merged and logged one at a time (merge → log update),`,
        `  so each captures its own merge commit. See pocket-development → Group Merge.`,
      );
    }
    data = {
      planDir,
      phaseFile,
      level: 'task',
      taskId: task.id,
      name: task.name,
      oldStatus,
      newStatus,
      doneSha: task.done_sha || null,
      shaCollision,
    };
  } else {
    const oldStatus = phase.status;
    phase.status = newStatus;
    writeLog(logPath, log);
    human = [`Updated ${phaseFile}: ${oldStatus} → ${newStatus}`];
    data = { planDir, phaseFile, level: 'phase', oldStatus, newStatus };
  }

  human.push('Current log:');
  for (const p of log.phases) {
    const marker = p.file === phaseFile ? '←' : ' ';
    const tasks = p.tasks || [];
    const taskSummary = tasks.length
      ? ' | tasks: ' + tasks.map((t) => `${t.id}=${t.status}`).join(', ')
      : '';
    human.push(`  ${marker} ${p.file}: ${p.status}${taskSummary}`);
  }
  data.phases = log.phases;

  return { command: 'log update', exit: 0, human, data };
}

// ─── CORRECTION ─────────────────────────────────────────────────────────────

function recordCorrection(positionals, sha, forTask) {
  if (positionals.length !== 2) {
    throw new CliError(
      'USAGE',
      'Usage: pocketto-pi log update <plan_dir> <phase_file> --correction <sha> [--for-task <task_id>]',
    );
  }
  const [planDirArg, phaseFile] = positionals;
  const planDir = resolvePlanDir(planDirArg);
  const logPath = path.join(planDir, 'log.json');
  if (!existsSync(logPath)) {
    throw new CliError('NO_LOG', `log.json not found at '${logPath}'. Run 'pocketto-pi log init' first.`);
  }
  const log = readLog(logPath);
  const phase = log.phases.find((p) => p.file === phaseFile);
  if (!phase) {
    const available = log.phases.map((p) => p.file);
    throw new CliError('PHASE_NOT_FOUND', `'${phaseFile}' not found in log. Available: ${JSON.stringify(available)}`);
  }
  if (!phase.corrections) phase.corrections = [];

  const forId = forTask ? forTask.toUpperCase() : null;

  // Guard: if --for-task is given and the phase has tasks, the id must exist.
  if (forId && Array.isArray(phase.tasks) && phase.tasks.length > 0) {
    const match = phase.tasks.find((t) => t.id.toUpperCase() === forId);
    if (!match) {
      throw new CliError(
        'UNKNOWN_TASK',
        `task '${forTask}' not found in phase '${phaseFile}'. Available: ${JSON.stringify((phase.tasks || []).map((t) => t.id))}`,
      );
    }
  }

  // FIX 2: reject an invalid/unresolvable sha before getCommitFiles silently
  // returns [] and causes recordCorrection to skip without any error.
  if (!commitExists(planDir, sha)) {
    throw new CliError('UNKNOWN_SHA', `correction sha '${sha}' is not a commit in '${planDir}'.`);
  }

  const files = getCommitFiles(planDir, sha);

  // Empty-diff correction (e.g. --allow-empty, or a revert that nets to nothing)
  // → nothing to attribute. Skip without appending, per design.
  if (files.length === 0) {
    return {
      command: 'log update',
      exit: 0,
      human: [`Correction ${sha} has no file changes — skipped (nothing to attribute).`],
      data: {
        planDir,
        phaseFile,
        level: 'correction',
        correction: { sha, files: [], affectedTasks: [], bleed: [], skipped: true },
      },
    };
  }

  // FIX 1: guard against a null baseline_sha — without it buildOwnerMap cannot
  // produce meaningful attribution (getRangeFiles would be called with null base).
  if (!log.header.baseline_sha) {
    throw new CliError(
      'NO_BASELINE',
      `baseline_sha is missing in log.json header — cannot attribute corrections (was log init run inside a git repo?).`,
    );
  }

  const owner = buildOwnerMap(planDir, phase, log.header.baseline_sha);

  // Attribution: every owning task whose files appear in this commit.
  const affected = new Set();
  if (forId) affected.add(forId);
  const bleed = new Set();
  for (const f of files) {
    const o = owner[f];
    if (!o) continue;          // brand-new file, owned by no prior task
    affected.add(o);
    if (forId && o !== forId) bleed.add(o);
  }
  const affectedTasks = [...affected].sort();
  const bleedTasks = [...bleed].sort();

  // Idempotency: a sha already recorded on this phase → no-op + warn.
  // FIX 3: recompute affectedTasks/bleed from the PERSISTED entry's for_task and
  // files so a re-run with a different --for-task reports stored attribution, not
  // the new request's.
  const existing = phase.corrections.find((c) => c.sha === sha);
  if (existing) {
    const storedForId = existing.for_task || null;
    const idempotentAffected = new Set();
    if (storedForId) idempotentAffected.add(storedForId);
    const idempotentBleed = new Set();
    for (const f of existing.files || []) {
      const o = owner[f];
      if (!o) continue;
      idempotentAffected.add(o);
      if (storedForId && o !== storedForId) idempotentBleed.add(o);
    }
    return {
      command: 'log update',
      exit: 0,
      human: [`Correction ${sha} is already recorded on ${phaseFile} — no-op.`],
      data: {
        planDir,
        phaseFile,
        level: 'correction',
        correction: {
          sha,
          files: existing.files,
          affectedTasks: [...idempotentAffected].sort(),
          bleed: [...idempotentBleed].sort(),
          idempotent: true,
        },
      },
    };
  }

  const entry = { sha, files };
  if (forId) entry.for_task = forId;
  phase.corrections.push(entry);
  writeLog(logPath, log);

  const human = [`Recorded correction ${sha} on ${phaseFile}${forId ? ` (for ${forId})` : ''}: ${files.length} file(s).`];
  if (bleedTasks.length) {
    human.push(
      `⚠ this correction also touches files owned by ${bleedTasks.join(', ')} (cross-task bleed).`,
      `  Those tasks will be re-reviewed by pocket-review. See design: full attribution.`,
    );
  }
  return {
    command: 'log update',
    exit: 0,
    human,
    data: {
      planDir,
      phaseFile,
      level: 'correction',
      correction: { sha, files, affectedTasks, bleed: bleedTasks, idempotent: false },
    },
  };
}

// ─── CLOSE ──────────────────────────────────────────────────────────────────

function close(positionals) {
  if (positionals.length !== 1) {
    throw new CliError('USAGE', 'Usage: pocketto-pi log close <plan_dir>');
  }
  const planDir = resolvePlanDir(positionals[0]); // accept a plan file or its directory, like `init`
  const logPath = path.join(planDir, 'log.json');
  if (!existsSync(logPath)) {
    throw new CliError('NO_LOG', `log.json not found at '${logPath}'. Run 'pocketto-pi log init' first.`);
  }

  const log = readLog(logPath);
  const notDone = log.phases.filter((p) => p.status !== 'DONE');
  if (notDone.length) {
    const lines = ['Cannot close — phases not DONE:'];
    for (const p of notDone) lines.push(`  [${p.order}] ${p.file}: ${p.status}`);
    throw new CliError(
      'PHASES_NOT_DONE',
      'Cannot close — phases not DONE: ' + notDone.map((p) => `${p.file}=${p.status}`).join(', '),
      { exitCode: 1, human: lines.join('\n') },
    );
  }

  log.header.status = 'DONE';
  log.header.date_completed = todayISO();
  writeLog(logPath, log);

  const human = [
    `Closed ${logPath}`,
    `  status         : DONE`,
    `  date_started   : ${log.header.date_started}`,
    `  date_completed : ${log.header.date_completed}`,
    `  phases         : ${log.phases.length} — all DONE`,
  ];

  return {
    command: 'log close',
    exit: 0,
    human,
    data: {
      planDir,
      logPath,
      status: 'DONE',
      dateStarted: log.header.date_started,
      dateCompleted: log.header.date_completed,
      phaseCount: log.phases.length,
    },
  };
}

// ─── DISPATCH ───────────────────────────────────────────────────────────────

function run({ sub, positionals, task, correction, forTask }) {
  if (sub === 'init') return init(positionals);
  if (sub === 'update') {
    if (correction) return recordCorrection(positionals, correction, forTask);
    return update(positionals, task);
  }
  if (sub === 'close') return close(positionals);
  throw new CliError('UNKNOWN_SUBCOMMAND', `Unknown 'log' subcommand: ${sub || '(none)'}. Use init | update | close.`);
}

module.exports = { run };
