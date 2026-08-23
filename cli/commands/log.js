'use strict';

// Port of pocket-log-init.py / pocket-log-update.py / pocket-log-close.py.
// log.json schema supports new execution-plan/ layout with per-task file pointers,
// while remaining fully backward compatible with legacy phased and flat plans.
// git-SHA tracking (baseline_sha / done_sha) preserved from the bin/* versions.

const path = require('node:path');
const { readFileSync, existsSync, statSync, readdirSync } = require('node:fs');
const { CliError } = require('../lib/envelope');
const { writeLog, todayISO, readLogChecked } = require('../lib/logjson');
const { getGitSha, getCommitFiles, getRangeFiles, commitExists, resolveCommit, isAncestorOfHead } = require('../lib/git');
const { PIPELINE } = require('../lib/version');

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
  let dir = st.isFile() ? path.dirname(arg) : arg;
  // If the path ends in /execution-plan or /execution-plan/, step up to the plan directory where log.json lives
  if (path.basename(dir) === 'execution-plan') {
    dir = path.dirname(dir);
  }
  return dir;
}

function findSourcePlanFile(planDir, indexContent = null) {
  if (indexContent) {
    const match = indexContent.match(/\*\*Source Plan:\*\* \.\.\/(.+)$/m);
    if (match) {
      const candidate = path.join(planDir, match[1].trim());
      if (existsSync(candidate)) return candidate;
    }
  }
  const defaultPlan = path.join(planDir, 'execution-plan.md');
  if (existsSync(defaultPlan)) return defaultPlan;

  const files = readdirSync(planDir).filter((f) =>
    f.endsWith('.md') &&
    !f.startsWith('closeout') &&
    !f.startsWith('AGENTS') &&
    !f.startsWith('CLAUDE') &&
    f.toLowerCase() !== 'readme.md',
  );
  if (files.length === 1) return path.join(planDir, files[0]);
  if (files.length > 1) {
    throw new CliError(
      'AMBIGUOUS_SOURCE_PLAN',
      `Multiple candidate source plans in '${planDir}': ${files.join(', ')}. Pass the source plan explicitly or keep a single execution-plan.md.`,
    );
  }
  return defaultPlan;
}

