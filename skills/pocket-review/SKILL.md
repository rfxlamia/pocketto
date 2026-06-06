---
name: pocket-review
description: Post-phase batch reviewer. User invokes after pocket-development marks all phase tasks DONE. Main agent runs preflight and dispatches parallel reviewer subagents (one per task). Returns PHASE_REVIEWED or PHASE_BLOCKED; on an all-REVIEW_PASS phase it chains to pocket-closing after one confirmation.
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

On the other side, pocket-review **chains forward** to pocket-closing. When every reviewable task is `REVIEW_PASS`, it surfaces one confirmation and then invokes pocket-closing (see [Chain to pocket-closing](#chain-to-pocket-closing-conditional)) — the same auto-invoke-behind-one-confirmation pattern pocket-grinding uses for pocket-planning, not a silent close. It still never touches `log.json`; closing owns that.

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
| `files_changed` is empty | Flag for skip stub (see **Skip stub** in Step 5). Do NOT add to reviewable list; do NOT dispatch a subagent. Log: `"T{id} SHA range <prev>..<done> has no file changes — stub pending"` |

If zero tasks are reviewable (no non-empty-diff DONE tasks found) → `PHASE_BLOCKED: "No reviewable tasks found. Ensure all tasks are DONE with done_sha."`. Empty-diff tasks flagged for stubs do **not** count toward this threshold.

### Step 4: Extract task context from plan file

For each reviewable task, read the plan file and extract:
- `DELIVERABLE` section (under `### Task N: Name`)
- `spec_ref` — the spec file the task references (absolute path)
- `quality_bar` — must-have, must-not-have, red flags

### Step 5: Ensure reviews/ directory exists

```bash
mkdir -p <plan_dir>/reviews/
```

Then write a **REVIEW_PASS skip stub** for every empty-diff task flagged in Step 3.

**Skip stub.** For each `DONE + done_sha` task whose SHA range has no file changes, write this JSON to `reviews/<task_id>-review.json` **before dispatching subagents**:

```json
{
  "task_id": "<task_id>",
  "task_name": "<task_name>",
  "cycle": 1,
  "timestamp": "<UTC ISO 8601 now>",
  "reviewer_mode": "read-only",
  "reviewer_config": "batch-parallel",
  "stage_1": { "status": "PASS", "issues": [], "concerns_addressed": [] },
  "stage_2": { "status": "PASS", "strengths": [], "issues": [], "assessment": "Approved" },
  "overall": "REVIEW_PASS",
  "fix_instructions": "",
  "loop_info": { "current_cycle": 1, "max_cycles": 1, "cycles_remaining": 0 },
  "skip_reason": "no_file_changes",
  "reviewed_sha": "<task.done_sha>"
}
```

`reviewed_sha` enables pocket-closing's exact-SHA freshness check (stronger than the timestamp proxy). `skip_reason` marks the file as an auto-generated stub — not a subagent review. Without this stub, pocket-closing treats any `DONE + done_sha` task with no review file as `CLOSE_BLOCKED`.

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
T3  <task_name>          skipped (no file changes — REVIEW_PASS stub written)
──────────────────────────────────────────
Pass: 1  Issues: 1  Skipped: 1
```

3. For each REVIEW_FAIL task, print the `fix_instructions` from the report.

## Chain to pocket-closing (conditional)

After the summary table is printed, decide whether to chain into pocket-closing. This is the `review → closing` handoff — the same auto-invoke-behind-one-confirmation pattern pocket-grinding uses for pocket-planning, **not** a silent close.

**Chain ONLY when ALL of these hold:**
- Output state is `PHASE_REVIEWED` (preflight passed — never on `PHASE_BLOCKED`).
- Every reviewable task is `REVIEW_PASS` — **zero** `REVIEW_FAIL`, **zero** `REVIEW_BLOCKED` in the summary.
- Tasks skipped because `not DONE` or missing `done_sha` do **not** block the chain — pocket-closing excludes them from its gate too (they have no `done_sha` to reconcile).
- Tasks skipped because of empty diff (`DONE + done_sha + no file changes`) received a REVIEW_PASS skip stub in Step 5 — pocket-closing will find the file and reconcile them as REVIEW_PASS; they do not block closing.

If ANY task is `REVIEW_FAIL` or `REVIEW_BLOCKED`, or the run ended `PHASE_BLOCKED` → **do NOT chain.** Print the fix path (fix the code → re-run pocket-review) and stop. Closing is gated on clean verdicts; chaining a failing phase would only hit `CLOSE_BLOCKED`.

### Confirmation checkpoint (single prompt)

When the all-pass condition holds, surface the result and ask **once** before any state changes:

> "All N tasks passed review (summary above). Close `<phase_file>` now? This advances `REVIEW → DONE`, runs `log close`, and writes `closeout.md`. (yes / not yet)"

- **yes** → invoke pocket-closing (next).
- **not yet / no** → stop here. The user can run `/pocketto:pocket-closing <path>` later. State is unchanged.

Wait for the answer. Do **not** proceed on silence.

### Invoke pocket-closing

On confirmation:

**Step 1 — Identify invocation method:**
- In Claude Code: use the `Skill` tool to invoke `pocket-closing`.
- In other agent platforms: use your platform's skill/agent dispatch mechanism.
- If no dispatch mechanism exists: load and follow the `pocket-closing` skill directly in this session.

**Step 2 — Pass the plan path:** the same `<plan_dir>` / `<phase_file>` this review ran against.

**Step 3 — Let pocket-closing own the close.** It re-runs its own preflight, verdict gate, freshness check, Advance State, and `log close` from scratch. pocket-review does NOT pre-advance state or touch `log.json` (the Main Agent Role table and Iron Laws are unchanged) — it only hands off the path.

**Freshness is satisfied by construction.** Because the chain fires in the same session immediately after the reviews were written, every verdict is current for its task's `done_sha` — pocket-closing's freshness gate (its Iron Law 2) passes naturally.

**Phased plans:** if pocket-closing returns `PHASE_ADVANCED` (other phases remain), the plan is not finished — route back to pocket-development for the next phase. Do NOT loop back into closing.

## Output States

| State | Meaning |
|-------|---------|
| PHASE_REVIEWED | All reviewable tasks reviewed. All `REVIEW_PASS` → chain to pocket-closing (one confirmation). Any issue → stop, fix, re-run |
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
