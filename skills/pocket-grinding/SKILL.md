---
name: pocket-grinding
description: BDD-driven feature/fix discovery before any implementation. Use when planning a feature, designing a fix, or exploring options before building. Trigger on "pocket-grinding", "brainstorm", "think through", "plan this", "before we build". Invokes pocket-planning at handoff.
---

# Pocket Grinding

Production-grade requirement discovery using BDD principles. Gathers project context, defines scope, questions from three expert lenses, maps concrete examples to scenarios, validates against existing architecture, and produces a spec ready for delegation.

**Core principle:** Scenarios first, design second. Architecture must be validated before handoff. No implementation until spec is approved.

## When to Use

Trigger this skill when:
- Planning a feature whose shape or requirements aren't yet clear, or that spans multiple files/phases (small, clearly-specified additions → `hotfix`)
- Fixing a non-trivial bug with design implications
- Refactoring a system boundary or changing an API contract
- User says "let's think through", "plan this", "explore options", "before we build"

Do NOT use for:
- Trivial single-line fixes (typo, config value, rename)
- Small, well-understood changes touching only **1–4 files** and resolvable in **1–2 requests** → use `hotfix` instead (Phase 1.5 surfaces this off-ramp mid-flow)
- Work that already has an approved spec

## Hard Gates

```
GATE 1: NO IMPLEMENTATION until Phase 7 handoff is complete and user approves.
        No code, no scaffolding, no migrations — regardless of perceived simplicity.

GATE 2: NO PHASE 3 without confirmed scope.
        Phase 2 must be user-confirmed before questioning starts.
        Unconfirmed scope = wasted questions.

GATE 3: NO HANDOFF if architecture validation fails (Phase 6).
        Loop back to Phase 5, revise design, re-validate.

GATE 4: POCKET-PLANNING MUST BE INVOKED after user approves spec.
        Pocket-grinding is not done until pocket-planning receives the spec.
        Do not stop at "spec written" — invoke pocket-planning immediately.
```

---

## Phase 1: Context Scan

**Goal:** Understand the current state before asking a single question.

### Layered Context Protocol

**Project-level** (always scan):
- Stack, frameworks, language versions
- Architecture pattern (monolith / microservices / modular monolith)
- Key conventions: naming, folder structure, error handling, logging

**Feature-level** (always scan):
- Which components/modules are affected?
- Related APIs, data models, state management patterns
- Recent commits touching this area: `git log --oneline -10 -- <path>`
- Existing tests covering this area

**Task-level** (when available):
- Prior discussion, tickets, issue comments
- Performance constraints or SLA requirements
- Known edge cases already mentioned by user

### Output of Phase 1
Summarize findings in **3–5 bullets** before proceeding. Do not dump raw file contents — synthesize what matters. Flag unknowns explicitly.

---

## Phase 1.5: Triviality Off-Ramp (Advisory)

**Goal:** Now that the Phase 1 context scan has made task size estimable, check whether the task is small enough that `hotfix` is the better tool — and surface that off-ramp before investing in full discovery.

The full Pocket flow (grinding → planning → structuring → development → review → closing) is heavy ceremony. For genuinely small work it costs more than it returns. Onboarding users often don't know `hotfix` exists and default here for *every* task — this advisory gate names the off-ramp at the moment scope first becomes estimable, so the right tool is suggested without the user having to already know it exists.

### Triviality Heuristic

Estimate from the Phase 1 context scan. The task is **trivial** when BOTH size signals hold:
- Touches only **1–4 files**, AND
- Resolvable in **1–2 requests** (no multi-phase work)

AND none of these complexity signals are present:
- New system, architectural decision, or non-obvious design
- Unclear or contested requirements (the *ask itself* needs exploration, not just the implementation)
- API contract / system-boundary changes

> **"New feature" alone does NOT suppress this gate.** A small, clearly-specified feature addition — e.g. "add a zoom in/out button", "add CSV export" — touches few files, is understood in one request, and only needs a preview + 1–2 refine rounds. That is a `hotfix` candidate, not a grinding one. The discriminator is **requirement clarity + size + architectural impact**, not whether the work is labeled a "feature." Suppress the gate only when the requirement is genuinely unclear or the design decision is architectural.