function collectPlanFiles(planDir) {
  const execPlanSubdir = path.join(planDir, 'execution-plan');
  const indexFile = path.join(execPlanSubdir, 'index.md');

  // NEW LAYOUT: execution-plan/ directory with index.md
  if (existsSync(execPlanSubdir) && existsSync(indexFile)) {
    const indexContent = readFileSync(indexFile, 'utf8');
    const phaseFiles = readdirSync(execPlanSubdir)
      .filter((f) => /^phase-\d+\.md$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/phase-(\d+)/)[1], 10);
        const nb = parseInt(b.match(/phase-(\d+)/)[1], 10);
        return na - nb;
      });

    // Helper to find task file in execution-plan/tasks/
    const findTaskFile = (tid) => {
      const tasksDir = path.join(execPlanSubdir, 'tasks');
      if (!existsSync(tasksDir)) return null;
      const tFiles = readdirSync(tasksDir).filter((f) => f.startsWith(`${tid}-`) || f === `${tid}.md`);
      if (tFiles.length > 0) return `execution-plan/tasks/${tFiles[0]}`;
      return null;
    };

    if (phaseFiles.length > 0) {
      // Multi-phase in execution-plan/
      return {
        planFile: 'execution-plan/index.md',
        phases: phaseFiles.map((f, i) => {
          const absPath = path.join(execPlanSubdir, f);
          let tasks = extractTasks(absPath);
          if (tasks.length === 0) {
            // Fallback: extract tasks from source plan matching TIDs in phase-N.md
            const sourcePlanPath = findSourcePlanFile(planDir, indexContent);
            const allTasks = extractTasks(sourcePlanPath);
            const phaseContent = readFileSync(absPath, 'utf8');
            const matchTids = [...phaseContent.matchAll(/-\s*\*\*(T\d+):\*\*/g)].map((m) => m[1]);
            tasks = allTasks.filter((t) => matchTids.includes(t.id));
          }
          for (const t of tasks) {
            const tf = findTaskFile(t.id);
            if (tf) t.file = tf;
          }
          const entry = { order: i + 1, file: `execution-plan/${f}`, status: 'WAITING' };
          if (tasks.length) entry.tasks = tasks;
          return entry;
        }),
      };
    } else {
      // Single phase in execution-plan/ (index.md + tasks/*).
      // Row order here becomes `tasks[]` order below, which becomes
      // log.phases[0].tasks — the dispatch/merge order pocket-development
      // treats as authoritative. index.md's Task Index table is rendered in
      // phaseGroups order (see structure.js:renderIndexFile), so this is not
      // an arbitrary read — reordering that table changes dispatch order.
      const tasks = [];
      const re = /^\| (T\d+) \| (.+?) \| Phase \d+ \| \[([^\]]+)\]\(tasks\/([^\)]+)\) \|/gm;
      let m;
      while ((m = re.exec(indexContent)) !== null) {
        const tid = m[1];
        const name = m[2].trim();
        const filename = m[4].trim();
        tasks.push({
          id: tid,
          name,
          file: `execution-plan/tasks/${filename}`,
          status: 'WAITING',
        });
      }

      // Fallback extract if regex didn't match table
      if (tasks.length === 0) {
        const sourcePlanPath = findSourcePlanFile(planDir, indexContent);
        const extracted = extractTasks(sourcePlanPath);
        for (const t of extracted) {
          const tf = findTaskFile(t.id);
          if (tf) t.file = tf;
          tasks.push(t);
        }
      }

      const entry = { order: 1, file: 'execution-plan/index.md', status: 'WAITING' };
      if (tasks.length) entry.tasks = tasks;
      return {
        planFile: 'execution-plan/index.md',
        phases: [entry],
      };
    }
  }

  // LEGACY FALLBACK 1: execution-plan-phase-N.md
  const phaseFiles = readdirSync(planDir)
    .filter((f) => /^execution-plan-phase-\d+\.md$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/phase-(\d+)/)[1], 10);
      const nb = parseInt(b.match(/phase-(\d+)/)[1], 10);
      return na - nb;
    });

  if (phaseFiles.length) {
    return {
      planFile: phaseFiles[0],
      phases: phaseFiles.map((f, i) => {
        const tasks = extractTasks(path.join(planDir, f));
        const entry = { order: i + 1, file: f, status: 'WAITING' };
        if (tasks.length) entry.tasks = tasks;
        return entry;
      }),
    };
  }

  // LEGACY FALLBACK 2: execution-plan.md or any source .md plan
  const sourcePlan = findSourcePlanFile(planDir);
  if (existsSync(sourcePlan)) {
    const tasks = extractTasks(sourcePlan);
    const relFile = path.relative(planDir, sourcePlan);
    const entry = { order: 1, file: relFile, status: 'WAITING' };
    if (tasks.length) entry.tasks = tasks;
    return {
      planFile: relFile,
      phases: [entry],
    };
  }

  throw new CliError('NO_PLAN_FILES', `no execution-plan*.md files found in '${planDir}'.`);
}

// file → owning task id, by chaining each DONE task's original range
// (prev..done_sha) in plan order. Last writer within original ranges wins.
// Mirrors the linear range model the phase-level pass and pocket-closing's
// owner-map attribution depend on. Correction commits are NOT part of any
// task's original range, so they never appear here.
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

  // A fresh init cannot produce duplicate done_sha values: tasks are created
  // without done_sha, which is only ever set by `log update … DONE`.
  const { planFile, phases } = collectPlanFiles(planDir);
  const planType = phases.length > 1 || phases[0].file.includes('phase') ? 'phased' : 'flat';

  const header = {
    plan_dir: planDir,
    plan_type: planType,
    status: 'IN_PROGRESS',
    date_started: todayISO(),
    date_completed: null,
    baseline_sha: getGitSha(planDir),
    pipeline: PIPELINE, // execution-pipeline generation; independent of CONTRACT
  };

  if (planFile && planFile !== phases[0].file) {
    header.plan_file = planFile;
  }

  const log = { header, phases };
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

// Pre-existing logs may carry duplicate done_sha values recorded before the
// CLI started refusing them (issue #38: collapsed parallel-group merge).
// Returns { <phaseFile>: { <sha>: [taskIds…] } } or null when clean.
function findDuplicateDoneShas(log) {
  const result = {};
  for (const phase of log.phases) {
    const bySha = {};
    for (const t of phase.tasks || []) {
      if (!t.done_sha) continue;
      if (!bySha[t.done_sha]) bySha[t.done_sha] = [];
      bySha[t.done_sha].push(t.id);
    }
    const dupes = {};
    for (const [sha, ids] of Object.entries(bySha)) {
      if (ids.length > 1) dupes[sha] = ids;
    }
    if (Object.keys(dupes).length) result[phase.file] = dupes;
  }
  return Object.keys(result).length ? result : null;
}

