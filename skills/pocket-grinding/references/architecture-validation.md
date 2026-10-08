# Architecture Validation — Deep Protocol

Load this during Phase 6 for complex systems, major refactors, ambiguous constraints, or any time the quick checklist surfaces a potential failure. This protocol supplements Phase 6's required evidence gathering; it does not replace direct codebase inspection or current external documentation.

## Contents
- [When the Quick Checklist Is Not Enough](#when-the-quick-checklist-is-not-enough)
- [Anti-Pattern Catalog](#anti-pattern-catalog)
- [Constraint Checklist by Architecture Type](#constraint-checklist-by-architecture-type)
- [Validation Decision Tree](#validation-decision-tree)
- [Output Format for Phase 6](#output-format-for-phase-6)

---

## When the Quick Checklist Is Not Enough

Use this reference when any of these are true:
- The design touches 3+ layers or modules simultaneously
- A new architectural pattern is being introduced
- The change crosses service/domain boundaries
- The constraint violation is "maybe" — not clearly pass or fail
- The feature involves shared state, events, or distributed concerns

The checklist is a reminder of what to inspect, not evidence that a design is valid.
Do not mark a check as passing from memory, a high-level Phase 1 summary, or an
unchecked assumption.

---

## Evidence-Based Validation

For every material architecture or feasibility claim in the recommended design:

1. **Inspect the repository.** Read the affected modules, interfaces, callers,
   schemas/models, configuration, tests, migrations, and relevant dependency
   manifests or lockfiles. Search for references before concluding a pattern or
   capability does not exist.
2. **Check version-dependent claims.** Identify the installed or proposed version
   from the lockfile. Resolve the exact library with Context7 and query the relevant
   behavior for that version. If Context7 is unavailable or inconclusive, use the
   vendor's official documentation, API reference, or release notes. For changing
   external standards or platform behavior, consult current primary sources.
3. **Record evidence with each result.** Cite repository paths and symbols (line
   references where stable). For external sources, include the direct URL, version
   or publication date, and the specific behavior it confirms or contradicts.
4. **Separate findings from assumptions.** Mark a claim `PASS`, `FAIL`,
   `UNVERIFIED`, or `N/A`. `PASS` requires supporting evidence. Explain every `N/A`.
   Never turn missing evidence into a pass.
5. **Change the investigation when evidence stalls.** Search another relevant
   module, test, official source, or version-specific reference. Do not repeat the
   same query unchanged or stop only because a retry count was reached.

Context7 can establish external library behavior; it cannot establish how this
repository is structured. Repository inspection and version-matched external docs
answer different questions, so use both whenever a design claim depends on both.

If distinct sources still do not establish a material claim, mark it `UNVERIFIED`,
state its effect on the design, and carry it as an open question or explicit
assumption. Do not claim full validation. Ask the user only when accepting the risk,
changing scope, or choosing the behavior requires their judgment.

---

## Anti-Pattern Catalog

Check the proposed design against these known failure modes:

### Layering Violations
- **God Object**: a single class/module accumulating responsibilities from multiple layers
- **Circular Dependency**: module A imports B, B imports A — even indirectly through a chain
- **Layer Skipping**: UI/controller calling repository/DB directly, bypassing service layer
- **Leaky Abstraction**: internals of one layer exposed as part of another layer's interface

### Coupling Failures
- **Shotgun Surgery**: one logical change requires edits across many unrelated files
- **Feature Envy**: a module uses data from another module more than its own
- **Inappropriate Intimacy**: two modules know too much about each other's internals
- **Shared Mutable State**: multiple components writing to the same data without coordination

### Contract Violations
- **Implicit Interface Change**: modifying a function signature or DB schema without updating all callers
- **Silent Breaking Change**: changing behavior of a public API without version or deprecation signal
- **Undocumented Side Effect**: a function produces observable state change not reflected in its name/signature

### Concurrency Hazards
- **Race Condition**: outcome depends on order of concurrent operations without synchronization
- **Deadlock Risk**: two operations waiting on each other's lock
- **Non-Idempotent Mutation**: an operation that should be safely retried produces different results on repeat

---

## Constraint Checklist by Architecture Type

### Layered / Clean Architecture
```
[ ] Domain layer has zero dependencies on infrastructure or UI?
[ ] Use-case / application layer depends only on domain interfaces?
[ ] Infrastructure implementations (DB, HTTP, queue) are behind interfaces?
[ ] No direct framework imports inside domain objects?
[ ] Dependency inversion applied at every boundary crossing?
```

### Modular Monolith
```
[ ] Each module owns its data — no direct cross-module DB queries?
[ ] Cross-module communication only via published interfaces / events?
[ ] No shared utility that creates implicit coupling between modules?
[ ] Module boundaries respected even for "quick" fixes?
```

### Microservices / Distributed
```
[ ] Service does not synchronously call another service in its critical path without fallback?
[ ] Data duplication strategy is explicit (event-driven sync vs. direct query)?
[ ] API contract versioned — no silent breaking changes to consumers?
[ ] Circuit breaker / retry / timeout defined for cross-service calls?
[ ] Distributed transaction risk assessed — saga or compensating transaction planned?
```

### Event-Driven
```
[ ] Event schema is versioned and backward-compatible?
[ ] Consumers are idempotent — safe to receive duplicate events?
[ ] Ordering requirements documented and handled?
[ ] Dead-letter queue / error handling defined for failed consumers?
```

---

## Validation Decision Tree

```
Is the design change contained within one module/layer?
  YES → inspect the affected module and its callers; use the evidence procedure above
  NO  → continue below

Does it cross a domain/service boundary?
  YES → check anti-patterns: leaky abstraction, contract violation, distributed hazards
  NO  → check anti-patterns: coupling failures, layering violations

Does it touch shared state or events?
  YES → check concurrency hazards + event-driven checklist
  NO  → proceed if above checks pass

Does it change a public contract (API, schema, event shape)?
  YES → versioning strategy required — document it in spec
  NO  → proceed if above checks pass
```

**If evidence contradicts the design:**
1. Name the specific anti-pattern or constraint violated
2. Describe exactly which part of the proposed design triggers it
3. Propose a minimal correction
4. Loop back to Phase 5 with the correction as a constraint, then re-check the affected claims

---

## Output Format for Phase 6

Document validation result in the handoff package:

```
ARCHITECTURE VALIDATION RESULT
Status: PASS | FAIL | CONDITIONAL PASS | UNVERIFIED

Checks run: <list codebase, architecture, and external-doc checks performed>
Versions and sources: <dependency versions, direct documentation links, publication dates>
Anti-patterns reviewed: <list which were checked>

Findings:
  ✓ <claim> — <what evidence supports it>; code: <path:symbol>; docs: <URL + version/date, or N/A>
  ✗ <claim> — <contradicting evidence>; code/docs: <specific source>
  ⚠ <claim> — conditional on <mitigation>; evidence: <specific source>
  ? <claim> — unverified because <specific evidence gap and impact>; sources tried: <list>

Mitigations required before handoff (if any):
  - <mitigation 1>
  - <mitigation 2>
```