### Action When Triggered

Recommend `hotfix`, explain why, then let the user decide:

> "This looks small — roughly **<N> files**, resolvable in 1–2 requests, with no new architecture. The full Pocket flow is likely overkill here. I'd recommend **`hotfix`** instead: it still enforces a brief-plan + subagent-review gate, so accuracy is preserved, but it skips the multi-phase ceremony.
>
> Switch to `hotfix`, or continue with full grinding? (Continue if you expect hidden complexity.)"

**This gate is ADVISORY — non-blocking:**
- If the user continues → proceed to Phase 2 without further friction (power users, or cases with hidden complexity).
- If the user switches → invoke `hotfix` and stop the grinding flow here.
- If the task is **above** the threshold → say nothing about hotfix; proceed silently to Phase 2.

This mirrors the existing `hotfix → pocket-grinding` off-ramp ("Use pocket-grinding instead when: new system, architectural decision, unclear/contested requirements, or work spanning many files/phases"), making the routing relationship **bidirectional**.

---

## Phase 2: Scope + Boundaries

**Goal:** Lock what's in and out BEFORE questioning starts.

### Scope Definition Template

Draft and present to user for confirmation:

```
IN-SCOPE:
  - <explicit behavior 1>
  - <explicit behavior 2>

OUT-OF-SCOPE (intentionally excluded):
  - <excluded concern 1>
  - <excluded concern 2>

ARCHITECTURE CONSTRAINTS:
  - Layers this work may touch: <list>
  - Layers this work must NOT touch: <list>
  - Patterns that must be followed: <list>
```

**Rules:**
- If scope is unclear → ask ONE clarifying question, then draft scope
- If scope spans multiple independent subsystems → decompose first, brainstorm one piece at a time
- Each sub-scope gets its own brainstorm → spec → pocket-planning cycle

**HARD GATE:** User must explicitly confirm scope. Do not proceed on silence or vague approval.

---

## Phase 3: Discovery — Three Amigos

**Goal:** Surface requirements, constraints, and risks through structured questioning from three expert lenses.

Ask **as many questions as needed** until behavior is clear enough to write concrete GWT scenarios. **5 questions is a floor, not a ceiling.** Ask **one question per message**. Rotate across lenses — don't exhaust one lens before touching the others.

**Discovery Sufficiency Gate:** Do NOT advance to Phase 4 until each in-scope behavior has:
- User / actor identified
- Trigger/action identified
- Expected successful outcome identified
- At least one failure/edge case identified
- Data/input boundaries identified
- Acceptance signal identified (how we know it works)

If any item is missing → keep asking. Do not convert missing behavior into assumptions unless user explicitly says to proceed with an assumption.

### Business Lens — WHY + VALUE

Pick the most relevant:
- "What's the user/business problem this solves?"
- "Who is the primary user? What is their goal in this flow?"
- "How will we measure success? What does 'done well' look like in production?"
- "What happens if this isn't built? What's the cost of inaction?"
- "Are there compliance, legal, or timeline constraints we must respect?"
- "What's the priority tradeoff — correctness, performance, UX, or delivery speed?"

### Developer Lens — HOW + FEASIBILITY

Pick the most relevant:
- "Does this fit the current architecture, or does it require a new pattern?"
- "What are the performance constraints? Any latency or throughput SLA?"
- "Are there existing abstractions to reuse, or do we build new ones?"
- "What are the integration points — external APIs, queues, DB schemas, events?"
- "Are there data migration concerns? What's the rollback strategy?"
- "What's the deployment path — feature flag, gradual rollout, hard cutover?"

### QA Lens — WHAT BREAKS + EDGE CASES