// Non-fatal by design: init must adopt existing plans, not brick them, so
// duplicates found here are warned about with repair instructions.
function warnDuplicateDoneShas(human, duplicateDoneShas) {
  if (!duplicateDoneShas) return;
  for (const [file, groups] of Object.entries(duplicateDoneShas)) {
    for (const [sha, ids] of Object.entries(groups)) {
      human.push(`⚠ ${file}: done_sha ${sha} is shared by ${ids.join(', ')} — the phase-level pass will skip the 2nd+ task.`);
    }
  }
  human.push(
    `  Repair each task with: pocketto-pi log update <plan_dir> <phase_file> DONE --task <id> --sha <that task's own merge commit>`,
  );
}

// Injects a missing `tasks` array into legacy phase entries. Topology
// reconcile after a source-plan change is owned by `structure --force`
// (no progress) / `structure --reset` (discards progress) — this function
// must not replace an existing tasks array.
function migrateExisting(planDir, logPath) {
  const log = readLogChecked(logPath);
  let migrated = 0;
  const execPlanSubdir = path.join(planDir, 'execution-plan');
  const indexFile = path.join(execPlanSubdir, 'index.md');
  const indexContent = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null;

  for (const phase of log.phases) {
    if ('tasks' in phase) continue;
    let absPath = path.join(planDir, phase.file);
    if (!existsSync(absPath)) {
      const norm = path.basename(phase.file);
      const phaseMatch = norm.match(/execution-plan-phase-(\d+)\.md$/);
      if (phaseMatch) {
        absPath = path.join(planDir, 'execution-plan', `phase-${phaseMatch[1]}.md`);
      }
    }
    let tasks = extractTasks(absPath);
    if (!tasks.length && phase.file.includes('phase')) {
      const sourcePlanPath = findSourcePlanFile(planDir, indexContent);
      const allTasks = extractTasks(sourcePlanPath);
      if (existsSync(absPath)) {
        const phaseContent = readFileSync(absPath, 'utf8');
        const matchTids = [...phaseContent.matchAll(/-\s*\*\*(T\d+):\*\*/g)].map((m) => m[1]);
        tasks = allTasks.filter((t) => matchTids.includes(t.id));
      }
    }
    // Attach task.file pointers if execution-plan/tasks/ exists
    const findTaskFile = (tid) => {
      const tasksDir = path.join(execPlanSubdir, 'tasks');
      if (!existsSync(tasksDir)) return null;
      const tFiles = readdirSync(tasksDir).filter((f) => f.startsWith(`${tid}-`) || f === `${tid}.md`);
      if (tFiles.length > 0) return `execution-plan/tasks/${tFiles[0]}`;
      return null;
    };
    for (const t of tasks) {
      const tf = findTaskFile(t.id);
      if (tf) t.file = tf;
    }

    if (!tasks.length) continue;
    const phaseStatus = phase.status || 'WAITING';
    const taskStatus = ['DONE', 'REVIEW', 'BLOCKED'].includes(phaseStatus) ? phaseStatus : 'WAITING';
    for (const t of tasks) t.status = taskStatus;
    phase.tasks = tasks;
    migrated++;
  }

  const duplicateDoneShas = findDuplicateDoneShas(log);

  if (migrated === 0) {
    const human = [`log.json already exists at ${logPath} — no migration needed.`];
    warnDuplicateDoneShas(human, duplicateDoneShas);
    return {
      command: 'log init',
      exit: 0,
      human,
      data: { planDir, logPath, migrated: false, phaseCount: log.phases.length, phases: log.phases, duplicateDoneShas },
    };
  }

  writeLog(logPath, log);
  const human = [`Migrated tasks into existing ${logPath}`];
  for (const phase of log.phases) {
    const ids = (phase.tasks || []).map((t) => t.id).join(', ');
    human.push(`  [${phase.order}] ${phase.file} (${phase.status}) → tasks: ${ids || 'none'}`);
  }
  warnDuplicateDoneShas(human, duplicateDoneShas);
  return {
    command: 'log init',
    exit: 0,
    human,
    data: { planDir, logPath, migrated: true, phaseCount: log.phases.length, phases: log.phases, duplicateDoneShas },
  };
}

