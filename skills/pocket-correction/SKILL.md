---
name: pocket-correction
description: User-triggered correction stage between a pocket-review REVIEW_FAIL verdict and re-review. Delegates each failed task's fix to an implementer subagent (main agent stays Delegator + Auditor only — never writes code), records an append-only correction commit per task via the pocketto-pi CLI (done_sha never moves), and hands back for user-triggered re-review. Trigger on "pocket-correction", "apply review fixes", "fix the review failures", "correct the failed tasks", or when pocket-review reports REVIEW_FAIL in agent-managed execution.
---

# Pocket Correction

Correction stage for `REVIEW_FAIL` verdicts. Invoked directly by the user (or by an agent following pocket-review's Action Required guidance) after pocket-review has written `REVIEW_FAIL` verdicts for one or more tasks in a phase.

**Core principle:** Main agent delegates and audits. It never writes code. Every fix is a subagent's commit, one task at a time, with an append-only record that leaves `done_sha` untouched.

## Position in Pocket Bundle

```
pocket-development → pocket-review ──REVIEW_PASS──→ pocket-closing
                          │
                    REVIEW_FAIL
                          │
                    POCKET-CORRECTION   ← User invokes here
                          │
                     (re-review)
                          │
                    pocket-review (user-triggered)
```

pocket-correction is **invoked directly by the user** after pocket-review finishes and reports `REVIEW_FAIL`. It does NOT auto-chain from review. After corrections are recorded, the user triggers pocket-review again manually.

## Invocation

```
/pocketto:pocket-correction <path-to-execution-plan-or-plan-dir>
```

Examples:
```
/pocketto:pocket-correction docs/pocket/plans/2026-05-28-auth/execution-plan.md
/pocketto:pocket-correction docs/pocket/plans/2026-05-28-auth/execution-plan-phase-1.md
/pocketto:pocket-correction docs/pocket/plans/2026-05-28-auth/
```

## Main Agent Role (HARDENED)

Main agent = **Delegator + Auditor only**. Does NOT write or edit implementation code.

| Main agent MUST | Main agent MUST NOT |
|-----------------|---------------------|
| Read log.json and reviews/ to collect REVIEW_FAIL tasks | Write, patch, or suggest implementation code |
| Build a correction packet per failed task from fix_instructions | Review code itself or assess correctness |
| Delegate each fix to one implementer subagent | Dispatch multiple subagents in parallel |
| Run a quick audit after each subagent reports DONE | Accept a subagent's self-assessment without audit |
| Record each correction via the CLI | Hand-edit log.json or move done_sha |
| Emit the handoff message pointing to pocket-review | Auto-invoke pocket-review (re-review stays user-triggered) |

## When to Use

- After pocket-review writes verdicts and **one or more tasks** are `REVIEW_FAIL`.
- The phase has already reached `PHASE_COMPLETE` via pocket-development — you are **not** mid-phase.

**Do NOT use pocket-correction for:**
- `REVIEW_BLOCKED` verdicts — that requires escalation, not a fix cycle. List blocked tasks and halt.
- Tasks that are still `WAITING` or `IN_PROGRESS` — route back to pocket-development.
- A new feature that outgrew the original scope — open a new plan/issue.

## Preflight

Run ALL steps before delegating any fix.

### Step 1: Resolve plan_dir and phase_file

```
If invoked with a file path → plan_dir = parent dir, phase_file = filename
If invoked with a dir path → scan for execution-plan*.md; require exactly one match.
  Halt on 0 matches (no plan found in dir).
  Halt on >1 matches (ambiguous — re-invoke with the explicit <plan_dir>/<phase_file>).
```

### Step 2: Read log.json

```
<plan_dir>/log.json
```

Verify:
- File exists → else halt: `"log.json not found at <path>. Run pocket-development first."`
- `header.baseline_sha` is a non-null string → else halt: `"baseline_sha missing in log.json header"`
- The target phase exists in `phases[]`

### Step 3: Collect REVIEW_FAIL tasks

For each task in the target phase (plan order):

| Condition | Action |
|-----------|--------|
| `task.status != "DONE"` | Skip — this is a development concern, not a correction |
| No `reviews/<task_id>-review.json` | Skip — verdict missing; note for the user |
| `overall == "REVIEW_PASS"` | Skip — already passing |
| `overall == "REVIEW_BLOCKED"` | **Halt the entire correction cycle.** List all BLOCKED tasks, their `fix_instructions`, and the escalation path. Do NOT enter the fix loop. |
| `overall == "REVIEW_FAIL"` | Add to the correction queue with its `fix_instructions` |

If zero tasks are `REVIEW_FAIL` → report `"Nothing to correct: all reviewable tasks are REVIEW_PASS"` and stop.

If any task is `REVIEW_BLOCKED` → report all blocked tasks with escalation guidance, then stop. Do NOT loop around blocked tasks.

## Correction Loop (SEQUENTIAL, Plan Order)

Iterate the `REVIEW_FAIL` task queue **one task at a time, in plan order**. Never dispatch multiple subagents in parallel. Parallel correction collapses commits from different fixes onto the same HEAD, which re-introduces the #28 collision: `getCommitFiles` on a merged HEAD returns files from both fixes, corrupting per-task attribution in `phase.corrections`.

For each failed task **TN**:

### 1. Build the correction packet

Read:
- `reviews/<TN>-review.json` → `fix_instructions` (the authoritative list of what must change)
- The plan file → task's `DELIVERABLE` and `quality_bar`

Construct a correction packet for the implementer:
```
Task: TN — <task_name>
Fix instructions (from review): <fix_instructions verbatim>
DELIVERABLE: <from plan>
Quality bar: <from plan>
Constraint: produce exactly ONE commit containing only the source files being fixed.
```

### 2. Commit hygiene requirement (CRITICAL)

The implementer's fix commit **must contain only the source files being fixed** — it must NOT include `log.json` or any other infrastructure file.

Instruct the implementer explicitly:
- Stage files by name: `git add <file1> <file2>` — **never `git add -A` or `git add .`** while `log.json` is dirty (the CLI writes `log.json` before the subagent runs, leaving it dirty in the working tree).
- Alternative: stash or exclude `log.json` before making the fix commit; never create a separate `log.json` commit in the correction loop.
- One commit, exactly — the sha returned must be HEAD after the commit.

If `log.json` is swept into the fix commit, `getCommitFiles` on that sha includes it, and `log.json` appears in `data.correction.files`, corrupting the per-file attribution that pocket-review and pocket-closing rely on.

### 3. Delegate to one implementer subagent

Dispatch exactly **one** implementer subagent with the correction packet. Wait for it to complete and return a single commit sha.

### 4. Quick audit

After the subagent reports DONE:
- Confirm the returned sha exists: `git log <sha> -1 --oneline`
- Confirm the commit contains no infrastructure files: `git show --stat <sha>` — if `log.json` appears, **reject** the commit and re-dispatch with an explicit instruction to stage only source files.
- Run the test suite (or the task's specified test command from the plan): must still be green.
- Spot-check the DELIVERABLE: confirm the reported changes align with `fix_instructions`.

If audit fails:
- **Retryable failure** (test broke, wrong files committed): re-dispatch the implementer with the failure reason, one more time. On a second failure → treat as unresolvable.
- **Unresolvable**: record nothing for TN, mark it as **BLOCKED mid-correction**, and move to the next task in the queue.

### 5. Record the correction

```bash
npx -y pocketto-pi log update <plan_dir> <phase_file> \
  --correction <sha> \
  --for-task TN \
  --json --contract 2
```

Parse the JSON envelope (`data.correction`):
- If `data.correction.skipped == true` → the commit had no file changes; log a warning and do not count this as a successful correction.
- If `data.correction.bleed` is non-empty → note the affected tasks. Those tasks will be re-reviewed by pocket-review when the user runs it next.
- If `ok: false` → halt and report the error. Do NOT continue to the next task.

`done_sha` is never moved by this command. It is strictly append-only.

## Terminal Report

After processing all tasks, emit ONE of the following:

### All corrections recorded

```
CORRECTIONS RECORDED — <phase_file>
──────────────────────────────────────────
TN  <task_name>  correction <sha> (files: <count>)
...
──────────────────────────────────────────
Corrections recorded: N

Run: /pocketto:pocket-review <plan_dir>/<phase_file>
```

Do NOT auto-run pocket-review. Re-review is always user-triggered.

### BLOCKED mid-correction

```
CORRECTION PARTIAL — <phase_file>
──────────────────────────────────────────
TN  <task_name>  CORRECTED  <sha>
TM  <task_name>  BLOCKED    <reason>
──────────────────────────────────────────
Corrected: N  Blocked: M

The phase remains un-closeable until all blocked tasks are resolved.
Next action for each BLOCKED task: <per-task guidance>
```

A phase with any BLOCKED correction cannot be closed by pocket-closing (`CLOSE_BLOCKED`). The user must resolve the block before re-running pocket-review and eventually pocket-closing.

## Enterprise Note

Corrections are commits on the same branch — they ride the existing PR via the `create-pr` / traveling-state pattern automatically. No GitHub calls are made here; pocket-review will post updated verdicts to the PR on the next review run if enterprise mode is active.

## CLI Reference

The exact `--correction` invocation used in Step 5:

```bash
# Record a correction commit for a specific task
npx -y pocketto-pi log update <plan_dir> <phase_file> \
  --correction <sha> \
  --for-task <task_id> \
  --json --contract 2

# Example
npx -y pocketto-pi log update \
  docs/pocket/plans/2026-05-28-auth \
  execution-plan.md \
  --correction a1b2c3d \
  --for-task T2 \
  --json --contract 2
```

The envelope `data.correction` shape:

```json
{
  "sha": "<sha>",
  "files": ["<file1>", "<file2>"],
  "affectedTasks": ["T2"],
  "bleed": [],
  "idempotent": false,
  "skipped": false
}
```

- `affectedTasks` — every task attributed to this correction (`for_task` + owner-file intersection). pocket-review will re-review all of these.
- `bleed` — tasks attributed via file ownership that are NOT the `for_task`. These are touched incidentally and will be re-reviewed too.
- `idempotent: true` — the same sha was already recorded; no-op.
- `skipped: true` — commit had no file changes; not recorded.

## Output States

| State | Meaning |
|-------|---------|
| `CORRECTIONS_RECORDED` | All REVIEW_FAIL tasks corrected; user should run pocket-review |
| `CORRECTION_PARTIAL` | Some tasks corrected, others BLOCKED mid-correction; phase not closeable |
| `NOTHING_TO_CORRECT` | No REVIEW_FAIL tasks found; all tasks passing |
| `CORRECTION_BLOCKED` | One or more tasks are REVIEW_BLOCKED (escalation needed); fix cycle not entered |

## Iron Laws

```
1. NO CODE BY MAIN AGENT
   Only implementer subagents write code.
   WHY: Delegator + Auditor role. Self-correction defeats the independence of review.

2. NO PARALLEL DISPATCH
   One subagent at a time, in plan order.
   WHY: Parallel commits collapse onto the same HEAD, corrupting per-task file attribution
   and re-introducing the #28 SHA collision. Sequential order preserves clean boundaries.

3. DONE_SHA NEVER MOVES
   The --correction command is strictly append-only. It never touches done_sha.
   WHY: done_sha is the boundary pocket-review uses for SHA ranges. Moving it after
   review would silently invalidate the review evidence.

4. CLEAN COMMIT ONLY
   The fix commit must contain only source files — not log.json.
   WHY: getCommitFiles on the sha is what pocket-review uses to attribute corrections
   to files and tasks. Infrastructure files in the diff corrupt that attribution.

5. NO AUTO-REVIEW
   pocket-correction never invokes pocket-review.
   WHY: Re-review is always user-triggered. This preserves the user's ability to
   inspect corrections before re-review begins.

6. NO SILENT BLOCK
   Every BLOCKED task names: what failed, why, and what would unblock it.
```
