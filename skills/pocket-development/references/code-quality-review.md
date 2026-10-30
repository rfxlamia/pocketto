# Code Quality Review — Stage 2 Protocol

## Contents
- [Purpose](#purpose)
- [Pre-Review: Load Context](#pre-review-load-context)
- [Verification Steps](#verification-steps)
- [Issue Severity Classification](#issue-severity-classification)
- [Output Format](#output-format)
- [DO vs DON'T](#do-vs-dont)
- [Edge Cases](#edge-cases)
- [Output to Controller](#output-to-controller)

Full verification protocol for Stage 2 reviewer (read-only).

## Purpose

Verify the implementation is well-built: clean, maintainable, follows patterns, no red flags.

**Prerequisite:** Stage 1 must PASS. Never review quality of spec-non-compliant code.

## Pre-Review: Circuit Breaker + Load Context

**0. Circuit Breaker (mandatory):**
```
IF Stage_1.status = FAIL in this invocation:
  - Set stage_2.status = "SKIPPED"
  - Set stage_2.assessment = "N/A"
  - Set stage_2.strengths = []
  - Set stage_2.issues = []
  - Skip ALL remaining Stage 2 steps
  - Proceed directly to "Output to Controller"
```

**1. Load context (only if Stage 1 passed):**
- **Pocket Packet** → Extract QUALITY BAR (must-have, must-not-have, red flags)
- If quality_bar is empty → Flag as Important issue: "Empty quality bar — limited assessment possible"
- **Codebase patterns** → Note existing conventions from preflight scan
- **Stage 1 report** → Confirm all spec issues resolved

## Verification Steps

### Step 1: Check Must-Haves

From QUALITY BAR, verify each must-have:

```
[ ] <must-have item 1> — present? correct?
[ ] <must-have item 2> — present? correct?
...
```

### Step 2: Check Must-Not-Haves

From QUALITY BAR, verify each must-not-have is absent:

```
[ ] <must-not-have item 1> — absent? 
[ ] <must-not-have item 2> — absent?
...
```

### Step 3: Check Red Flags

From QUALITY BAR, check for red flag patterns:

```
[ ] Improvements touching files OUTSIDE the task's scope → REVERT
    (an in-scope refactor mandated by the packet's "Refactor while green" step is
    NOT a violation — verify it stayed within scoped files + declared helpers)
[ ] Missing function signatures → FIX
[ ] Hardcoded credentials → CRITICAL
[ ] SQL injection risk → CRITICAL
...
```

### Step 4: Assess Code Quality

Beyond QUALITY BAR, assess:

**Structure:**
- Clean separation of concerns?
- Functions/classes sized appropriately? A file over ~300 lines or a function over ~50 lines left unsplit is a prompt to inspect — an Important finding requires a cited concrete maintainability risk; size alone is not a defect and is Minor or omitted with a suggested, non-blocking cleanup.
- No code duplication that harms maintainability? Same logic 3+ times in scope, or duplicated across files of the same plan, is a prompt to inspect — only duplicated behavior likely to drift, with cited evidence, is Important.

**Patterns:**
- Follows existing codebase conventions?
- Uses established patterns (not inventing new ones)?
- Consistent naming?

**Error Handling:**
- Errors caught and handled?
- Error messages meaningful?
- No silent failures?

**Tests:**
- Tests verify behavior (not just pass)?
- Edge cases covered?
- Test names descriptive?

**Maintainability:**
- Code is readable?
- No magic numbers/strings?
- Comments where needed (not where obvious)?

## Issue Severity Classification

### Critical

Security risk, data loss possible, or correctness bug.

Examples:
- SQL injection vulnerability
- Hardcoded credentials
- No error handling on critical path
- Data loss on edge case
- Security bypass

**Action:** Must fix before PASS. No exceptions.

### Important

Bug risk, maintainability impact, or pattern violation.

Examples:
- Magic numbers that should be constants
- Missing error handling on non-critical path
- Duplicated behavior likely to drift
- Inconsistent with codebase patterns
- Missing edge case handling

**Action:** Must fix before PASS.

### Minor

Style, preferences, or nice-to-have improvements.

Examples:
- Unused import
- Variable naming could be better
- Missing docstring
- Formatting inconsistency

**Action:** Note in report. Implementer may fix but not blocking.

## Output Format

```
STRENGTHS:
- <positive observation 1>
- <positive observation 2>

ISSUES:
- [Critical] <description> (<file>:<line>)
- [Important] <description> (<file>:<line>)
- [Minor] <description> (<file>:<line>)

ASSESSSED: Approved | Request Changes
```

## DO vs DON'T

| DO | DON'T |
|----|-------|
| Read actual code | Rely on Stage 1 report |
| Classify severity | Treat all issues equally |
| Note strengths | Only report problems |
| Be specific | Write vague "could be better" |
| Reference QUALITY BAR | Invent new criteria |
| Check patterns | Enforce personal preferences |

## Edge Cases

**Code is spec-compliant but ugly:**
→ Stage 2 catches this. Flag as Important only with a cited concrete maintainability risk — the same bar as the refactor heuristics; otherwise note as Minor.

**Code is beautiful but over-engineered:**
→ Check QUALITY BAR for "no extra work". Over-engineering = extra work.

**Existing codebase has bad patterns:**
→ Follow existing patterns unless they're security risks. Don't refactor during review.

**Test coverage is low:**
→ Flag as Important if QUALITY BAR requires tests. Otherwise note as Minor.

**Code uses different pattern than reviewer prefers:**
→ Only flag if it violates QUALITY BAR or codebase conventions. Personal preference ≠ issue.

**Large file, small change, sound cohesion:**
→ Size alone is not a defect. Note as Minor (or omit) with a suggested, non-blocking cleanup; do not force a refactor round on a counter.

## Output to Controller

Return structured result:

```
STAGE_2_RESULT: PASS|FAIL
Strengths: [list]
Issues: [{severity, description, location}]
Assessment: Approved | Request Changes
```

If FAIL → include fix instructions:
```
FIX INSTRUCTIONS:
1. [Critical] auth_service.py:42 — add try/except for invalid token format
2. [Important] auth_service.py:45 — replace 3600 with TOKEN_TTL constant
3. [Minor] auth_service.py:3 — remove unused import 'os'
```
