# Spec Document Template

Load this during Phase 7 when writing the full spec to `docs/pocket/spec/`.

Save path pattern: `docs/pocket/spec/{date}-{kebab-slug}/{topic}.md`

## Contents
- [Full Template](#full-template)
- [Naming Conventions](#naming-conventions)
- [Minimal Spec](#minimal-spec-for-small-features)

---

## Full Template

Copy and fill in. Remove sections that don't apply — but never remove Acceptance Criteria or Out-of-Scope.

```markdown
# <Feature / Fix Name>

**Date:** YYYY-MM-DD
**Status:** draft | approved
**Author:** brainstorm session
**Spec path:** docs/pocket/spec/YYYY-MM-DD-<slug>/<topic>.md

---

## Summary

<2–4 sentences. What is this? Why does it exist? What problem does it solve?>

---

## Context

### Current State
<What exists today? How does the current system behave in this area?>

### Problem / Motivation
<What's broken, missing, or insufficient? Cite specific evidence from Phase 1 context scan.>

### Related Areas
<Files, modules, APIs, or services that are adjacent to this work.>

---

## Scope

### In-Scope
- <explicit behavior 1>
- <explicit behavior 2>

### Out-of-Scope
- <excluded concern 1 — with brief reason why excluded>
- <excluded concern 2>

---

## Architecture Constraints

<Constraints confirmed during Phase 2 + validated in Phase 6.>

- Layers this work may touch: <list>
- Layers this work must NOT touch: <list>
- Patterns that must be followed: <list>
- Architecture validation result: PASS | CONDITIONAL PASS (see findings below if conditional)

---

## Stories + Scenarios

### Story: <story name>
> As a <who>, I want <what>, so that <why>

**Rule 1: <rule name>**
- Example A: <input → output>
- Example B: <edge case → output>

```gherkin
Scenario: <happy path name>
  Given <precondition>
  When  <action>
  Then  <outcome>

Scenario: <edge case name>
  Given <edge precondition>
  When  <action>
  Then  <outcome>

Scenario: <failure case name>
  Given <failure precondition>
  When  <action>
  Then  <specific error or degraded response>
```

**Rule 2: <rule name>**
- Example C: <input → output>

```gherkin
Scenario: <name>
  Given ...
  When  ...
  Then  ...
```

*(Add more stories if needed)*

---

## Acceptance Criteria

Structured summary — this is what pocket-planning uses as the definition of done.

```
Rule: <rule 1 name>
  ✓ Given <context>, When <action>, Then <outcome>
  ✓ Given <edge case>, When <action>, Then <outcome>
  ✗ Given <invalid>, When <action>, Then <error>

Rule: <rule 2 name>
  ✓ Given <context>, When <action>, Then <outcome>
```

---

## Design Decision

**Chosen option:** Option <X> — <name>

**Summary:** <1–2 sentences on what was chosen and why>

**Rejected options:**
- Option <Y>: rejected because <scenario it failed or constraint it violated>

**Key tradeoffs accepted:**
- <tradeoff 1>
- <tradeoff 2>

---

## Open Questions / Assumptions

| Question | Resolution | Risk if Wrong |
|----------|------------|---------------|
| <question 1> | assumed: <assumption> | <consequence> |
| <question 2> | assumed: <assumption> | <consequence> |

*(Empty table = all questions resolved before handoff)*

---

## Implementation Notes

<Optional. Only include if there are non-obvious constraints pocket-planning must know.>

- <note 1: e.g., "must run behind feature flag X before full rollout">
- <note 2: e.g., "existing migration M must complete before this is deployed">
- <note 3: e.g., "service Y must be deployed first — dependency order">

---

## Rollback Plan

<How do we undo this if it goes wrong in production?>

- <step 1>
- <step 2>

*(If feature-flagged: "disable flag X — no deploy needed")*
```

---

## Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Directory slug | `YYYY-MM-DD-<kebab>` | `2026-05-06-cart-checkout-fix` |
| Topic file | `<kebab-topic>.md` | `payment-edge-cases.md` |
| Multi-topic session | Multiple files in same dir | `auth-flow.md`, `token-refresh.md` |
| Status field | `draft` until user says approved | Change to `approved` after Phase 7 gate |

---

## Minimal Spec (for small features)

When full template is overkill, use this condensed version:

```markdown
# <Feature Name>
Date: YYYY-MM-DD | Status: approved

## What
<1–2 sentences>

## Scope
In: <list> | Out: <list>

## Acceptance Criteria
Rule: <name>
  ✓ Given ..., When ..., Then ...
  ✗ Given ..., When ..., Then ...

## Assumptions
- <assumption> → risk: <consequence>
```