Pick the most relevant:
- "What's the worst-case failure mode? What happens to users?"
- "What are the boundary conditions? (empty input, max load, zero state, concurrent access)"
- "Are there race conditions or ordering dependencies to consider?"
- "What external dependencies could fail? How should we degrade gracefully?"
- "What existing tests might break? What new tests are non-negotiable?"
- "Are there security implications? (auth, authorization, input validation, data exposure)"

### Iteration Rules
- After 5 questions: run the Discovery Sufficiency Gate — if behavior is still unclear, continue asking
- If an answer reveals new unknowns → ask follow-up questions until the specific behavior is clear
- If user says "I don't know" → ask whether to (a) choose a safe default, (b) document an assumption, or (c) exclude that behavior from scope
- Never ask two questions in one message
- Do not advance because a question count was reached; advance only when GWT scenarios can be written with concrete Given/When/Then values

---

## Phase 4: Formulation — Example Mapping

**Goal:** Convert discovery answers into concrete, testable scenarios.

### Example Mapping Format

For each key behavior identified in Phase 3:

```
STORY:
  As a <who>, I want <what>, so that <why>

RULES (business rules / invariants governing this story):
  Rule 1: <constraint or invariant>
  Rule 2: <constraint or invariant>

EXAMPLES (one or more concrete instances per rule):
  Rule 1 → Example A: <specific input → expected output>
  Rule 1 → Example B: <edge case input → expected output>
  Rule 2 → Example C: <specific input → expected output>

OPEN QUESTIONS (unresolved — must be answered or documented as assumption):
  ? <question 1>
  ? <question 2>
```

### Given-When-Then Scenarios

Convert each example into a GWT scenario:

```
Scenario: <descriptive name>
  Given <initial context / precondition>
  When  <specific action or event>
  Then  <expected outcome>
  And   <additional outcome if needed>
```

**Rules for good scenarios:**
- One behavior per scenario — don't combine two behaviors
- Concrete values, not generic placeholders ("a user with role=editor", not "some user")
- Always include failure scenarios: `Given invalid input, When submitted, Then error X is returned`
- Cover: happy path, edge cases, failure paths, concurrent cases if relevant

### Open Questions Protocol
1. List all open questions surfaced during mapping
2. Classify each as:
   - **BLOCKING** — required to define behavior / GWT / acceptance criteria
   - **NON-BLOCKING** — implementation detail, risk, or future refinement
3. Resolve all BLOCKING questions via follow-up questions before Phase 5
4. NON-BLOCKING questions may be documented as **assumption + risk** in the handoff package

**Hard rule:** Never write GWT scenarios with vague placeholders to bypass unanswered behavioral questions.

### Edge Case Hunter Review

Before Phase 5, dispatch a read-only edge case hunter subagent to review the Phase 4 stories, rules, examples, and GWT scenarios.

→ Load `references/edge-case-hunter-prompt.md` for the full dispatch prompt.

**Purpose:** catch missing in-scope edge cases and blocking behavior ambiguity before design proposals.

**Gate:**
- Status = `Clear` → proceed to Phase 5
- Status = `Needs Clarification` → ask blocking clarification questions one at a time, update scenarios, re-run once if material behavior changed
- Do NOT proceed to design while blocking behavior questions remain unresolved

---

## Phase 5: Design Proposals

**Goal:** Propose 2–3 options. Design must emerge FROM Phase 4 scenarios — never before them.

### Proposal Format

```
Option A: <name>
  Summary: <1–2 sentences>
  Scenarios satisfied: <list GWT scenarios this handles>
  Scenarios at risk: <list any it handles partially or poorly>
  Tradeoffs:
    + <advantage>
    - <disadvantage>
  Risk: <biggest concern with this option>

Option B: <name>
  ...

Recommendation: Option <X>
  Reasoning: <cite specific scenarios that make this the strongest choice>
```

**Rules:**
- Each option validated against Phase 4 scenarios explicitly
- An option that fails critical scenarios must be flagged, not softened
- Recommendation must cite scenarios, not just preference

---

## Phase 6: Architecture Validation

**Goal:** Confirm the chosen design does not violate constraints from Phase 2.

### Quick Validation Checklist

