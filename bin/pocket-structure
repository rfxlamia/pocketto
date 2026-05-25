#!/usr/bin/env python3
"""
pocket-structure.py — Splits a pocket-planning execution plan into phase files.

Usage:
    python3 pocket-structure.py <execution-plan.md>
    python3 pocket-structure.py <execution-plan.md> --dry-run   (print summary, no files written)

Exit codes:
    0 — success (or pass-through for ≤6 tasks)
    1 — error (file not found, parse failure)
"""

import re
import sys
from collections import defaultdict
from pathlib import Path

THRESHOLD = 7
PHASE_MIN = 3
PHASE_MAX = 6


# ─── PARSING ────────────────────────────────────────────────────────────────

def parse_plan(path: Path) -> dict:
    text = path.read_text()

    feature_m = re.search(r'^# EXECUTION PLAN — (.+)$', text, re.MULTILINE)
    date_m    = re.search(r'\*\*Date:\*\* (.+)',  text)
    spec_m    = re.search(r'\*\*Spec:\*\* (.+)',  text)

    feature = feature_m.group(1).strip() if feature_m else 'Unknown Feature'
    date    = date_m.group(1).strip()    if date_m    else 'UNKNOWN'
    spec    = spec_m.group(1).strip()    if spec_m    else 'UNKNOWN'

    tasks = parse_tasks(text)

    return {
        'feature': feature,
        'date': date,
        'spec': spec,
        'tasks': tasks,
        'plan_path': path,
    }


def parse_tasks(text: str) -> dict:
    # Isolate the Pocket Packets section
    pp_m      = re.search(r'^## Pocket Packets\s*$', text, re.MULTILINE)
    summary_m = re.search(r'^## Plan Summary\s*$',   text, re.MULTILINE)

    if not pp_m:
        return {}

    section_start = pp_m.end()
    section_end   = summary_m.start() if summary_m else len(text)
    section       = text[section_start:section_end]

    # Find each task header: ### Task N: <name> [<annotation>]
    header_re = re.compile(
        r'^### Task (\d+): (.+?) \[(.+?)\]\s*$',
        re.MULTILINE,
    )
    matches = list(header_re.finditer(section))

    tasks = {}
    for i, m in enumerate(matches):
        num        = int(m.group(1))
        tid        = f'T{num}'
        name       = m.group(2).strip()
        annotation = m.group(3).strip()

        # Body runs from end of this header to start of next header (or end of section)
        body_start = m.end()
        body_end   = matches[i + 1].start() if i + 1 < len(matches) else len(section)
        body       = section[body_start:body_end]

        # Strip leading/trailing separators and whitespace
        body = re.sub(r'^\s*---\s*', '', body)
        body = re.sub(r'\s*---\s*$', '', body)
        body = body.strip()

        deps, parallel_target = _parse_annotation(annotation)

        tasks[tid] = {
            'id': tid,
            'num': num,
            'name': name,
            'annotation': annotation,
            'deps': deps,                    # list[str] — explicit depends
            'parallel_target': parallel_target,  # str | None — for [parallel: TN]
            'body': body,
        }

    return tasks


def _parse_annotation(annotation: str) -> tuple:
    """Returns (deps: list[str], parallel_target: str | None)."""
    if annotation == 'prereq':
        return [], None
    if annotation.startswith('depends:'):
        raw  = annotation[len('depends:'):].strip()
        deps = [d.strip() for d in raw.split(',')]
        return deps, None
    if annotation.startswith('parallel:'):
        target = annotation[len('parallel:'):].strip()
        return [], target   # same depth as target, no direct dep on it
    return [], None


# ─── DEPTH COMPUTATION ──────────────────────────────────────────────────────

def compute_depths(tasks: dict) -> dict:
    depths = {}

    def depth_of(tid: str) -> int:
        if tid in depths:
            return depths[tid]
        if tid not in tasks:
            raise ValueError(f'Unknown task reference: {tid}')
        task = tasks[tid]

        if task['parallel_target']:
            # Same depth as the target (parallel sibling, not a successor)
            d = depth_of(task['parallel_target'])
        elif not task['deps']:
            d = 0
        else:
            d = max(depth_of(dep) for dep in task['deps']) + 1

        depths[tid] = d
        return d

    for tid in tasks:
        depth_of(tid)

    return depths


# ─── PHASE SPLITTING ────────────────────────────────────────────────────────

def split_phases(tasks: dict, depths: dict) -> list:
    by_depth = defaultdict(list)
    for tid, d in depths.items():
        by_depth[d].append(tid)

    # Sort each depth group by task number for determinism
    for d in by_depth:
        by_depth[d].sort(key=lambda t: tasks[t]['num'])

    depth_levels = sorted(by_depth.keys())
    phases       = []
    current      = []
    current_set  = set()

    for i, d in enumerate(depth_levels):
        current.extend(by_depth[d])
        current_set.update(by_depth[d])

        is_last = (i == len(depth_levels) - 1)

        if is_last:
            # Always finalize — terminal phase can be < PHASE_MIN
            phases.append(list(current))
            break

        if len(current) >= PHASE_MIN:
            # Seam check: every task at next depth has all deps satisfied by current_set
            next_d     = depth_levels[i + 1]
            next_tasks = by_depth[next_d]
            is_seam    = all(
                all(dep in current_set for dep in tasks[ntid]['deps'])
                for ntid in next_tasks
            )

            if is_seam or len(current) >= PHASE_MAX:
                phases.append(list(current))
                current     = []
                current_set = set()

    return phases


