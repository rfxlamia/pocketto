# Pocket Packet Construction Guide

The Pocket Packet is the contract between controller and subagent. **7 mandatory fields; WORKTREE is an 8th field only for PARALLEL GROUP.**

## Packet vs Regular Prompt

| Aspect | Regular Prompt | Pocket Packet |
|--------|---------------|----------------|
| Structure | Ad-hoc | 7 mandatory fields |
| Verification | Vague | 3-5 checklist items |
| Constraints | Optional | Explicit must-have/must-not |
| Stop conditions | None | Explicit done/uncertain/escalate |

## 7 Required Fields

```markdown
## OBJECTIVE
[Single bounded task - what MUST be done]

## REFERENCES LOADED
[Reference file name] — [Brief summary of what was learned]
[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH
[complexity assessment + justification]

## SANDWICH CONTEXT
[Critical constraint - FIRST LINE]
[Role + Task + Constraint]
[Scene-setting + dependencies]
[Key constraint REPEATED - near END]

## DELIVERABLE
[Exact output format]
[Few-Shot example if format matters]
[Verification checklist - 3-5 items]

## QUALITY BAR
[Must-have]
[Must-not-have]
[Red flags to catch in self-review]

## STOP CONDITIONS
[Done when X]
[Uncertain when Y]
[Escalate when Z]
```

## Field-by-Field Guide

### OBJECTIVE

**Purpose:** Define WHAT must be done, not HOW to do it.

**Rules:**
- Single task, not multiple
- Specific, not vague
- Uses imperative: "Extract...", "Add...", "Implement..."

**Good:**
```
Extract authentication logic from user_service.py into
a new auth_service.py file, preserving all existing behavior.
```

**Bad:**
```
Handle the auth refactoring
Fix the auth issues
Improve the auth layer
```

#### Behavioral tasks: carry the planner's test intent verbatim

A task file from `pocket-structuring` carries **test intent, not test source code** — planning
owns the intent, development owns the implementation. Do not expect runnable test code in the
task, and do not drop the intent when you rewrite the task into an implementer packet.

Copy these fields into OBJECTIVE unchanged:

| From the task | Into the packet |
|---|---|
| Test file, level (`unit`/`integration`/`E2E`) | Where the RED test goes and at what level |
| GWT test intent (Given / When / Then) | The behavior the test must prove |
| Exercise through | The boundary to drive — never internals |
| Test doubles (and what must NOT be mocked) | Mock boundary |
| Expected RED | The failure the implementer must see before writing production code |
| Exact command (task Step 2) | The command to run |

Then state the RED gate in OBJECTIVE explicitly:

```
1. Write the test at <test file> from the test intent above. Do not write production code yet.
2. Run `<exact command>`. Confirm it FAILS, and that the failure matches Expected RED.
   Passing here, or failing for a different reason (import error, typo, wrong fixture),
   means the test does not prove the behavior — fix the test before continuing.
3. Only then implement the minimum to make it pass, run the command again — PASS.
4. Refactor while green, re-run the command, commit.
```

Omitting the RED verification turns TDD into test-after: the implementer writes production
code first and a test that cannot fail. A task marked `[no-tdd — structural task]` is exempt.

### WHY THIS APPROACH

**Purpose:** Justify task scope and complexity assessment.

**Format:**
```
complexity: [lightweight | standard | deep]
justification: [why this level fits]
```

**Examples:**
```
complexity: standard
justification: Mechanical task (1 file), clear spec,
               no architectural decisions needed

complexity: deep
justification: Security-sensitive code review,
               need thorough analysis
```

### SANDWICH CONTEXT

**Purpose:** Provide all context subagent needs, structured for attention.

**Structure:**
```
[CRITICAL CONSTRAINT]      ← FIRST LINE, highest attention
[Role + Task + Constraint] ← Anchor task
[Scene-setting]            ← Where fits in larger work
[Dependencies]             ← What must exist first
[Technical context]        ← Files, patterns, conventions
[Key constraint REPEATED]  ← Near END for long outputs
```

**Example:**
```
[CRITICAL: If token validation fails, auth must DENY, not permit]
You are implementing auth service extraction for the user service.

Context:
- Part of larger user service refactoring (Task 3 of 5)
- Dependencies: None (new file, no existing auth_service.py)
- Files to touch: user_service.py (remove auth code)
- Files to create: auth_service.py, auth_service_test.py
- Follow existing test patterns in tests/ directory

[Token validation failure must always DENY access - this is the
 security critical behavior, restate before output]
```

### DELIVERABLE

**Purpose:** Define exact output + how to verify it.

**Components:**
1. **Output format:** What exactly should be produced
2. **Few-Shot example:** (if format matters) Show expected shape
3. **Verification checklist:** 3-5 specific items that must pass

**Verification Checklist Examples:**
```
Verification checklist:
□ auth_service.py exists with validate_token() function
□ validate_token() returns (valid, user_id) on success
□ validate_token() returns (False, None) on invalid/expired
□ No auth logic remains in user_service.py
□ All imports in user_service.py updated
□ auth_service_test.py: 5/5 tests passing
□ Integration test: login flow works end-to-end
```

### QUALITY BAR

**Purpose:** Define what must and must NOT be in the output.

**Components:**
1. **Must-have:** Required elements
2. **Must-not-have:** Prohibited elements
3. **Red flags:** Patterns to catch in self-review

**Example:**
```
Must-have:
- Token validation with expiry check
- Refresh token support
- Error handling with specific messages

Must-not-have:
- No hardcoded secrets (use environment)
- No auth bypass ("always permit" logic)
- No new dependencies outside existing stack

Red flags:
- Any "TODO" left in auth code
- Magic numbers without constants
- Missing error cases caught only by tests
```

### STOP CONDITIONS

**Purpose:** Define boundaries - when done, when uncertain, when to escalate.

**Format:**
```
Done when:
- All verification checklist items pass
- No auth logic remains in user_service.py
- Tests pass without skipping

Uncertain when:
- Auth behavior differs from existing (check before implementing)
- Security implications unclear (STOP, escalate)
- Test failures after 2 attempts (escalate)

Escalate when:
- Requires architectural decision not in scope
- Existing code behavior unclear despite investigation
- Security concern identified
```

## Packet Quality Checklist

Before spawning, verify packet:

- [ ] OBJECTIVE is single, bounded, specific
- [ ] WHY THIS APPROACH has justification for complexity level
- [ ] SANDWICH: Critical constraint in FIRST LINE
- [ ] SANDWICH: Key constraint REPEATED near END
- [ ] DELIVERABLE: Format is exact (not "something like")
- [ ] DELIVERABLE: 3-5 verification items defined
- [ ] QUALITY BAR: Must-have/must-not-have clear
- [ ] STOP CONDITIONS: Done/uncertain/escalate defined

## Weak Packet Examples

### Too Vague
```
OBJECTIVE: Handle auth extraction
WHY: standard complexity, seems right
CONTEXT: Just extract auth code
DELIVERABLE: Clean auth code
```

### Missing Fields
```
OBJECTIVE: Extract auth to auth_service.py
WHY: standard complexity
CONTEXT: ...
(no DELIVERABLE, no QUALITY BAR, no STOP CONDITIONS)
```

### Forbidden Verbs
```
OBJECTIVE: Handle the auth stuff
WHY: ...
CONTEXT: ...
(Using "handle" - must be more specific)
```
