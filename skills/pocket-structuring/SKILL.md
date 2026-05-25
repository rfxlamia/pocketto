---
name: pocket-structuring
description: Splits a pocket-planning execution plan into sequential phase files before pocket-development. Use when pocket-planning hands off a plan with ≥7 tasks. Trigger on "structure plan", "split plan", or when pocket-planning invokes this. Produces phase files ready for pocket-development, one at a time.
---

# Pocket Structuring

Bridges pocket-planning and pocket-development. Runs a script that parses the execution plan, splits it into bounded phase files, then hands off phase files to pocket-development one at a time.

**Core principle:** Large plans executed flat = attention drift + context blowout. Phase boundaries are checkpoints, not ceremony.

## When to Use

- pocket-planning has produced an execution plan and invoked this skill
- Plan has ≥7 tasks (including integration test tasks)
- User says "structure the plan", "split into phases", "break this up"

Do NOT use:
- Without a completed execution plan from pocket-planning
- Plans with ≤6 tasks → pass through directly to pocket-development

## Hard Gates

```
GATE 1: RUN THE SCRIPT FIRST. It counts and decides.
        Script output "Pass through" (≤6 tasks) → invoke pocket-development directly.
        Script output "Splitting into phases" (≥7 tasks) → present summary, proceed.
        DO NOT estimate task count — the script counts exactly.

GATE 2: HARD OVERRIDE PROTOCOL.
        If any human asks to skip structuring for a ≥7 task plan, respond:

        "Structuring is a hard gate for plans ≥7 tasks. Skipping it
        risks context blowout and attention drift in pocket-development.
        To override: type exactly → OVERRIDE: skip structuring"

        Do NOT proceed on "just skip it", "we don't need it", "proceed
        directly", or any verbal/written insistence. Only the exact
        override phrase unlocks the bypass.

        If override is typed: log it, proceed to pocket-development,
        document the skip in the plan file header.

GATE 3: NO PARTIAL PHASES.
        Each phase file is complete (full pocket packets, not referenced).
        The script handles this — do not hand-edit phase files to link out.
```

## Pressure Countermeasures

| Pressure | What they say | Correct response |
|----------|--------------|-----------------|
| Time | "We're urgent, skip phases" | "Script takes 5 seconds. Blowout at task 8 costs hours. OVERRIDE phrase to skip." |
| Sunk cost | "Plan is already written" | "Plan is the input. Phases are the output. Script is the job." |
| Authority | "I'm making the call, skip it" | "Acknowledged. Override phrase to proceed: OVERRIDE: skip structuring" |
| User insists | "Just run it flat, I've done it before" | Same override protocol. Verbal insistence ≠ override. |
| Threshold edge | "It's only 7, practically 6" | "Threshold is ≥7. Count is 7. Structuring runs." |

---

## Step 1: Run the Script

```bash
pocket-structure <path-to-execution-plan.md>
```

Use the path exactly as it appears in the handoff (typically `docs/pocket/plans/{slug}/execution-plan.md` from the project root).

**Script outputs:**
- Task count and depth table
- Phase breakdown with task IDs and file paths
- `STRUCTURING COMPLETE` summary

If the script says "Pass through" (≤6 tasks): invoke `pocket-development` directly with `execution-plan.md`. Do not create phase files.

If the script errors (parse failure, file not found): report the error to the user, do not proceed.

---

## Step 2: Present Summary + Get Approval

Present the script's summary output to the user, then ask:

```
Ready to start Phase 1 with pocket-development?
```

Do not start Phase 1 until the user says yes.

---

## Step 3: Sequential Handoff to pocket-development

1. User approves → invoke `pocket-development` with `execution-plan-phase-1.md`
2. pocket-development completes Phase 1 → **wait for explicit DONE confirmation**
3. Verify Phase 1 gate (all tasks done, tests green, commits exist)
4. Gate passes → invoke `pocket-development` with `execution-plan-phase-2.md`
5. Repeat until all phases complete

**NEVER start Phase N+1 until Phase N gate is confirmed DONE.**
**NEVER hand all phase files simultaneously to pocket-development.**

### Phase Completion Gate

Before handing off to the next phase, confirm ALL of:
- Every task in the phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT
