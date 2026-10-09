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

## Operating Rules

- **Follow the user's stated scope.** Treat clear instructions, corrections, and approvals already given as authorization. Ask only when a consequential product decision remains open; do not ask the user to repeat a decision or choose a numbered option.
- **Keep grinding in discovery.** Do not implement product code, scaffolding, or migrations as part of this skill. Hand off an approved or already-authorized spec to pocket-planning for implementation planning.
- **Ground validation in evidence.** A checklist item passes only when supported by inspected codebase evidence or, for version-dependent external behavior, current documentation for the relevant version. Record the evidence with the result.
- **Keep independent review with bounded recovery.** Run the edge-case hunter after writing GWT scenarios. After the initial review attempt, allow at most two materially different prompt/context or reviewer-route recovery rounds. At the cap, report `RECOVERY_CHECKPOINT`; leave the review unresolved and do not hand off as approved. Resume only after explicit user authorization for a new bounded window.
- **Resolve failed validation with a changed action.** When evidence contradicts a design, revise the proposal and re-check the affected claims. When evidence is missing, inspect up to two distinct relevant sources or modes after the initial attempt, then record `UNVERIFIED` and the unresolved question rather than searching indefinitely or marking it PASS by assumption.
- **Honor the authorized handoff.** If the user asked for the full spec-to-planning flow, that instruction authorizes the handoff once the required artifacts are ready. Otherwise, present the completed spec and wait for approval before invoking pocket-planning.

---

## Phase 1: Context Scan

**Goal:** Understand the current state before asking a single question.

### Layered Context Protocol

**Project-level** (always scan):
- Stack, frameworks, language versions
- Dependency manifest: read `package.json` / `requirements.txt` / `Cargo.toml` / `go.mod` / `pom.xml` — list installed dependencies relevant to this feature (they are free accelerators; hand-rolling what an installed dep already does is waste)
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

If the user explicitly requested `pocket-grinding`, recommend `hotfix` briefly but continue with grinding unless the user switches. If the skill was selected from a general request, present the choice once and wait:

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

**Goal:** Make the proposed scope and boundaries explicit before discovery.

### Scope Definition Template

Draft the scope from the user's request and project context. Present it for correction when it adds a consequential assumption or leaves a product decision open. If it preserves the user's stated intent, continue without asking for redundant confirmation.

```
IN-SCOPE:
  - <explicit behavior 1>
  - <explicit behavior 2>

OUT-OF-SCOPE (intentionally excluded; write "none identified" if applicable):
  - <excluded concern 1>
  - <excluded concern 2>

ARCHITECTURE CONSTRAINTS:
  - Layers this work may touch: <list>
  - Layers this work must NOT touch: <list>
  - Patterns that must be followed: <list>
```

**Rules:**
- Ask a focused question only when the answer could materially change scope. Ask one question per message in the conversation; do not depend on a specific question UI or tool.
- If scope spans independent subsystems, identify the boundaries and propose a useful sequence. Work through the requested scope without forcing a separate approval cycle for each part.
- Do not treat silence as approval for a consequential choice the user has not made. When the user's request already settles the choice, proceed.

---

## Phase 3: Discovery — Three Amigos

**Goal:** Surface requirements, constraints, and risks through structured questioning from three expert lenses.

Use the three lenses to find missing behavior, constraints, and risks. Ask only questions whose answers could change the scenarios, acceptance criteria, or design. There is no minimum question count. Use facts already present in the conversation and codebase; do not ask for them again. Ask one focused question per message and rotate lenses when useful.

**Discovery Sufficiency Gate:** Do NOT advance to Phase 4 until each in-scope behavior has:
- User / actor identified
- Trigger/action identified
- Expected successful outcome identified
- At least one relevant failure/edge case identified, or a reason it does not apply
- Data/input boundaries identified, or a reason they do not apply
- Acceptance signal identified (how we know it works)

