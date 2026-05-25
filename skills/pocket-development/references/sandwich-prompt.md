# Sandwich Prompt Structure + Attention Mechanics

The sandwich structure optimizes for LLM attention mechanics.

## Contents
- [The Sandwich Metaphor](#the-sandwich-metaphor)
- [4 Rules](#4-rules)
- [Complete Template](#complete-template)
- [Method Selection Matrix](#method-selection-matrix)
- [Method Examples](#method-examples)
- [Quick Reference](#quick-reference)

## The Sandwich Metaphor

```
┌─────────────────────────────────────┐
│ CRITICAL CONSTRAINT    ← Top bread (HIGH attention) │
├─────────────────────────────────────┤
│ Role + Task + Context  ← Filling                      │
│                                     │
│ (Middle - keep dense,              │
│  no filler)                        │
│                                     │
├─────────────────────────────────────┤
│ RESTATE KEY CONSTRAINT ← Bottom bread (HIGH attention) │
└─────────────────────────────────────┘
```

## Attention Mechanics (Why This Works)

| Mechanic | Effect | Sandwich Fix |
|----------|--------|--------------|
| **U-shaped bias** | Best at start/end, degrades 30%+ in middle | Critical at edges |
| **Attention sink** | First tokens architecturally privileged | Role/task in first sentence |
| **Attention drift** | Forgets early instructions as output grows | Restate key constraint near END |
| **Context dilution** | Attention spreads across all tokens | Middle dense, no filler |

## 4 Rules

### Rule 1: Critical Instruction in FIRST LINE

**What:** Most important constraint or requirement goes in line 1-2.

**Why:** First tokens have highest attention due to attention sink.

**Example:**
```
[CRITICAL: Token validation failure must ALWAYS DENY, never permit]
You are implementing auth service extraction.
```

**Anti-pattern:**
```
You are implementing auth service extraction.
The code should be clean and well-tested.
[CRITICAL: Token validation must deny on failure]  ← TOO LATE
```

### Rule 2: Key Constraint REPEATED near END

**What:** For outputs >500 tokens, restate the critical constraint before the output.

**Why:** Attention drift causes models to "forget" early instructions as they generate.

**Example:**
```
[long implementation...]

[RESTATE CRITICAL CONSTRAINT: Token validation failure must
ALWAYS DENY access, never permit. This is the security-critical
behavior.]

Your implementation should:
1. ...
```

### Rule 3: Middle Section FREE of Filler

**What:** No niceties, no padding, no redundant explanations.

**Why:** Context dilution - filler weakens signal for all tokens.

**Bad middle:**
```
So you know, this is part of a larger refactoring effort.
We're trying to make the code cleaner and more maintainable.
The user service is used in many places so we need to be careful.
...
```

**Good middle:**
```
Context:
- Part of user service refactoring (Task 3 of 5)
- Touches: user_service.py, new auth_service.py
- Dependencies: None (new file)
- Conventions: Follow existing test patterns
```

### Rule 4: Long Output = Restate Before Output

**What:** For complex/long outputs, add constraint reminder before the output section.

**Threshold:** When subagent will output >500 tokens of code/content.

**Template:**
```
[TASK DESCRIPTION + CONTEXT]

[RESTATE KEY CONSTRAINT - for outputs >500 tokens]

Your job:
1. [step]
2. [step]

[OUTPUT SECTION]
```

## Complete Template

```
[CRITICAL: [worst-case if violated]]    ← Rule 1

You are [role] [task description].

[CONTEXT - Rule 3: dense, no filler]    ← Rule 3
- [scene-setting]
- [dependencies]
- [technical info]

[RESTATE KEY CONSTRAINT]                ← Rule 2 + 4

Your job:
1. [step]
2. [step]

Report: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

## Method Selection Matrix

Match prompting method to task complexity:

| Complexity | Method | Token Budget | When |
|------------|--------|--------------|------|
| Simple, well-specified | Zero-Shot | 50-200 | Direct instruction sufficient |
| Format consistency | Few-Shot | 200-800 | Show 2-3 examples |
| Multi-step reasoning | Chain of Thought | 100-500 | Reasoning steps needed |
| Complex planning | Tree of Thoughts | 500-2000+ | Multiple paths, backtracking |
| High-stakes | Self-Consistency | 500-3000+ | Multiple paths, compare |
| Tool use | ReAct | 300-1000 | External actions required |

## Method Examples

### Zero-Shot (Simple)
```
Extract auth validation to auth_service.py.
Verify: 5/5 tests pass, no auth code in user_service.py.
```

### Few-Shot (Format)
```
Format auth errors as:
  { "error": "invalid_token", "message": "...", "code": 401 }

Examples:
Input: expired token
Output: { "error": "expired_token", "message": "Token expired", "code": 401 }

Input: missing token
Output: { "error": "missing_token", "message": "Authorization required", "code": 401 }
```

### Chain of Thought (Multi-step)
```
Implement token refresh:
1. Check if access token expired
2. If expired, check refresh token
3. If valid, issue new access token
4. If invalid, deny and clear session
5. Return appropriate error for each failure case
```

### Self-Consistency (High-stakes)
```
For the auth service, reason through 3 scenarios independently:
A. Valid token, expired refresh → ?
B. Invalid token, valid refresh → ?
C. Both expired → ?

Compare your answers. If inconsistent, re-reason.
Report final decision.
```

## Quick Reference

```
SANDWICH CHECKLIST:
[ ] Critical constraint in FIRST LINE?
[ ] Role + task in first sentence?
[ ] Middle section: dense, no filler?
[ ] Key constraint REPEATED near END?
[ ] For >500 token output: constraint restated before output?
[ ] Method matches task complexity?
```