// Helper to resolve phase object in log.json, matching either exact phase.file,
// basename matches, or relative execution-plan/ prefix differences.
function findPhaseInLog(log, phaseFileArg) {
  let phase = log.phases.find((p) => p.file === phaseFileArg);
  if (phase) return phase;

  const normArg = path.basename(phaseFileArg);
  phase = log.phases.find((p) => path.basename(p.file) === normArg);
  if (phase) return phase;

  // Handle execution-plan-phase-N.md matching execution-plan/phase-N.md
  const phaseMatch = normArg.match(/execution-plan-phase-(\d+)\.md$/);
  if (phaseMatch) {
    const targetFile = `execution-plan/phase-${phaseMatch[1]}.md`;
    phase = log.phases.find((p) => p.file === targetFile);
    if (phase) return phase;
  }

  // Try matching with execution-plan/ prefix
  phase = log.phases.find((p) => p.file === `execution-plan/${phaseFileArg}` || p.file === `execution-plan/${normArg}`);
  if (phase) return phase;

  if (log.phases.length === 1 && (normArg === 'execution-plan.md' || normArg === 'index.md')) {
    return log.phases[0];
  }

  return null;
}

// ─── UPDATE ─────────────────────────────────────────────────────────────────

function update(positionals, taskId, { sha: shaOverride = null, allowDuplicateSha = false } = {}) {
  if (positionals.length !== 3) {
    throw new CliError(
      'USAGE',
      'Usage: pocketto-pi log update <plan_dir> <phase_file> <status> [--task <task_id>] [--sha <commit>] [--allow-duplicate-sha]',
    );
  }
  const [planDirArg, phaseFile, statusArg] = positionals;
  const planDir = resolvePlanDir(planDirArg); // accept a plan file or its directory, like `init`
  const newStatus = statusArg.toUpperCase();
  if (!VALID_SET.has(newStatus)) {
    throw new CliError('BAD_STATUS', `status must be one of [${VALID_STATUSES.join(', ')}], got '${statusArg}'.`);
  }
  if (shaOverride && !taskId) {
    throw new CliError('USAGE', '--sha requires --task <id> — it records a specific task\'s done_sha.');
  }
  if (shaOverride && newStatus !== 'DONE') {
    throw new CliError('USAGE', `--sha only applies when marking a task DONE, got status '${statusArg}'.`);
  }

  const logPath = path.join(planDir, 'log.json');
  if (!existsSync(logPath)) {
    throw new CliError('NO_LOG', `log.json not found at '${logPath}'. Run 'pocketto-pi log init' first.`);
  }

  const log = readLogChecked(logPath);
  const phase = findPhaseInLog(log, phaseFile);
  if (!phase) {
    const available = log.phases.map((p) => p.file);
    throw new CliError('PHASE_NOT_FOUND', `'${phaseFile}' not found in log. Available: ${JSON.stringify(available)}`);
  }

  let human;
  let data;

  if (!taskId && newStatus === 'DONE' && phase.status !== 'REVIEW') {
    throw new CliError(
      'INVALID_PHASE_TRANSITION',
      `Cannot advance phase '${phase.file}' directly from '${phase.status}' to 'DONE'. Phase status must be 'REVIEW' before marking 'DONE'.`
    );
  }

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
    let shaCollision = null;
    let doneSha = null;
    if (newStatus === 'DONE') {
      if (shaOverride) {
        // Normalize to the full sha so the collision check below compares like
        // with like (stored done_sha values are full 40-char rev-parse output).
        doneSha = resolveCommit(planDir, shaOverride);
        if (!doneSha) {
          throw new CliError('UNKNOWN_SHA', `--sha '${shaOverride}' is not a commit in '${planDir}'.`);
        }
        // done_sha must sit on the current branch history — the phase-level
        // pass's <prev_sha>..<done_sha> ranges assume a linear first-parent chain.
        if (!isAncestorOfHead(planDir, doneSha)) {
          throw new CliError(
            'SHA_NOT_ANCESTOR',
            `--sha '${shaOverride}' is not an ancestor of HEAD — pass a commit on the current branch history ` +
              `(e.g. this task's own merge commit from 'git log --merges --oneline').`,
          );
        }
      } else {
        doneSha = getGitSha(planDir);
      }
      if (doneSha) {
        // A sibling task in this phase already carries this exact SHA — the
        // signature of a collapsed parallel-group merge. When parallel tasks
        // are merged in a batch and only logged afterwards, every `log update`
        // captures the same final HEAD (one merge commit) instead of each
        // task's own merge commit, which silently empties the phase-level
        // pass's per-task diff range (<prev_sha>..<done_sha>) for the 2nd+ task.
        // Refuse before anything is written, unless --allow-duplicate-sha
        // deliberately accepts it (a task that produced no new commit).
        const dupes = (phase.tasks || [])
          .filter((t) => t.id !== task.id && t.done_sha === doneSha)
          .map((t) => t.id);
        if (dupes.length && !allowDuplicateSha) {
          throw new CliError(
            'DUPLICATE_DONE_SHA',
            `done_sha ${doneSha} is already recorded for ${dupes.join(', ')} in '${phaseFile}' — nothing written. ` +
              `Merge and log parallel tasks one at a time; to repair, re-run with --sha <${task.id}'s own merge commit> ` +
              `(find it via 'git log --merges --oneline'). If ${task.id} legitimately produced no new commit, ` +
              `re-run with --allow-duplicate-sha.`,
            {
              exitCode: 1,
              human: [
                `done_sha ${doneSha} is already recorded for ${dupes.join(', ')} in this phase — refusing to mark ${task.id} DONE.`,
                `Nothing was written to log.json.`,
                ``,
                `Cause: a parallel group was merged in a batch and logged afterwards, so this update`,
                `captured the same HEAD (the final merge commit) as a sibling task. The phase-level pass diffs`,
                `each task as <prev_sha>..<done_sha>, so a duplicate done_sha silently empties the 2nd+`,
                `task's review range and the task goes unreviewed.`,
                ``,
                `Fix — record ${task.id}'s own merge commit instead of HEAD:`,
                `  1. git log --merges --oneline            # find the "Merge ${task.id}" commit`,
                `  2. pocketto-pi log update ${planDir} ${phaseFile} DONE --task ${task.id} --sha <merge_sha>`,
                ``,
                `If ${task.id} legitimately produced no new commit (no-change task), re-run with`,
                `--allow-duplicate-sha — pocket-development will preserve its empty-diff skip stub.`,
              ].join('\n'),
            },
          );
        }
        if (dupes.length) shaCollision = dupes;
      }
    }
    task.status = newStatus;
    if (doneSha) task.done_sha = doneSha;
    writeLog(logPath, log);
    human = [`Updated ${phase.file} / ${task.id} (${task.name}): ${oldStatus} → ${newStatus}`];
    if (shaCollision) {
      human.push(
        `⚠ done_sha ${task.done_sha} is already recorded for ${shaCollision.join(', ')} in this phase.`,
        `  Recorded anyway because --allow-duplicate-sha was passed — pocket-development will preserve`,
        `  the skip stub for ${task.id}'s empty diff range instead of dispatching an auditor.`,
      );
    }
    data = {
      planDir,
      phaseFile: phase.file,
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
    human = [`Updated ${phase.file}: ${oldStatus} → ${newStatus}`];
    data = { planDir, phaseFile: phase.file, level: 'phase', oldStatus, newStatus };
  }

  human.push('Current log:');
  for (const p of log.phases) {
    const marker = p.file === phase.file ? '←' : ' ';
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
  const log = readLogChecked(logPath);
  const phase = findPhaseInLog(log, phaseFile);
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
        phaseFile: phase.file,
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
      human: [`Correction ${sha} is already recorded on ${phase.file} — no-op.`],
      data: {
        planDir,
        phaseFile: phase.file,
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

  const human = [`Recorded correction ${sha} on ${phase.file}${forId ? ` (for ${forId})` : ''}: ${files.length} file(s).`];
  if (bleedTasks.length) {
    human.push(
      `⚠ this correction also touches files owned by ${bleedTasks.join(', ')} (cross-task bleed).`,
      `  The phase-level pass will refresh verdicts for those tasks. See design: full attribution.`,
    );
  }
  return {
    command: 'log update',
    exit: 0,
    human,
    data: {
      planDir,
      phaseFile: phase.file,
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

  const log = readLogChecked(logPath);
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

function run({ sub, positionals, task, correction, forTask, sha, allowDuplicateSha }) {
  if (sub === 'init') return init(positionals);
  if (sub === 'update') {
    if (correction) {
      if (sha) {
        throw new CliError('USAGE', `--sha cannot be combined with --correction (pass the sha as --correction's value).`);
      }
      return recordCorrection(positionals, correction, forTask);
    }
    return update(positionals, task, { sha, allowDuplicateSha });
  }
  if (sub === 'close') return close(positionals);
  throw new CliError('UNKNOWN_SUBCOMMAND', `Unknown 'log' subcommand: ${sub || '(none)'}. Use init | update | close.`);
}

module.exports = { run };
