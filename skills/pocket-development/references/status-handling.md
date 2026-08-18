# Status Handling Guide

Controller responses to each subagent status.

## The 4 Statuses

| Status | Meaning | Controller Action |
|--------|---------|-------------------|
| **DONE** | Task complete, ready for review | Mechanical gate, then the read-only auditor — see references/two-stage-review.md |
| **DONE_WITH_CONCERNS** | Complete but flagged doubts | Read concerns, assess risk |
| **NEEDS_CONTEXT** | Cannot proceed, needs info | Provide context, re-dispatch |
| **BLOCKED** | Cannot complete task | Categorize blocker, fix, re-dispatch |

## Status: DONE

DONE handling — the mechanical gate, the read-only auditor dispatch, severity ladder, round budget, and SHA pinning — is fully specified in `references/two-stage-review.md`. SKILL.md's citation table routes this file only for BLOCKED/NEEDS_CONTEXT status handling; DONE_WITH_CONCERNS guidance is below.

## Status: DONE_WITH_CONCERNS

**Trigger:** Implementer completed work but flagged doubts.

**Example Concerns:**
- "This file is getting large"
- "Not sure if approach is optimal"
- "Tests pass but feel fragile"

**Controller Action:**
```
1. Read concerns carefully
2. Assess risk:
   - Correctness concern? → Address before review
   - Observation? → Note, proceed to review
3. If correctness risk:
   - Provide guidance or clarification
   - Re-dispatch to address
4. If observation only:
   - Note for later
   - Proceed to the mechanical gate, then the auditor
```

**Decision Matrix:**

| Concern Type | Action |
|-------------|--------|
| Correctness risk | Address first, then review |
| Observation (e.g., "file large") | Note, proceed |
| Uncertainty about scope | Clarify, possibly adjust task |

## Status: NEEDS_CONTEXT

**Trigger:** Subagent needs information not provided.

**Golden Rule:** NO WORK until context is provided.

**Controller Action:**
```
1. Read what's missing
2. Provide specific context:
   - Exact information requested
   - Additional context helpful
3. Re-dispatch with context
4. NO work allowed until answered
```

**Anti-pattern:**
```
Subagent: "What should I do about X?"
Controller: "Just proceed" ❌
Controller: "Good question, here's the context..." ✅
```

## Status: BLOCKED

**Trigger:** Subagent cannot complete task.

**Assessment Process:**
```
1. Read blocker description
2. Categorize blocker type:
   a. Context problem
   b. Reasoning needs
   c. Task too large
   d. Plan wrong
3. Apply fix for category
4. Re-dispatch
```

### Blocker Categories + Fixes

#### (a) Context Problem

**Symptoms:**
- "Can't find the file"
- "Don't understand how X works"
- "Missing information about Y"

**Fix:** Provide more/different context.

```
Provide:
- File paths
- Code snippets
- Links to relevant code
- Explanation of how things work
```

#### (b) Reasoning Needs

**Symptoms:**
- "Multiple valid approaches, not sure which"
- "Unclear what's best"
- "Need architectural decision"

**Fix:** Upgrade model OR provide reasoning guidance.

```
Option 1: Escalate review depth
- Re-dispatch with deeper review instead of standard

Option 2: Provide guidance
- "Use approach A because [reason]"
- "Architecture decision: prefer [X] for [Y]"
```

#### (c) Task Too Large

**Symptoms:**
- "This is a big task"
- "Many things to do"
- "Not sure where to start"

**Fix:** Split into smaller packets.

```
1. Identify logical split points
2. Create separate packets:
   - Task A: [smaller scope]
   - Task B: [smaller scope]
3. Re-dispatch with smaller scope first
4. Queue remaining for later
```

#### (d) Plan Wrong

**Symptoms:**
- "Task doesn't match plan"
- "Dependencies not as expected"
- "Approach in plan doesn't work"

**Fix:** Escalate to human.

```
Escalate to user:
- Explain the plan issue
- Ask for clarification or plan update
- Do NOT proceed without corrected plan
```

## Escalation Response Template

When BLOCKED with specific reason:

```
Status: BLOCKED
Category: [context | reasoning | task-size | plan]
Reason: [specific description]

Fix Applied:
[What controller did to address]

Re-dispatched with:
[What changed - more context, upgraded model, smaller scope, etc.]
```

## Silent Escalation Prevention

**Law 5:** NO SILENT ESCALATION

Every BLOCKED/NEEDS_CONTEXT must have:
- Specific reason (not "I'm stuck")
- Concrete next action (not "need help")

**If subagent sends vague escalation:**
```
Subagent: "I'm stuck on this"
Controller: "BLOCKED requires specific reason + next action.
Please report:
1. What specifically is blocked?
2. What have you tried?
3. What kind of help do you need?"
```
