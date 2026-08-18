# Spec Compliance Review — Stage 1 Protocol

## Contents
- [Purpose](#purpose)
- [Pre-Review: Load Context](#pre-review-load-context)
- [Verification Steps](#verification-steps)
- [DO vs DON'T](#do-vs-dont)
- [Edge Cases](#edge-cases)
- [Concerns from Implementer](#concerns-from-implementer)
- [Output to Controller](#output-to-controller)

Full verification protocol for Stage 1 reviewer (read-only).

## Purpose

Verify the implementer built exactly what was specified — nothing more, nothing less.

## Pre-Review: Verify + Load Context

**0. Verify inputs (gate before reading):**
- Phase file exists at `<plan_dir>/<phase_file>`? → If not, report and STOP
- `files_changed` is non-empty? → If empty, report "no files to review" and STOP
- Spec file exists at `spec_ref` (strip `#fragment` if present)? → If not, report and STOP

**1. Load context:**
- **Phase file** → Find the task's DELIVERABLE section
- **Spec file** → Find the acceptance criteria rule referenced by the task
- **Pocket Packet** → Note the OBJECTIVE, files in scope, and STOP CONDITIONS

Extract a checklist from DELIVERABLE:
```
Given <precondition>, When <action>, Then <outcome>     → verify
Given <edge case>, When <action>, Then <outcome>         → verify
[must-not] Given <condition>, When <action>, Then NOT    → verify
```

## Verification Steps

### Step 1: Read Actual Code

Read every file in `files_changed`. Do NOT trust the implementer's report.

For each file:
- Read the full file (not just diff)
- Note the actual behavior

### Step 2: Check Each Requirement

For each DELIVERABLE item:

```
[ ] Requirement present in code?
    → Search for the specific function/class/module
    → Verify it handles the Given-When-Then scenario

[ ] Behavior matches spec?
    → Check: Does the code do what the spec says?
    → Check: Are edge cases handled?
    → Check: Are error paths correct?

[ ] No extra work?
    → Anything in the code not asked for in DELIVERABLE?
    → Extra features, unnecessary abstractions, scope creep
```

### Step 3: Check for Misunderstandings

Common misunderstanding patterns:
- Implemented session-based auth when spec said token-based
- Added validation when spec said passthrough
- Changed function signatures when spec said preserve
- Used wrong data structure (list vs dict, string vs int)

### Step 4: Report

Use this exact format:

```
✅ SPEC COMPLIANT
   All requirements verified:
   - [x] <requirement 1> (<file>:<line>)
   - [x] <requirement 2> (<file>:<line>)

❌ ISSUES FOUND
   Missing requirements:
   - [ ] <description> (<file>:<line> or "not found")
   Extra work:
   - [+] <description> (<file>:<line>)
   Misunderstanding:
   - [~] <description> — expected X, got Y (<file>:<line>)
```

## DO vs DON'T

| DO | DON'T |
|----|-------|
| Read actual code files | Trust implementer's self-report |
| Check line by line | Scan casually |
| Use file:line for every issue | Write vague "looks ok" |
| Verify completeness | Assume if tests pass |
| Check for extra work | Only check what's missing |
| Note misunderstandings | Assume intent matches spec |

## Edge Cases

**Spec says "handle errors" but doesn't how:**
→ Check if error handling exists. If absent = missing requirement.

**Spec says "return X" but code returns Y that's "better":**
→ Flag as misunderstanding. "Better" ≠ spec-compliant.

**Code passes tests but tests don't cover spec:**
→ Flag as missing requirement. Tests passing ≠ spec compliance.

**Implementer added tests not in spec:**
→ Not extra work (tests are good). But if test code includes implementation logic, flag as extra.

**Multiple files changed, only some in scope:**
→ Review only in-scope files. Note out-of-scope changes as observation.

## Concerns from Implementer

If implementer flagged concerns in their DONE report:

| Concern Type | Stage 1 Action |
|---|---|
| Correctness risk ("tests pass but feel fragile") | Investigate — check test quality, edge cases |
| Observation ("file is getting large") | Note in report, proceed |
| Uncertainty about scope | Check if scope matches DELIVERABLE |
| Performance concern | Note — Stage 2 will assess |

## Output to Controller

Return structured result:

```
STAGE_1_RESULT: PASS|FAIL
Issues: [list with file:line]
Concerns addressed: [list]
```

If FAIL → include fix instructions:
```
FIX INSTRUCTIONS:
1. In auth_service.py:42 — add token expiry check per spec rule 3.2
2. Remove OAuth2 code (auth_service.py:15-30) — not in spec
3. Change session-based to token-based auth per spec section 2.1
```
