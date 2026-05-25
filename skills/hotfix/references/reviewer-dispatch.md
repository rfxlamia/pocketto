# Reviewer Dispatch — Subagent Template

How to dispatch the plan reviewer subagent. Use this during Step 3 of quick-iteration.

---

## When to Load This File

Load this file when you are at Step 3 (Dispatch subagent reviewer).
You must have a completed brief plan from Step 2 before dispatching.

---

## Dispatch Instructions

Use the **Agent tool** with `subagent_type: general-purpose`.

Construct the prompt using the template below. Fill in the bracketed sections.
Do not summarize or paraphrase the plan — paste it verbatim.

---

## Prompt Template

```
You are a plan reviewer operating under the validate-plan skill.

Your job is to review the following brief implementation plan before it is executed.
You are an independent reviewer — you did not write this plan, so you have no sunk cost in it.

## Plan to Review

[PASTE BRIEF PLAN VERBATIM HERE]

## Codebase Context

Tech stack: [e.g., React + TypeScript, NestJS, Python/FastAPI]
Relevant files: [list files the plan will touch]
Existing patterns to check against: [e.g., existing error handling, reusable utils, test framework]

## Validation Checklist

Review against these principles:

**DRY (Don't Repeat Yourself):**
- Does this plan duplicate functionality that likely already exists?
- Are there existing utilities, components, or patterns it should reuse instead?

**YAGNI (You Aren't Gonna Need It):**
- Does the plan add more than what was asked?
- Are there abstractions or features that aren't strictly needed now?
- Is the scope minimal for the stated goal?

**TDD (Test-Driven Development):**
- Does the plan include a test step BEFORE implementation?
- Are edge cases considered?

**Gap Analysis:**
- Are there missing edge cases or error paths?
- Are the steps specific enough to implement without guessing?
- Any silent assumptions that might be wrong?

## Output Format

Return a structured report:

CRITICAL (must fix before implementing):
- [issue + specific recommendation]

WARNING (should fix):
- [issue + specific recommendation]

INFO (optional improvement):
- [suggestion]

VERDICT: APPROVED (no critical issues) or BLOCKED (has critical issues)
```

---

## After Receiving the Report

- If BLOCKED → fix CRITICAL issues in the plan, then re-dispatch (same template)
- If APPROVED with WARNINGs → decide: fix or document exception
- If APPROVED (clean) → proceed to Step 5: Implement
- Max 3 dispatch iterations → if still BLOCKED, surface to user

---

## What NOT to Do

- Do not review your own plan and call it "reviewed"
- Do not skip dispatch because the plan "looks fine to you"
- Do not pass the reviewer a vague summary — paste the actual plan bullets
- Do not ignore CRITICAL findings because fixing them seems slow
