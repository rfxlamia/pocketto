# Subagent Dispatch Template — Reviewer

Exact prompt structure for each reviewer subagent dispatched by pocket-review.
Replace ALL `<PLACEHOLDER>` values before dispatching.

## Template

```
[CRITICAL: READ-ONLY review. Do NOT edit, write, or create any files. Report findings only.]

You are reviewing <TASK_ID> (<TASK_NAME>) for spec compliance and code quality.

## Task Context

Task ID: <TASK_ID>
Task name: <TASK_NAME>
Plan file: <PLAN_DIR>/<PHASE_FILE>
SHA range: <PREV_SHA>..<DONE_SHA>

Files changed in this task:
<LIST_FILES_CHANGED — one per line, absolute paths>

## Your Task: Two-Stage Review

Perform Stage 1 (spec compliance) first.
Run Stage 2 (code quality) ONLY if Stage 1 passes.

### Stage 1: Spec Compliance

Load and follow the full protocol in:
<SKILL_DIR>/references/spec-compliance-review.md

From the plan file `<PLAN_DIR>/<PHASE_FILE>`, find the section `### Task <TASK_NUM>: <TASK_NAME>`.
Extract the DELIVERABLE block and any spec_ref it references.

Question: Did the implementer build the RIGHT thing?

### Stage 2: Code Quality

Circuit breaker: If Stage 1 FAILED, set stage_2.status = "SKIPPED" and skip this section entirely.

Load and follow the full protocol in:
<SKILL_DIR>/references/code-quality-review.md

From the plan file, extract the QUALITY BAR section for this task.

Question: Did the implementer build it WELL?

## Concerns

This is a batch post-phase review. Implementer concerns are not applicable.
Set `concerns_addressed` to `[]`.

## Output Format

Return a single JSON object matching the schema in:
<SKILL_DIR>/references/review-report-template.md

Required field values for batch mode:
- "task_id": "<TASK_ID>"
- "task_name": "<TASK_NAME>"
- "cycle": <CYCLE> (1 on first review; main agent increments for re-review — use the value passed to you)
- "timestamp": <current ISO 8601 timestamp>
- "reviewer_mode": "read-only"
- "reviewer_config": "batch-parallel"
- "loop_info": { "current_cycle": <CYCLE>, "max_cycles": 1, "cycles_remaining": 0 }
- "overall": "REVIEW_PASS" if both stages pass, "REVIEW_FAIL" if any issues, "REVIEW_BLOCKED" if you cannot complete
- "fix_instructions": "" if REVIEW_PASS, else numbered list with file:line references
- "reviewed_sha": "<REVIEWED_SHA>" — the boundary commit this review covers. On first cycle: the task's done_sha. On re-review: the newest correction SHA attributed to this task (max by commit time among owned corrections), else done_sha. The main agent computes and passes this value; copy it verbatim.

Return ONLY the JSON object — no preamble, no explanation. The main agent writes it to disk.

## Stop Conditions

Done when: JSON output is complete and covers both stages.
Blocked when: Plan file not found, spec_ref not readable → set overall = "REVIEW_BLOCKED", explain in fix_instructions.

[CRITICAL: Output the JSON object and stop. Do NOT modify any files.]
```

## How to Fill Placeholders

| Placeholder | Source |
|-------------|--------|
| `<TASK_ID>` | `log.json` task entry (`"id"` field, e.g. `"T1"`) |
| `<TASK_NAME>` | `log.json` task entry (`"name"` field) |
| `<TASK_NUM>` | Numeric part of TASK_ID (e.g. `1` from `T1`) |
| `<PLAN_DIR>` | Resolved from invocation argument (absolute path) |
| `<PHASE_FILE>` | Phase file name from `log.json` phase entry (`"file"` field) |
| `<PREV_SHA>` | Previous task's `done_sha`, or `header.baseline_sha` for T1 |
| `<DONE_SHA>` | This task's `done_sha` from `log.json` |
| `<LIST_FILES_CHANGED>` | Output of `git diff --name-only <PREV_SHA>..<DONE_SHA>` (first cycle) or union of original range + correction slices (re-review — see SKILL.md Step 3) |
| `<SKILL_DIR>` | Absolute path to the pocket-review skill directory |
| `<CYCLE>` | `1` on first review; prior `cycle` + 1 on re-review. Main agent computes from `reviews/<task_id>-review.json`.`loop_info.current_cycle` if the file exists, else `1`. |
| `<REVIEWED_SHA>` | On first cycle: task `done_sha`. On re-review: max-by-commit-time of `{ done_sha } ∪ { c.sha : c ∈ phase.corrections and T ∈ tasks(c) }` — the identical expression pocket-closing uses as `latest_owned_sha(T)`. |

## Worked Example

Given:
- plan_dir = `/home/v/project/docs/pocket/plans/2026-05-28-auth`
- task = T2 "Add token validation", done_sha = `cde3456`
- prev_sha = `bcd2345` (T1's done_sha)
- files changed: `src/auth/token.py`, `tests/test_token.py`
- skill_dir = `/home/v/.claude/plugins/cache/pocketto/pocketto/3bf7fbf749da/skills/pocket-review`

The filled prompt starts:
```
[CRITICAL: READ-ONLY review. Do NOT edit, write, or create any files. Report findings only.]

You are reviewing T2 (Add token validation) for spec compliance and code quality.

## Task Context

Task ID: T2
Task name: Add token validation
Plan file: /home/v/project/docs/pocket/plans/2026-05-28-auth/execution-plan.md
SHA range: bcd2345..cde3456

Files changed in this task:
/home/v/project/src/auth/token.py
/home/v/project/tests/test_token.py
...
```