If an item is missing, first check the conversation and project evidence. Ask the user only when the missing detail is a consequential product decision. For non-blocking details, use an evidence-based default, label it as an assumption, and record the risk in the spec. Never invent a requirement or silently turn a guess into a confirmed behavior.

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
- "Is there an established library — or an already-installed dependency from the Phase 1 manifest scan — that solves part of this, or must it be custom? Why?"
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
- Re-run the Discovery Sufficiency Gate whenever new information changes a behavior; do not wait for a question-count threshold.
- If an answer reveals a consequential unknown, ask a focused follow-up. Otherwise record the uncertainty and proceed with a clearly labeled assumption.
- If the user says "I don't know," recommend a safe default when evidence supports one. Ask the user only if the choice changes product behavior, scope, or risk tolerance.
- Ask one question per message. Do not call a dedicated question UI/tool unless the environment supports it and the user has not asked to avoid it.
- Advance when the in-scope behaviors can be written as concrete Given/When/Then scenarios, not when a question count is reached.

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

### Edge Case Hunter Review (Required)

Run this review after writing GWT scenarios and before proposing designs. It is an independent review step; do not replace it with your own self-review.

Dispatch a read-only subagent named `edge-case-hunter` to review the Phase 4 stories, rules, examples, and GWT scenarios.

→ Load `references/edge-case-hunter-prompt.md` for the full dispatch prompt.

**Purpose:** catch missing in-scope edge cases and blocking behavior ambiguity before design proposals.

**Next action:**
- `Clear` → proceed to Phase 5.
- `Needs Clarification` → resolve consequential behavior questions, update the affected scenarios, and run a focused independent review of the changes.
- Review is inconclusive or dispatch fails → improve the review prompt or try another available subagent route, for at most two materially different recovery rounds. At the cap, report `RECOVERY_CHECKPOINT`, state why the independent review is incomplete, and wait for explicit user authorization before another window. Do not claim it passed.
- If no independent reviewer can run within the two-round budget, state that limitation and leave the review unresolved at `RECOVERY_CHECKPOINT`. Do not claim it passed or hand off; wait for explicit user authorization before a new bounded window or an explicit decision to proceed without the required independent review.
- Do not move to design or handoff while blocking behavior questions remain unresolved.

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
- **Build-vs-buy:** for commodity problems (crypto, auth, parsing, retry/backoff, date/time, validation, caching, …) at least one option must be library-based — prefer dependencies already installed (Phase 1 manifest scan). If no library option is proposed, state explicitly why none is viable. Never hand-roll crypto or auth without naming the rejected library and the reason.
- For every external library, framework, API, or platform capability that materially affects an option, verify the behavior before recommending it. Identify the exact installed or proposed version from the manifest/lockfile. Use Context7 MCP in order: `resolve-library-id`, then `query-docs` with the matching version when available. If Context7 has no relevant result, check the vendor's official documentation or release notes with web search. Do not rely on memory or latest-version docs when the project uses a different version; record the source, version, and finding.

---

## Phase 6: Architecture Validation

**Goal:** Verify the recommended design against the actual codebase, stated constraints, and current version-matched external documentation.

Do not mark this phase complete from the Phase 1 summary or a checklist alone. Re-open the relevant source files and verify each material claim directly.

### Validation Procedure

1. **List the claims to verify.** Include the recommended design, affected GWT scenarios, architecture constraints, integration points, dependencies, and any assumptions that could change implementation.
2. **Inspect the codebase.** Read the affected modules and their callers, interfaces, data models or schemas, configuration, tests, migrations, and existing patterns. Use repository search to find all relevant references; do not infer that a pattern is absent from one empty search result.
3. **Verify external behavior.** For each version-dependent library/framework/API/platform claim, identify the version in the lockfile or the version proposed for adoption. Use Context7 MCP's `resolve-library-id` followed by `query-docs`, selecting the matching version ID when available. If Context7 is unavailable or inconclusive, use the vendor's versioned documentation, API reference, or release notes. For standards or other changing external constraints, use current primary sources. Record the direct source, version, and publication or access date.
4. **Compare evidence with the spec.** For each claim, state whether the code or documentation supports it, contradicts it, or leaves it unresolved. Use file paths and symbols (or line references where stable) for code evidence, and direct source links plus version/date for external evidence.
5. **Resolve findings.** Revise the proposal when evidence contradicts it, then re-check the changed claims. If a source is unavailable or inconclusive, try up to two distinct relevant sources or modes after the initial attempt. Do not repeat an unchanged search. If the evidence remains inconclusive at the cap, mark the claim `UNVERIFIED`, explain its impact, and carry it as an open question or explicit assumption.