# ─── PHASE FILE GENERATION ──────────────────────────────────────────────────

def phase_name(phase_tasks: list, tasks: dict, phase_idx: int) -> str:
    """Simple, honest naming: descriptive label from the first task in the phase."""
    first_task = tasks[phase_tasks[0]]
    return first_task['name']


def write_phase_file(
    phase_idx: int,
    total_phases: int,
    phase_task_ids: list,
    name: str,
    tasks: dict,
    plan: dict,
    plan_ref: str,   # path string as shown in the phase file header
    dry_run: bool,
) -> Path:
    plan_path = plan['plan_path']
    plan_dir  = plan_path.parent
    feature   = plan['feature']
    date      = plan['date']

    phase_num = phase_idx + 1
    prev_req  = (
        f'Phase {phase_idx} must be COMPLETE — all tests green, all commits created'
        if phase_idx > 0
        else 'None (first phase)'
    )
    unlocks = (
        f'Phase {phase_idx + 2}'
        if phase_idx + 1 < total_phases
        else 'All phases complete — proceed to final validation'
    )

    task_list_lines = '\n'.join(
        f'{tid}: {tasks[tid]["name"]} [{tasks[tid]["annotation"]}]'
        for tid in phase_task_ids
    )

    task_ids_str = ', '.join(phase_task_ids)

    # Verbatim pocket packets
    packets = []
    for tid in phase_task_ids:
        t      = tasks[tid]
        header = f'### Task {t["num"]}: {t["name"]} [{t["annotation"]}]'
        packets.append(f'{header}\n\n{t["body"]}')
    packets_str = '\n\n---\n\n'.join(packets)

    next_phase_label = (
        f'Phase {phase_idx + 2}'
        if phase_idx + 1 < total_phases
        else '(none — all phases complete)'
    )

    content = f"""\
# {feature} — {name} (Phase {phase_num} of {total_phases})

**Date:** {date}
**Original plan:** {plan_ref}
**Prerequisite:** {prev_req}
**Contains tasks:** {{{task_ids_str}}}
**Unlocks next:** {unlocks}

---

## Task List

Total: {len(phase_task_ids)} tasks | Prerequisite phases must be complete before starting

{task_list_lines}

---

## Pocket Packets

---

{packets_str}

---

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to {next_phase_label} ONLY after this gate passes.
"""

    out_path = plan_dir / f'execution-plan-phase-{phase_num}.md'
    if not dry_run:
        out_path.write_text(content)
    return out_path


# ─── MAIN ───────────────────────────────────────────────────────────────────

def main():
    args    = sys.argv[1:]
    dry_run = '--dry-run' in args
    paths   = [a for a in args if not a.startswith('--')]

    if not paths:
        print('Usage: python3 pocket-structure.py <execution-plan.md> [--dry-run]',
              file=sys.stderr)
        sys.exit(1)

    plan_path = Path(paths[0]).resolve()
    if not plan_path.exists():
        print(f'Error: {plan_path} not found', file=sys.stderr)
        sys.exit(1)

    # Use the original argument as the plan reference string in phase files
    plan_ref = paths[0]

    plan  = parse_plan(plan_path)
    tasks = plan['tasks']
    count = len(tasks)

    print(f'Plan: {plan["feature"]}')
    print(f'Tasks found: {count}')

    if count == 0:
        print('Error: no tasks parsed. Check that the plan uses ### Task N: name [annotation] headers.',
              file=sys.stderr)
        sys.exit(1)

    if count < THRESHOLD:
        print(f'\nPlan has {count} tasks (<{THRESHOLD}). Pass through to pocket-development directly.')
        print(f'File: {plan_path}')
        sys.exit(0)

    print(f'Plan has {count} tasks (≥{THRESHOLD}). Splitting into phases...\n')

    depths = compute_depths(tasks)

    # Show depth table
    max_depth = max(depths.values())
    print('Depth table:')
    for d in range(max_depth + 1):
        tids = sorted(
            [tid for tid, depth in depths.items() if depth == d],
            key=lambda t: tasks[t]['num'],
        )
        if tids:
            print(f'  Depth {d}: {", ".join(tids)}')
    print()

    phases = split_phases(tasks, depths)
    total  = len(phases)

    # Generate and write phase files
    written = []
    for i, phase_task_ids in enumerate(phases):
        name = phase_name(phase_task_ids, tasks, i)
        out  = write_phase_file(
            i, total, phase_task_ids, name, tasks, plan, plan_ref, dry_run
        )
        written.append((name, phase_task_ids, out))

    # Summary output
    print('STRUCTURING COMPLETE' + (' (dry run — no files written)' if dry_run else ''))
    print(f'Original plan: {count} tasks → {total} phases')
    print()
    for i, (name, tids, out) in enumerate(written):
        tag = ' ⚠ short terminal phase' if i == total - 1 and len(tids) < PHASE_MIN else ''
        print(f'Phase {i + 1} — {name}: {", ".join(tids)} ({len(tids)} tasks){tag}')
        if not dry_run:
            print(f'  → {out}')
    print()
    print('Execution order: sequential. Phase N must complete before Phase N+1.')
    if not dry_run:
        print(f'Files saved to: {plan_path.parent}')
    print()
    print('Ready to start Phase 1 with pocket-development?')


if __name__ == '__main__':
    main()
