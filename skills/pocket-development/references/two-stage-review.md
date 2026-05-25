# Two-Stage Review Process

Every task requires two stages of review: spec compliance THEN code quality.

## Contents
- [Why Two Stages?](#why-two-stages)
- [Stage 1: Spec Compliance](#stage-1-spec-compliance)
- [Stage 2: Code Quality](#stage-2-code-quality)
- [Review Loop](#review-loop)
- [Key Differences](#key-differences)
- [Reviewer Selection](#reviewer-selection)
- [Self-Review vs Formal Review](#self-review-vs-formal-review)

## Why Two Stages?

| Stage | Question | Focus |
|-------|----------|-------|
| **Stage 1** | Built RIGHT thing? | Requirements, scope, no missing/extra |
| **Stage 2** | Built WELL? | Quality, patterns, maintainability |

**Critical ordering:** Spec compliance before quality.

Why? Because quality review on wrong implementation is wasted effort.

## Stage 1: Spec Compliance (explore agent)

**Purpose:** Verify implementer built exactly what was requested.

**Agent:** explore (read-only)

### Verification Process

```
1. Read actual code (NOT implementer's report)
2. Compare to requirements line by line
3. Check for:
   - Missing requirements
   - Extra work not requested
   - Misunderstandings
4. Report with file:line references
```

### DO vs DON'T

| DO | DON'T |
|----|-------|
| Read actual code | Trust implementer report |
| Check line by line | Scan casually |
| File:line for issues | Vague "looks ok" |
| Verify completeness | Assume if tests pass |

### Output Format

```
✅ SPEC COMPLIANT
   All requirements verified:
   - [x] Auth layer extracted to auth_service.py
   - [x] Token validation returns (valid, user_id) tuple
   - [x] Tests 5/5 passing

❌ ISSUES FOUND
   Missing requirements:
   - [ ] Token expiry not checked (auth_service.py:42)
   - [ ] Refresh token missing (spec section 3.2)
   Extra work:
   - [+] Added OAuth2 support not in spec (auth_service.py:15-30)
   Misunderstanding:
   - [~] Implemented session-based instead of token-based (auth_service.py:8)
```

## Stage 2: Code Quality (explore agent)

**Purpose:** Verify implementation is well-built.

**Agent:** explore (read-only)
**Prerequisite:** Stage 1 must pass.

### Verification Process

```
1. Only review if Stage 1 passed
2. Read actual code
3. Check:
   - Clean, maintainable code
   - Follows existing patterns
   - Proper error handling
   - Tests verify behavior
   - No red flags from QUALITY BAR
4. Report strengths + issues
```

### Issue Severity

| Severity | Meaning | Action |
|----------|---------|--------|
| **Critical** | Security risk, data loss possible | Must fix |
| **Important** | Bug risk, maintainability impact | Should fix |
| **Minor** | Style, preferences | Consider fixing |

### Output Format

```
STRENGTHS:
- Clean separation of concerns
- Good test coverage (8/8 passing)
- Follows existing patterns

ISSUES:
- [Critical] No error handling for invalid token format (auth_service.py:42)
- [Important] Magic number: 3600 should be TOKEN_TTL constant (auth_service.py:45)
- [Minor] Unused import 'os' (auth_service.py:3)

ASSESSMENT: Request Changes
- Critical issue must be addressed before approval
- Please fix and re-submit
```

## Review Loop

```
Implementer reports DONE
        │
        ↓
Stage 1: Spec Compliance
        │
        ├── PASS → Stage 2: Code Quality
        │               │
        │               ├── PASS → APPROVED
        │               └── FAIL → Implementer fixes
        │                            │
        │                      Re-review Stage 2
        │                            │
        └── FAIL → Implementer fixes
                     │
               Re-review Stage 1
                     │
                     ├── PASS → Stage 2
                     └── FAIL → (loop)
```

**Rule:** Never skip re-review after fixes.

## Key Differences

| Aspect | Stage 1 | Stage 2 |
|--------|---------|---------|
| **Question** | Right thing? | Well built? |
| **Focus** | Requirements | Quality |
| **Reads** | Code vs spec | Code quality |
| **Pass criteria** | All requirements met | Clean, tested, maintainable |

## Reviewer Selection

Both stages use read-only review:

- Why not implementer? Reviewers should not write/edit
- Why separate? Catches wrong-build before wasting time on quality

## Self-Review vs Formal Review

| Self-Review (Implementer) | Formal Review (Read-Only Reviewer) |
|--------------------------|------------------------------|
| Before reporting back | After implementer reports |
| Catches obvious issues | Independent verification |
| Does NOT replace formal review | Required for acceptance |

**Rule:** Self-review does NOT replace either stage of formal review.