Use Context7 for library documentation; it cannot validate this repository's internal architecture. Use the codebase for internal structure and official current sources for external behavior. If a claim cannot be verified after distinct sources, mark it `UNVERIFIED`, explain its impact, and carry it as an open question or explicit assumption. Never mark it `PASS` by inference.

### Quick Validation Checklist

For each applicable item, record `PASS`, `FAIL`, `UNVERIFIED`, or `N/A` with evidence. Use `N/A` only with a reason. A `PASS` requires specific supporting evidence; an unchecked box is not a pass.

| Check | Evidence to inspect | Result | Evidence / finding |
|---|---|---|---|
| Respects stated layer and module boundaries | Relevant modules, imports, interfaces, and constraints | | |
| Fits existing patterns and contracts | Callers, models/schemas, APIs/events, tests, and migrations | | |
| Dependencies and build-vs-buy are justified | Manifest/lockfile and version-matched official docs | | |
| Rollback, compatibility, and data changes are defined | Migration, deployment, and contract behavior | | |
| Performance and security risks are addressed | Relevant code paths, tests, and current requirements | | |

**PASS** → Every applicable material claim is supported and no blocking finding remains.
**FAIL** → Evidence contradicts the proposal; revise Phase 5 and re-check affected claims.
**UNVERIFIED** → Evidence is missing or inconclusive; try another relevant source, then document the exact gap and its impact.
**N/A** → Explain why the check does not apply.

Do not describe the design as fully validated while a material claim remains
`UNVERIFIED`. Resolve it with another source, revise the design to remove the
dependency, or present the risk for the user's decision. Non-material gaps may be
carried as explicit assumptions with a mitigation.

For complex systems, major refactors, or ambiguous constraint violations, also load the deep protocol. It supplements this evidence-based procedure; it does not replace codebase or documentation checks:
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

### Pre-Handoff Checkpoint

Before handoff, verify that the independent review and evidence-based architecture validation are complete:

```
[ ] Edge-case hunter reviewed the Phase 4 GWT scenarios
[ ] Blocking review findings are resolved and reflected in the scenarios
[ ] Phase 6 validation evidence is recorded in the spec
[ ] All blocking architecture findings are resolved
[ ] Any remaining material unverified claim and its impact are explicit for the user
```

If any item is incomplete, return to the relevant phase and take the next available
verification or review step. If an independent reviewer or required evidence source
is unavailable after trying alternatives, state the exact gap and impact. Ask the
user only when their decision is required to accept or exclude that risk.

### User Approval and Handoff

> "Spec written to `docs/pocket/spec/<path>`. Acceptance criteria above — anything to adjust before I hand this to pocket-planning?"

If the user has not already authorized the spec-to-planning handoff, wait for
approval and apply requested changes. A clear earlier instruction to complete that
flow counts as authorization; do not ask for the same approval again. If the user
asked only for a spec, stop after delivering it unless they authorize planning.

### Neutral spec approval handoff

After the user approves or has already authorized the spec handoff, emit the neutral lifecycle event before invoking pocket-planning. The event records local artifact references; it does not require an external consumer and does not block the local planning handoff when no consumer is installed.

```bash
pocketto-pi lifecycle transition <spec_dir> spec-approved --artifact spec:<kind>:<relative-path>:<sha256> --json --contract 3
```

Pass the approved spec as a spec-root artifact reference. Core records the event and its `artifact_refs` in `lifecycle.json`; artifact contents are not copied into the event. Preserve the command result with the plan handoff context.


### Invoke pocket-planning (MANDATORY)

**DO NOT STOP AFTER USER APPROVAL.**

**Step 1 — Identify invocation method:**
Determine how skills or agents are dispatched in your current environment.
- In Claude Code: use the `Skill` tool to invoke `pocket-planning`.
- In other agent platforms: use your platform's skill or agent dispatch mechanism.
- If no dispatch mechanism exists: load and follow the `pocket-planning` skill directly in this session.

**Step 2 — Load pocket-planning skill:**
Load the `pocket-planning` skill if it is not already available, then follow it completely.
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