```
[ ] Respects layer boundaries defined in Phase 2?
[ ] Follows existing patterns found in Phase 1 context scan?
[ ] No new dependencies that violate architecture constraints?
[ ] Rollback / undo strategy is defined?
[ ] No silent data migrations or breaking changes to contracts?
[ ] Performance characteristics acceptable for this layer?
[ ] No security regressions introduced?
```

**PASS** (all checked) → Proceed to Phase 7
**FAIL** (any unchecked) → Document which constraint is violated → loop back to Phase 5

For complex systems, major refactors, or ambiguous constraint violations:
→ Load `references/architecture-validation.md`

---

## Phase 7: Handoff Package

**Goal:** Produce a complete, pocket-planning-ready spec. User must approve before invoking.

### Save Spec Document

Save to this exact directory structure:

```
docs/pocket/spec/
└── YYYY-MM-DD-kebab-slug/
    └── topic-name.md
```

Example: `docs/pocket/spec/2026-05-06-user-auth-refactor/session-flow.md`

- Root: always `docs/pocket/spec/` — do NOT use `docs/plans/` or other paths
- Dir: `YYYY-MM-DD-kebab-slug` (today's date + hyphenated feature name)
- File: descriptive topic name, lowercase hyphenated
- Multiple files per dir allowed if session covers distinct sub-topics

For full spec document template with all sections:
→ Load `references/spec-template.md`

For full spec document template with all sections:
→ Load `references/spec-template.md`

### Acceptance Criteria (always inline in handoff)

```
ACCEPTANCE CRITERIA — <feature/fix name>
Date: YYYY-MM-DD | Scope confirmed: yes

Rule: <rule 1 name>
  ✓ Given <context>, When <action>, Then <expected outcome>
  ✓ Given <edge case>, When <action>, Then <outcome>
  ✗ Given <invalid input>, When <action>, Then <specific error>

Rule: <rule 2 name>
  ✓ Given <context>, When <action>, Then <expected outcome>

OPEN QUESTIONS (risks if unresolved):
  - <question> → assumed: <assumption made>

OUT-OF-SCOPE (remind pocket-planning):
  - <excluded concern>
```

### User Approval Gate

> "Spec written to `docs/pocket/spec/<path>`. Acceptance criteria above — anything to adjust before I hand this to pocket-planning?"

Wait for confirmation. Apply any changes.

### Invoke pocket-planning (MANDATORY)

**DO NOT STOP AFTER USER APPROVAL.**

**Step 1 — Identify invocation method:**
Determine how skills or agents are dispatched in your current environment.
- In Claude Code: use the `Skill` tool to invoke `pocket-planning`.
- In other agent platforms: use your platform's skill or agent dispatch mechanism.
- If no dispatch mechanism exists: load and follow the `pocket-planning` skill directly in this session.

**Step 2 — Load pocket-planning skill:**
Load the `pocket-planning` skill (already loaded at session start) and follow it completely.
Do NOT skip phases. Do NOT stop at Phase 1.

**Step 3 — Pass this context to pocket-planning:**
- Spec file path: `docs/pocket/spec/<path>`
- Acceptance criteria (full GWT list from Phase 4)
- Architecture constraints from Phase 2
- Open questions / assumptions logged in Phase 4
- Design decision from Phase 5

**This is not optional.** Pocket-grinding is incomplete until pocket-planning has received the spec and begun Phase 0 (Preflight).

**Verification:** After invoking pocket-planning, confirm it has:
- [ ] Read the spec file
- [ ] Started Phase 0 codebase scan
- [ ] Produced a Preflight Summary

If pocket-planning did not start → re-invoke with explicit instruction to begin Phase 0.

---

## Reference Triggers

| Reference | When to Load |
|-----------|--------------|
| `references/architecture-validation.md` | Phase 6: complex systems, ambiguous constraint violations, major refactors needing deep validation |
| `references/spec-template.md` | Phase 7: writing full spec doc to disk |
| `references/edge-case-hunter-prompt.md` | Phase 4: after GWT scenarios, before design proposals — find missing in-scope edge cases |
