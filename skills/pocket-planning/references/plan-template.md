# Execution Plan Template

Load this during Phase 7 when writing the final execution plan document.

## Contents
- [Full Execution Plan Template](#full-execution-plan-template)
- [Save Path Convention](#save-path-convention)

---

## Full Execution Plan Template

Canonical execution-plan format for **all** `pocket-planning` output, regardless of task count. Copy, fill in, remove unused sections.

Task count does not select a schema. `pocketto-pi structure` parses only this shape — a
`# EXECUTION PLAN — <name>` title, a `## Pocket Packets` section, and
`### Task N: <name> [annotation]` headings — and the Phase 7 dry-run is mandatory, so any
other shape fails with `NO_TASKS`. Every behavioral task carries the full test-intent
contract here too; there is no reduced form of it.

Work small and clear enough that a full Pocket Packet feels like overkill belongs in the
`hotfix` skill, not in a second planning schema.

````markdown
# EXECUTION PLAN — <feature name>

**Date:** YYYY-MM-DD
**Spec:** docs/pocket/spec/{date}-{slug}/topic.md
**Status:** draft | approved
**Total tasks:** N

---

## Execution Overview

### Recommended Order
```
T1 → T2, T3 (parallel) → T4 → T5, T6 (parallel) → T7
```

> Dependency order above is **recommended** — pocket skill enforces actual
> parallelism and sequencing based on its routing logic.

### Parallelizable Groups
| Group | Tasks | Unblocked After |
|-------|-------|-----------------|
| Group A | T2, T3 | T1 completes |
| Group B | T5, T6 | T4 completes |

### Constraints Reminder
**Architecture:** <key constraints from spec — pocket must never violate these>
**Out-of-scope:** <items no task may touch — pocket enforces>
**Assumptions at risk:** <open questions that could force re-planning>
**Sequencing:** Dependency order shown is recommended only — pocket enforces actual blocking rules. Do not treat `[depends: TN]` as a hard lock unless the task cannot logically proceed without the prerequisite's output.

### File Structure Map
*(Embed Phase 2 file map here — one entry per rule)*

```
Rule: <rule name>
  Create: exact/path/new-file.ext        (created by: T<N>)
  Modify: exact/path/existing.ext
  Test:   tests/exact/path/test.ext
```

Note: `(created by: T<N>)` annotations mark files that do not exist until T<N> runs. The implementer writing a RED test must not import from a file a later task creates — the test would fail on an import error instead of the behavior it is meant to prove.

---

## Pocket Packets

---

### Task 1: <name> [prereq]

## OBJECTIVE
<what must be done>

Steps:
1. Write failing test for: <GWT scenario name>
   Test file: `tests/exact/path/test.ext`
   Level: unit | integration | E2E
   Test intent: Given <precondition> / When <action> / Then <observable outcomes>
   Exercise through: <public boundary>
   Test doubles: <mock these; do NOT mock the unit under test>
   Expected RED: <why it fails today>
2. Run test — verify FAIL: `<exact command>`
3. <implement → verify PASS → refactor while green → commit>

<!-- One RED cycle per GWT scenario this task covers. Repeat steps 1-3 for each
     additional scenario, numbering onward (4, 5, 6 ...). Each cycle carries its OWN
     seven fields, including its own exact command in its own Step 2 — the mechanical
     gate enumerates those commands and runs every one of them. A second scenario folded
     into the first cycle has no command of its own and is never independently proved. -->

4. Write failing test for: <second GWT scenario name>   ← repeat the Step 1 block in full
...

> Test **intent** only — never test source code. The implementer writes the test
> during the RED step, against the API that exists by then.

## REFERENCES LOADED
<spec path> — rule: <name>, GWT scenarios used as verification
[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH
Complexity: lightweight | standard | deep
Justification: <reason>

## SANDWICH CONTEXT
[CRITICAL: <hard constraint>]
You are implementing <task> for <feature>.
Spec: <path>
Design decision: <chosen option>
Files in scope: <list>
Available after: none (prereq)
Architecture rule: <constraint>
[RESTATE: <same hard constraint>]

## DELIVERABLE
Given <precondition>, When <action>, Then <outcome>
Given <edge case>, When <action>, Then <outcome>
[derived] Given <inferred precondition>, When <action>, Then <outcome>  ← if no GWT in spec

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - <requirement>

Must-not-have:
  - <out-of-scope item>

Open question risks:
  - <assumption> → if wrong: report NEEDS_CONTEXT

Rollback note:
  - <rollback step if spec has rollback plan>

Red flags:
  - Work outside listed files → DONE_WITH_CONCERNS
  - Must-not behavior implemented → STOP

## STOP CONDITIONS
Done when: DELIVERABLE scenarios pass, no out-of-scope files modified
Uncertain when: <open question proves wrong>
Escalate when: <constraint violated>

---

### Task 2: <name> [depends: T1]

[...repeat Pocket Packet structure for each task...]

---

## Plan Summary

| Task | Name | Depends | Complexity | Key Verification |
|------|------|---------|------------|-----------------|
| T1 | <name> | prereq | lightweight | <GWT 1-liner> |
| T2 | <name> | T1 | standard | <GWT 1-liner> |
| T3 | <name> | T1 | lightweight | <GWT 1-liner> |

````

---

## Save Path Convention

If saving the execution plan to disk:

```
docs/pocket/plans/
└── YYYY-MM-DD-kebab-slug/
    └── execution-plan.md
```

- Mirrors the brainstorm spec path pattern
- Spec: `docs/pocket/spec/YYYY-MM-DD-slug/topic.md`
- Plan: `docs/pocket/plans/YYYY-MM-DD-slug/execution-plan.md`
- Same slug — easy to cross-reference between spec and plan

---

## Filling Guidance

### SANDWICH CONTEXT — What Goes Where

```
[CRITICAL: <line 1>]        ← hardest constraint, one line, highest attention
You are implementing...      ← role + task + spec reference
Files in scope: ...          ← boundary, explicit
Architecture rule: ...       ← constraint restated in body
[RESTATE: <last line>]       ← same hard constraint, anchors end of context
```

Only hard constraints (layer rules, forbidden deps, must-use patterns) in `[CRITICAL]` and `[RESTATE]`.
Do not fill these with style preferences or naming conventions.

### DELIVERABLE — Scenario Priority

Order within DELIVERABLE:
1. Happy path GWT (from spec, unmodified)
2. Edge case GWT (from spec)
3. Failure / negative GWT (from spec or derived)
4. `[derived]` assertions (if spec had no GWT — mark clearly)
5. `[must-not]` assertions (for negative acceptance criteria)

### Complexity Quick Reference

| Condition | Complexity |
|-----------|------------|
| 1–3 files, clear spec, no judgment needed | lightweight |
| 2–5 files, some interpretation required | standard |
| Branching logic or ambiguous spec | standard (override) |
| Architecture decisions, complex reasoning | deep |
| Review / audit (read-only) | standard review |
