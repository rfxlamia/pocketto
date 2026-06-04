---
name: pocket-structuring
description: Bridges pocket-planning and pocket-development for all execution plans. Use when pocket-planning hands off any execution plan. Routes ≤6-task plans as a passthrough to pocket-development; splits ≥7-task plans into phase files. Trigger on "structure plan", "split plan", or when pocket-planning invokes this.
---

# Pocket Structuring

Bridges pocket-planning and pocket-development. Runs a CLI that parses the execution plan, splits it into bounded phase files, then hands off phase files to pocket-development one at a time.

**Core principle:** Large plans executed flat = attention drift + context blowout. Phase boundaries are checkpoints, not ceremony.

**Why this skill is not merged into pocket-planning:** pocket-planning *produces* the plan; pocket-structuring *sequences execution* (phasing + per-phase handoff loop to pocket-development). pocket-planning routes only **split** plans (≥7 tasks) here; passthrough plans (≤6 tasks) go straight to pocket-development. When pocket-structuring **is invoked directly** (e.g. the user runs it by hand), the passthrough handler and the Hard Gate / override protocol still apply for any task count. Collapsing this into pocket-planning would fold execution-orchestration into a planning skill and remove the phase-splitting gate.

## When to Use

- pocket-planning produced a **split** plan (≥7 tasks) and invoked this skill → CLI splits into bounded phase files
- User invokes this skill directly for any task count (≥7 → split; ≤6 → CLI passthrough, pocket-development invoked directly, no phase files created)
- User says "structure the plan", "split into phases", "break this up"

(For ≤6-task plans, pocket-planning hands off straight to pocket-development — it does not route through this skill. The passthrough handler below remains for direct invocation.)

Do NOT use:
- Without a completed execution plan from pocket-planning

## Hard Gates

```
GATE 1: RUN THE CLI FIRST. It counts and decides.
        data.action == "passthrough" (≤6 tasks) → invoke pocket-development directly.
        data.action == "split" (≥7 tasks) → present summary, proceed.
        DO NOT estimate task count — the CLI counts exactly.

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

## Step 1: Run the CLI

```bash
npx -y pocketto-pi structure "<path-to-execution-plan.md>" --json --contract 2
```

No install step or PATH setup — `npx` resolves the cross-platform binary. Use the path exactly as it appears in the handoff (typically `docs/pocket/plans/{slug}/execution-plan.md` from the project root). Quote the path so spaces are handled.

The CLI prints a JSON envelope to stdout:

```json
{ "ok": true, "command": "structure", "cliVersion": "2.0.0", "contract": 2,
  "data": {
    "action": "split",
    "taskCount": 9,
    "phases": [
      { "phase": 1, "name": "...", "tasks": ["T1","T2","T3"], "file": "execution-plan-phase-1.md" }
    ]
  },
  "error": null }
```

Parse `data` — do not scrape prose:
- `data.action == "passthrough"` (≤6 tasks): invoke `pocket-development` directly with `execution-plan.md`. Do not create phase files.
- `data.action == "split"` (≥7 tasks): `data.phases[]` gives each phase (`phase`, `name`, `tasks`, `file`). Present the summary and proceed.

If `ok == false`: report `error.message` to the user and do not proceed. A `CONTRACT_MISMATCH` means the installed CLI is incompatible with this skill — tell the user to update the pocketto plugin (or pin: `npx -y pocketto-pi@2`).

(Omit `--json` for human-readable output when running by hand.)

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
