'use strict';

// Port of pocket-structure.py — splits a pocket-planning execution plan into
// bounded phase files. Semantics preserved exactly:
//   THRESHOLD=7, PHASE_MIN=3, PHASE_MAX=6, depth computation, seam detection,
//   phase-file format, passthrough (<7 tasks) vs split (>=7).

const path = require('node:path');
const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const { CliError } = require('../lib/envelope');

const THRESHOLD = 7;
const PHASE_MIN = 3;
const PHASE_MAX = 6;

// ─── PARSING ────────────────────────────────────────────────────────────────

function parsePlan(planPath) {
  const text = readFileSync(planPath, 'utf8');
  const fm = text.match(/^# EXECUTION PLAN — (.+)$/m);
  const dm = text.match(/\*\*Date:\*\* (.+)/);
  const sm = text.match(/\*\*Spec:\*\* (.+)/);
  return {
    feature: fm ? fm[1].trim() : 'Unknown Feature',
    date: dm ? dm[1].trim() : 'UNKNOWN',
    spec: sm ? sm[1].trim() : 'UNKNOWN',
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

  const headerRe = /^### Task (\d+): (.+?) \[(.+?)\]\s*$/gm;
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
    tasks[tid] = { id: tid, num, name, annotation, deps, parallelTarget, body };
  }
  return tasks;
}

function parseAnnotation(annotation) {
  if (annotation === 'prereq') return { deps: [], parallelTarget: null };
  if (annotation.startsWith('depends:')) {
    const raw = annotation.slice('depends:'.length).trim();
    return { deps: raw.split(',').map((d) => d.trim()), parallelTarget: null };
  }
  if (annotation.startsWith('parallel:')) {
    return { deps: [], parallelTarget: annotation.slice('parallel:'.length).trim() };
  }
  return { deps: [], parallelTarget: null };
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

// ─── PHASE SPLITTING ────────────────────────────────────────────────────────

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
    current.push(...byDepth[d]);
    for (const t of byDepth[d]) currentSet.add(t);

    const isLast = i === depthLevels.length - 1;
    if (isLast) {
      phases.push([...current]); // terminal phase can be < PHASE_MIN
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
  return phases;
}

// ─── PHASE FILE GENERATION ──────────────────────────────────────────────────

function writePhaseFile(phaseIdx, totalPhases, phaseTaskIds, name, tasks, plan, planRef, planDir, dryRun) {
  const phaseNum = phaseIdx + 1;
  const prevReq = phaseIdx > 0
    ? `Phase ${phaseIdx} must be COMPLETE — all tests green, all commits created`
    : 'None (first phase)';
  const unlocks = phaseIdx + 1 < totalPhases
    ? `Phase ${phaseIdx + 2}`
    : 'All phases complete — proceed to final validation';

  const taskListLines = phaseTaskIds
    .map((tid) => `${tid}: ${tasks[tid].name} [${tasks[tid].annotation}]`)
    .join('\n');
  const taskIdsStr = phaseTaskIds.join(', ');

  const packetsStr = phaseTaskIds
    .map((tid) => {
      const t = tasks[tid];
      return `### Task ${t.num}: ${t.name} [${t.annotation}]\n\n${t.body}`;
    })
    .join('\n\n---\n\n');

  const nextPhaseLabel = phaseIdx + 1 < totalPhases ? `Phase ${phaseIdx + 2}` : '(none — all phases complete)';

  const content = `# ${plan.feature} — ${name} (Phase ${phaseNum} of ${totalPhases})

**Date:** ${plan.date}
**Original plan:** ${planRef}
**Prerequisite:** ${prevReq}
**Contains tasks:** {${taskIdsStr}}
**Unlocks next:** ${unlocks}

---

## Task List

Total: ${phaseTaskIds.length} tasks | Prerequisite phases must be complete before starting

${taskListLines}

---

## Pocket Packets

---

${packetsStr}

---

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to ${nextPhaseLabel} ONLY after this gate passes.
`;

  const outPath = path.join(planDir, `execution-plan-phase-${phaseNum}.md`);
  if (!dryRun) writeFileSync(outPath, content);
  return outPath;
}

// ─── RUN ────────────────────────────────────────────────────────────────────

function run({ planArg, dryRun }) {
  if (!planArg) {
    throw new CliError('USAGE', 'Usage: pocketto-pi structure <execution-plan.md> [--dry-run]');
  }

  const planPath = path.resolve(planArg);
  if (!existsSync(planPath)) throw new CliError('FILE_NOT_FOUND', `${planPath} not found`);

  const planRef = planArg; // original argument, echoed into phase-file headers
  const planDir = path.dirname(planPath);
  const plan = parsePlan(planPath);
  const tasks = plan.tasks;
  const count = Object.keys(tasks).length;

  const human = [`Plan: ${plan.feature}`, `Tasks found: ${count}`];

  if (count === 0) {
    throw new CliError(
      'NO_TASKS',
      'no tasks parsed. Check that the plan uses ### Task N: name [annotation] headers.',
    );
  }

  if (count < THRESHOLD) {
    human.push(
      '',
      `Plan has ${count} tasks (<${THRESHOLD}). Pass through to pocket-development directly.`,
      `File: ${planPath}`,
    );
    return {
      command: 'structure',
      exit: 0,
      human,
      data: {
        feature: plan.feature,
        date: plan.date,
        spec: plan.spec,
        taskCount: count,
        threshold: THRESHOLD,
        action: 'passthrough',
        dryRun: !!dryRun,
        planFile: planPath,
        phases: [],
      },
    };
  }

  human.push(`Plan has ${count} tasks (≥${THRESHOLD}). Splitting into phases...`, '');

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

  const phaseGroups = splitPhases(tasks, depths);
  const total = phaseGroups.length;

  const written = [];
  for (let i = 0; i < phaseGroups.length; i++) {
    const ids = phaseGroups[i];
    const name = tasks[ids[0]].name;
    const out = writePhaseFile(i, total, ids, name, tasks, plan, planRef, planDir, dryRun);
    written.push({ name, ids, out });
  }

  human.push('STRUCTURING COMPLETE' + (dryRun ? ' (dry run — no files written)' : ''));
  human.push(`Original plan: ${count} tasks → ${total} phases`, '');

  const phases = [];
  for (let i = 0; i < written.length; i++) {
    const { name, ids, out } = written[i];
    const shortTerminal = i === total - 1 && ids.length < PHASE_MIN;
    const tag = shortTerminal ? ' ⚠ short terminal phase' : '';
    human.push(`Phase ${i + 1} — ${name}: ${ids.join(', ')} (${ids.length} tasks)${tag}`);
    if (!dryRun) human.push(`  → ${out}`);
    phases.push({
      phase: i + 1,
      name,
      tasks: ids,
      file: `execution-plan-phase-${i + 1}.md`,
      path: out,
      shortTerminal,
    });
  }

  human.push('', 'Execution order: sequential. Phase N must complete before Phase N+1.');
  if (!dryRun) human.push(`Files saved to: ${planDir}`);
  human.push('', 'Ready to start Phase 1 with pocket-development?');

  return {
    command: 'structure',
    exit: 0,
    human,
    data: {
      feature: plan.feature,
      date: plan.date,
      spec: plan.spec,
      taskCount: count,
      threshold: THRESHOLD,
      action: 'split',
      dryRun: !!dryRun,
      phaseCount: total,
      depthTable,
      phases,
      planFile: planPath,
    },
  };
}

module.exports = { run };
