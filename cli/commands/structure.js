'use strict';

// Port of pocket-structure.py — splits a pocket-planning execution plan into
// bounded per-task files + index manifest (+ phase manifests if multi-phase).

const path = require('node:path');
const crypto = require('node:crypto');
const { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, renameSync, mkdtempSync } = require('node:fs');
const { CliError } = require('../lib/envelope');

const THRESHOLD = 7;
const PHASE_MIN = 3;
const PHASE_MAX = 6;

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ─── PARSING ────────────────────────────────────────────────────────────────

function parsePlan(planPath) {
  const text = readFileSync(planPath, 'utf8');
  const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const fm = text.match(/^# EXECUTION PLAN — (.+)$/m);
  const dm = text.match(/\*\*Date:\*\* (.+)/);
  const sm = text.match(/\*\*Spec:\*\* (.+)/);
  return {
    feature: fm ? fm[1].trim() : 'Unknown Feature',
    date: dm ? dm[1].trim() : 'UNKNOWN',
    spec: sm ? sm[1].trim() : 'UNKNOWN',
    sha256,
    tasks: parseTasks(text),
  };
}

function parseTasks(text) {
  const ppm = text.match(/^## Pocket Packets\s*$/m);
  if (!ppm) return {};

  const summaryMatch = text.match(/^## Plan Summary\s*$/m);
  const sectionStart = ppm.index + ppm[0].length;
  const sectionEnd = summaryMatch ? summaryMatch.index : text.length;
  const section = text.slice(sectionStart, sectionEnd);

  const headerRe = /^### Task (\d+): (.+?) (\[[^\]]+\](?:\s*\[[^\]]+\])*)\s*$/gm;
  const matches = [...section.matchAll(headerRe)];

  const tasks = {};
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const num = parseInt(m[1], 10);
    const tid = `T${num}`;
    const name = m[2].trim();
    const annotation = m[3].trim();

    const bodyStart = m.index + m[0].length;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : section.length;
    let body = section.slice(bodyStart, bodyEnd);
    body = body.replace(/^\s*---\s*/, '').replace(/\s*---\s*$/, '').trim();

    const { deps, parallelTarget } = parseAnnotation(annotation);
    const slug = slugify(name);
    const filename = `${tid}${slug ? '-' + slug : ''}.md`;
    tasks[tid] = { id: tid, num, name, annotation, deps, parallelTarget, body, slug, filename };
  }
  return tasks;
}

function parseAnnotation(annotation) {
  const brackets = [...annotation.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
  let deps = [];
  let parallelTarget = null;
  for (const part of brackets) {
    if (part === 'prereq') {
      // no-op — no dependencies
    } else if (part.startsWith('depends:')) {
      const incoming = part.slice('depends:'.length).trim().split(',')
        .map((d) => d.trim()).filter(Boolean);
      deps = [...new Set([...deps, ...incoming])];
    } else if (part.startsWith('parallel:')) {
      const target = part.slice('parallel:'.length).trim();
      if (target) parallelTarget = target;
    }
  }
  return { deps, parallelTarget };
}

// ─── DEPTH COMPUTATION ──────────────────────────────────────────────────────

function computeDepths(tasks) {
  const depths = {};
  const visiting = new Set();
  function depthOf(tid) {
    if (tid in depths) return depths[tid];
    if (!(tid in tasks)) throw new CliError('UNKNOWN_TASK_REF', `Unknown task reference: ${tid}`);
    if (visiting.has(tid)) {
      throw new CliError('CYCLE_DETECTED', `Circular dependency involving: ${tid}`);
    }
    visiting.add(tid);
    const task = tasks[tid];
    let d;
    if (task.parallelTarget) d = depthOf(task.parallelTarget);
    else if (task.deps.length === 0) d = 0;
    else d = Math.max(...task.deps.map((dep) => depthOf(dep))) + 1;
    visiting.delete(tid);
    depths[tid] = d;
    return d;
  }
  for (const tid of Object.keys(tasks)) depthOf(tid);
  return depths;
}

// ─── EXECUTION FLOW ──────────────────────────────────────────────────────────

function formatExecutionFlow(tasks, depths) {
  const byDepth = {};
  for (const [tid, d] of Object.entries(depths)) (byDepth[d] ||= []).push(tid);
  const levels = Object.keys(byDepth).map(Number).sort((a, b) => a - b);
  return levels
    .map((d) => {
      const ids = byDepth[d].sort((a, b) => tasks[a].num - tasks[b].num);
      const joined = ids.join(',');
      return ids.length > 1 ? `${joined}(PARALLEL)` : joined;
    })
    .join('→');
}

// ─── PHASE SPLITTING ────────────────────────────────────────────────────────

function chunkArray(array, minSize, maxSize) {
  const chunks = [];
  let index = 0;
  while (index < array.length) {
    let size = maxSize;
    const remaining = array.length - (index + size);
    if (remaining > 0 && remaining < minSize) {
      size = Math.max(minSize, array.length - index - minSize);
    }
    chunks.push(array.slice(index, index + size));
    index += size;
  }
  return chunks;
}

function splitPhases(tasks, depths) {
  const byDepth = {};
  for (const [tid, d] of Object.entries(depths)) (byDepth[d] ||= []).push(tid);
  for (const d of Object.keys(byDepth)) byDepth[d].sort((a, b) => tasks[a].num - tasks[b].num);

  const depthLevels = Object.keys(byDepth).map(Number).sort((a, b) => a - b);
  const phases = [];
  let current = [];
  let currentSet = new Set();

  for (let i = 0; i < depthLevels.length; i++) {
    const d = depthLevels[i];
    const levelTasks = byDepth[d];

    if (levelTasks.length > PHASE_MAX) {
      if (current.length > 0) {
        phases.push([...current]);
        current = [];
        currentSet = new Set();
      }
      const chunks = chunkArray(levelTasks, PHASE_MIN, PHASE_MAX);
      for (const chunk of chunks) {
        phases.push(chunk);
      }
      continue;
    }

    if (current.length + levelTasks.length > PHASE_MAX && current.length >= PHASE_MIN) {
      phases.push([...current]);
      current = [];
      currentSet = new Set();
    }

    current.push(...levelTasks);
    for (const t of levelTasks) currentSet.add(t);

    const isLast = i === depthLevels.length - 1;
    if (isLast) {
      if (current.length > PHASE_MAX) {
        const chunks = chunkArray(current, PHASE_MIN, PHASE_MAX);
        for (const chunk of chunks) phases.push(chunk);
      } else {
        phases.push([...current]);
      }
      break;
    }

    if (current.length >= PHASE_MIN) {
      const nextTasks = byDepth[depthLevels[i + 1]];
      const isSeam = nextTasks.every((ntid) => tasks[ntid].deps.every((dep) => currentSet.has(dep)));
      if (isSeam || current.length >= PHASE_MAX) {
        phases.push([...current]);
        current = [];
        currentSet = new Set();
      }
    }
  }

  // Post-processing: rebalance trailing phase if < PHASE_MIN and previous phase can share
  if (phases.length > 1) {
    const lastIdx = phases.length - 1;
    if (phases[lastIdx].length < PHASE_MIN) {
      const prevIdx = lastIdx - 1;
      const combined = [...phases[prevIdx], ...phases[lastIdx]];
      if (combined.length <= PHASE_MAX) {
        phases[prevIdx] = combined;
        phases.pop();
      } else {
        // Find a valid split point that obeys PHASE_MIN <= size <= PHASE_MAX for both
        let splitPoint = Math.ceil(combined.length / 2);
        if (splitPoint < PHASE_MIN) splitPoint = PHASE_MIN;
        if (combined.length - splitPoint < PHASE_MIN) splitPoint = combined.length - PHASE_MIN;
        if (splitPoint <= PHASE_MAX && (combined.length - splitPoint) <= PHASE_MAX) {
          phases[prevIdx] = combined.slice(0, splitPoint);
          phases[lastIdx] = combined.slice(splitPoint);
        }
      }
    }
  }

  return phases;
}

// ─── RENDERERS ──────────────────────────────────────────────────────────────

function renderIndexFile(plan, tasks, phaseGroups, executionFlow, sourceBasename) {
  const totalPhases = phaseGroups.length;
  const totalTasks = Object.keys(tasks).length;

  let phaseSummarySection = '';
  if (totalPhases > 1) {
    const phaseSummaryLines = phaseGroups.map((pTaskIds, idx) => {
      const pNum = idx + 1;
      const name = tasks[pTaskIds[0]].name;
      return `- **Phase ${pNum}:** [phase-${pNum}.md](phase-${pNum}.md) — ${name} (${pTaskIds.join(', ')})`;
    }).join('\n');
    phaseSummarySection = `## Phase Summary\n\n${phaseSummaryLines}\n\n---\n\n`;
  }

  const taskTableRows = Object.values(tasks)
    .sort((a, b) => a.num - b.num)
    .map((t) => {
      const phaseNum = phaseGroups.findIndex((ids) => ids.includes(t.id)) + 1;
      return `| ${t.id} | ${t.name} | Phase ${phaseNum} | [${t.filename}](tasks/${t.filename}) | ${t.annotation} |`;
    })
    .join('\n');

  return `# ${plan.feature} — Execution Index

**Date:** ${plan.date}
**Spec:** ${plan.spec}
**Source Plan:** ../${sourceBasename}
**source-sha256:** ${plan.sha256}
**Total Tasks:** ${totalTasks}
**Total Phases:** ${totalPhases}

---

## Execution Flow

\`\`\`
${executionFlow}
\`\`\`

---

${phaseSummarySection}## Task Index

| Task ID | Name | Phase | Task File | Annotation |
|---|---|---|---|---|
${taskTableRows}
`;
}

function renderPhaseFile(phaseIdx, totalPhases, phaseTaskIds, name, tasks, plan, sourceBasename) {
  const phaseNum = phaseIdx + 1;
  const prevReq = phaseIdx > 0
    ? `Phase ${phaseIdx} must be COMPLETE — all tests green, all commits created`
    : 'None (first phase)';
  const unlocks = phaseIdx + 1 < totalPhases
    ? `Phase ${phaseIdx + 2}`
    : 'All phases complete — proceed to final validation';

  const taskListLines = phaseTaskIds
    .map((tid) => {
      const t = tasks[tid];
      return `- **${tid}:** ${t.name} ${t.annotation} → [tasks/${t.filename}](tasks/${t.filename})`;
    })
    .join('\n');
  const taskIdsStr = phaseTaskIds.join(', ');
  const nextPhaseLabel = phaseIdx + 1 < totalPhases ? `Phase ${phaseIdx + 2}` : '(none — all phases complete)';

  return `# ${plan.feature} — ${name} (Phase ${phaseNum} of ${totalPhases})

**Date:** ${plan.date}
**Original plan:** ../${sourceBasename}
**Prerequisite:** ${prevReq}
**Contains tasks:** {${taskIdsStr}}
**Unlocks next:** ${unlocks}

---

## Task List

Total: ${phaseTaskIds.length} tasks | Prerequisite phases must be complete before starting

${taskListLines}

---

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to ${nextPhaseLabel} ONLY after this gate passes.
`;
}

function renderTaskFile(task, phaseNum, tasks, sourceBasename) {
  const depsStr = task.deps.length ? task.deps.join(', ') : 'none';
  return `# Task ${task.id} — ${task.name}

**Phase:** ${phaseNum}
**Depends:** ${depsStr}
**Source plan:** ../../${sourceBasename}

---

### Pocket Packet

### Task ${task.num}: ${task.name} ${task.annotation}

${task.body}
`;
}

// ─── RUN ────────────────────────────────────────────────────────────────────

function run({ planArg, dryRun, force }) {
  if (!planArg) {
    throw new CliError('USAGE', 'Usage: pocketto-pi structure <execution-plan.md> [--dry-run] [--force]');
  }

  const planPath = path.resolve(planArg);
  if (!existsSync(planPath)) throw new CliError('FILE_NOT_FOUND', `${planPath} not found`);

  const planDir = path.dirname(planPath);
  const sourceBasename = path.basename(planPath);
  const plan = parsePlan(planPath);
  const tasks = plan.tasks;
  const count = Object.keys(tasks).length;

  const targetExecPlanDir = path.join(planDir, 'execution-plan');
  const indexFilePath = path.join(targetExecPlanDir, 'index.md');

  // Check if source-sha256 and Source Plan basename match existing index.md
  let sourceChanged = true;
  if (existsSync(indexFilePath)) {
    const existingIndexText = readFileSync(indexFilePath, 'utf8');
    const matchSha = existingIndexText.match(/\*\*source-sha256:\*\* ([a-f0-9]{64})/);
    const matchSource = existingIndexText.match(/\*\*Source Plan:\*\* \.\.\/(.+)$/m);
    if (matchSha && matchSha[1] === plan.sha256 && matchSource && matchSource[1].trim() === sourceBasename) {
      sourceChanged = false;
    }
  }

  // Refusal policy for active execution log on source plan change
  const logJsonPath = path.join(planDir, 'log.json');
  if (sourceChanged && existsSync(logJsonPath)) {
    try {
      const logData = JSON.parse(readFileSync(logJsonPath, 'utf8'));
      const hasProgress = (logData.phases || []).some((p) =>
        p.status === 'DONE' ||
        p.status === 'REVIEW' ||
        p.status === 'BLOCKED' ||
        (p.tasks || []).some((t) => t.status === 'DONE' || t.status === 'REVIEW' || t.status === 'BLOCKED' || t.done_sha) ||
        (p.corrections && p.corrections.length > 0)
      );

      if (hasProgress && !force) {
        throw new CliError(
          'ACTIVE_PLAN_PROGRESS_EXISTS',
          `Source plan '${sourceBasename}' changed while execution progress exists in '${logJsonPath}' (tasks or phases are DONE/REVIEW/BLOCKED). ` +
            `Regenerating layout is refused to prevent topology drift. Re-run with --force to override if intentional.`
        );
      } else if (logData.header && logData.header.status === 'IN_PROGRESS' && !force) {
        throw new CliError(
          'ACTIVE_PLAN_SOURCE_CHANGED',
          `Source plan '${sourceBasename}' changed while execution log at '${logJsonPath}' is IN_PROGRESS. ` +
            `Regenerating layout will alter task topology. Re-run with --force to override if intentional.`
        );
      }
    } catch (err) {
      if (err instanceof CliError) throw err;
      // If log.json is invalid JSON, ignore and proceed
    }
  }

  const human = [`Plan: ${plan.feature}`, `Tasks found: ${count}`];
  if (!sourceChanged) {
    human.push('Source plan sha256 unchanged. Generated layout is up-to-date.');
  } else if (existsSync(indexFilePath)) {
    human.push('Source plan sha256 changed. Re-generating execution-plan layout.');
  }

  if (count === 0) {
    throw new CliError(
      'NO_TASKS',
      'no tasks parsed. Check that the plan uses ### Task N: name [annotation] headers.',
    );
  }

  const depths = computeDepths(tasks);
  const maxDepth = Math.max(...Object.values(depths));

  human.push('Depth table:');
  const depthTable = {};
  for (let d = 0; d <= maxDepth; d++) {
    const tids = Object.keys(depths)
      .filter((tid) => depths[tid] === d)
      .sort((a, b) => tasks[a].num - tasks[b].num);
    if (tids.length) {
      human.push(`  Depth ${d}: ${tids.join(', ')}`);
      depthTable[d] = tids;
    }
  }
  human.push('');

  const executionFlow = formatExecutionFlow(tasks, depths);
  human.push(`Execution flow: ${executionFlow}`, '');

  const phaseGroups = count < THRESHOLD ? [[...Object.keys(tasks)]] : splitPhases(tasks, depths);
  const totalPhases = phaseGroups.length;

  const tempExecPlanDir = mkdtempSync(path.join(planDir, '.execution-plan-tmp-'));

  const indexContent = renderIndexFile(plan, tasks, phaseGroups, executionFlow, sourceBasename);
  const tasksToRender = [];
  const phasesToRender = [];

  for (let i = 0; i < phaseGroups.length; i++) {
    const ids = phaseGroups[i];
    const phaseNum = i + 1;
    const name = tasks[ids[0]].name;

    if (totalPhases > 1) {
      const phaseContent = renderPhaseFile(i, totalPhases, ids, name, tasks, plan, sourceBasename);
      phasesToRender.push({
        phaseNum,
        name,
        ids,
        filename: `phase-${phaseNum}.md`,
        content: phaseContent,
      });
    }

    for (const tid of ids) {
      const task = tasks[tid];
      const taskContent = renderTaskFile(task, phaseNum, tasks, sourceBasename);
      tasksToRender.push({
        tid,
        filename: task.filename,
        content: taskContent,
        phaseNum,
      });
    }
  }

  if (!dryRun) {
    if (!sourceChanged) {
      rmSync(tempExecPlanDir, { recursive: true, force: true });
    } else {
      const backupDir = path.join(planDir, `.execution-plan-backup-${Date.now()}`);
      try {
        mkdirSync(path.join(tempExecPlanDir, 'tasks'), { recursive: true });
        writeFileSync(path.join(tempExecPlanDir, 'index.md'), indexContent, 'utf8');

        for (const p of phasesToRender) {
          writeFileSync(path.join(tempExecPlanDir, p.filename), p.content, 'utf8');
        }

        for (const t of tasksToRender) {
          writeFileSync(path.join(tempExecPlanDir, 'tasks', t.filename), t.content, 'utf8');
        }

        if (existsSync(targetExecPlanDir)) {
          renameSync(targetExecPlanDir, backupDir);
        }
        renameSync(tempExecPlanDir, targetExecPlanDir);
        if (existsSync(backupDir)) {
          rmSync(backupDir, { recursive: true, force: true });
        }
      } catch (err) {
        if (existsSync(backupDir) && !existsSync(targetExecPlanDir)) {
          renameSync(backupDir, targetExecPlanDir);
        }
        if (existsSync(tempExecPlanDir)) {
          rmSync(tempExecPlanDir, { recursive: true, force: true });
        }
        throw new CliError('WRITE_FAILED', `Failed to atomically write execution-plan directory: ${err.message}`);
      }
    }
  } else {
    rmSync(tempExecPlanDir, { recursive: true, force: true });
  }

  human.push('STRUCTURING COMPLETE' + (dryRun ? ' (dry run — no files written)' : ''));
  human.push(`Original plan: ${count} tasks → ${totalPhases} phase(s)`, '');

  const phasesOutput = [];
  for (let i = 0; i < phaseGroups.length; i++) {
    const ids = phaseGroups[i];
    const name = tasks[ids[0]].name;
    const phaseNum = i + 1;
    const file = totalPhases > 1 ? `execution-plan/phase-${phaseNum}.md` : 'execution-plan/index.md';
    const absPath = path.join(planDir, file);
    human.push(`Phase ${phaseNum} — ${name}: ${ids.join(', ')} (${ids.length} tasks)`);
    if (!dryRun) human.push(`  → ${absPath}`);
    phasesOutput.push({
      phase: phaseNum,
      name,
      tasks: ids,
      file,
      path: absPath,
    });
  }

  if (!dryRun) human.push(`Files saved to: ${targetExecPlanDir}`);
  human.push('', 'Ready to start with pocket-development?');

  return {
    command: 'structure',
    exit: 0,
    human,
    data: {
      feature: plan.feature,
      date: plan.date,
      spec: plan.spec,
      sha256: plan.sha256,
      sourceChanged,
      taskCount: count,
      threshold: THRESHOLD,
      action: totalPhases > 1 ? 'split' : 'single',
      dryRun: !!dryRun,
      executionFlow,
      phaseCount: totalPhases,
      depthTable,
      phases: phasesOutput,
      planFile: planPath,
      execPlanDir: targetExecPlanDir,
    },
  };
}

module.exports = { run };
