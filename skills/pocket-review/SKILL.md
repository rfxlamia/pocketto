---
name: pocket-review
description: Post-phase batch reviewer. User invokes after pocket-development marks all phase tasks DONE. Main agent runs preflight and dispatches parallel reviewer subagents (one per task). Returns PHASE_REVIEWED or PHASE_BLOCKED.
---

# Pocket Review

Post-phase batch reviewer. Invoked directly by the user after pocket-development finishes a phase or flat plan.

**Core principle:** Main agent delegates. Subagents review. One subagent per task, all parallel.

## Position in Pocket Bundle

```
pocket-grinding → pocket-planning → pocket-structuring → pocket-development → POCKET-REVIEW → pocket-closing
                                                                                    ↑
                                                                          User invokes here
                                                                     after phase/plan completes
```

pocket-review is **invoked directly by the user** — not by pocket-development. When pocket-development finishes a phase, it emits a handoff message. The user then spawns pocket-review.

## Invocation

```
/pocketto:pocket-review <path-to-execution-plan-or-plan-dir>
```

Examples:
```
/pocketto:pocket-review docs/pocket/plans/2026-05-28-auth/execution-plan.md
/pocketto:pocket-review docs/pocket/plans/2026-05-28-auth/execution-plan-phase-1.md
/pocketto:pocket-review docs/pocket/plans/2026-05-28-auth/
```

## Main Agent Role (HARDENED)

Main agent = **Delegator + Preflight only**. Does NOT review code.

| Main agent MUST | Main agent MUST NOT |
|-----------------|---------------------|
| Run preflight and validate log.json | Read implementation files or assess code |
| Compute SHA ranges per task via git diff | Evaluate spec compliance or code quality |
| Dispatch ALL reviewer subagents in one parallel call | Re-dispatch implementers (no loop in batch mode) |
| Collect subagent results and write review JSON files | Interpret subagent findings beyond what they report |
| Print summary table | Update log.json status (leave to user or pocket-closing) |

## Preflight

Run ALL steps before dispatching any subagent. Failure in steps 1–2 → PHASE_BLOCKED immediately.

### Step 1: Resolve plan_dir and phase_file

```
If invoked with a file path → plan_dir = parent dir, phase_file = filename
If invoked with a dir path → scan for execution-plan*.md, use the only/first match
```

### Step 2: Read log.json

```
<plan_dir>/log.json
```

Verify:
- File exists → else `PHASE_BLOCKED: "log.json not found at <path>"`
- `header.baseline_sha` is a non-null string → else `PHASE_BLOCKED: "baseline_sha missing in log.json header"`
- `phases[N].tasks` array exists for the target phase

### Step 3: Build reviewable task list

Iterate tasks in plan order. For each task:

```
prev_sha = header.baseline_sha           (for the first task)
         = previous_task.done_sha        (for subsequent tasks)

files_changed = git diff --name-only <prev_sha>..<task.done_sha>
```

| Condition | Action |
|-----------|--------|
| `task.status != "DONE"` | Skip — log: `"T{id} not DONE (status: {status}) — skipped"` |
| `task.done_sha` missing or null | Skip — log: `"T{id} missing done_sha — skipped"` |
| `files_changed` is empty | Skip — log: `"T{id} SHA range <prev>..<done> has no file changes — skipped"` |

If zero tasks are reviewable → `PHASE_BLOCKED: "No reviewable tasks found. Ensure all tasks are DONE with done_sha."`.

### Step 4: Extract task context from plan file

For each reviewable task, read the plan file and extract:
- `DELIVERABLE` section (under `### Task N: Name`)
- `spec_ref` — the spec file the task references (absolute path)
- `quality_bar` — must-have, must-not-have, red flags

### Step 5: Ensure reviews/ directory exists

```bash
mkdir -p <plan_dir>/reviews/
```

### Step 6: Load reviewer reference file paths

Note absolute paths — these are passed to subagents:
```
<skill_dir>/references/spec-compliance-review.md
<skill_dir>/references/code-quality-review.md
<skill_dir>/references/review-report-template.md
```

## Dispatch (Parallel)

After all preflight steps pass, load `references/subagent-dispatch-template.md` to get the exact prompt structure.

Construct one review packet per reviewable task. Then dispatch ALL subagents in a **single message** (one Agent tool call per task, all in the same response).

**Subagent type:** `code-reviewer`

**Never dispatch sequentially.** All tasks go in one parallel batch.

## Collect and Write

After ALL subagents complete:

1. For each subagent result:
   - Parse the JSON output from the subagent
   - Write to `<plan_dir>/reviews/<task_id>-review.json`
   - If subagent could not complete → write a REVIEW_BLOCKED stub entry

2. Print summary table:

```
PHASE REVIEW COMPLETE — <phase_file>
──────────────────────────────────────────
T1  <task_name>          REVIEW_PASS
T2  <task_name>          REVIEW_FAIL   ← issues found
T3  <task_name>          skipped (no file changes)
──────────────────────────────────────────
Pass: 1  Issues: 1  Skipped: 1
```

3. For each REVIEW_FAIL task, print the `fix_instructions` from the report.

## Output States

| State | Meaning |
|-------|---------|
| PHASE_REVIEWED | All reviewable tasks reviewed — pass or issues |
| PHASE_BLOCKED | Preflight failed — cannot review |

**No review loop in batch mode.** If issues are found (REVIEW_FAIL in JSON), fix the code and re-run pocket-review.
Re-running overwrites existing `reviews/<task_id>-review.json` files.

## Iron Laws

```
1. NO CODE READING BY MAIN AGENT
   Only subagents read implementation files.
   WHY: Main agent is delegator, not reviewer. Self-review defeats the independence principle.

2. NO SEQUENTIAL DISPATCH
   All subagents dispatched in one parallel Agent call.
   WHY: Reviews are independent per task. Serial dispatch wastes time.

3. NO LOOP
   One review per run. Fix issues, then re-run.
   WHY: No implementer to re-dispatch to. Batch mode is observe-and-report only.

4. NO SILENT BLOCK
   Every PHASE_BLOCKED includes: what failed, why, what would unblock.
```

## Sample log.json (Valid Preflight Input)

```json
{
  "header": {
    "plan_dir": "docs/pocket/plans/2026-05-28-auth",
    "plan_type": "flat",
    "status": "IN_PROGRESS",
    "date_started": "2026-05-28",
    "date_completed": null,
    "baseline_sha": "abc1234def5678"
  },
  "phases": [
    {
      "order": 1,
      "file": "execution-plan.md",
      "status": "DONE",
      "tasks": [
        { "id": "T1", "name": "Extract auth layer",    "status": "DONE", "done_sha": "bcd2345efg6789" },
        { "id": "T2", "name": "Add token validation",  "status": "DONE", "done_sha": "cde3456fgh7890" },
        { "id": "T3", "name": "Write integration tests","status": "DONE", "done_sha": "def4567ghi8901" }
      ]
    }
  ]
}
```

SHA ranges computed:
- T1: `abc1234def5678..bcd2345efg6789`
- T2: `bcd2345efg6789..cde3456fgh7890`
- T3: `cde3456fgh7890..def4567ghi8901`

## Reference Files

| Reference | When to Load |
|-----------|--------------|
| `references/subagent-dispatch-template.md` | Before dispatching — exact prompt structure per task |
| `references/spec-compliance-review.md` | Pass absolute path to subagent prompt |
| `references/code-quality-review.md` | Pass absolute path to subagent prompt |
| `references/review-report-template.md` | Pass absolute path to subagent prompt |
