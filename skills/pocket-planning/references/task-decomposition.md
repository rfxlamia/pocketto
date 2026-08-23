# Task Decomposition — Advanced Patterns

Load this during Phase 3 when: a rule is ambiguous to decompose, tasks share an interface, the feature is event-driven, or a phased rollout is involved.

## Contents
- [Shared Interface Pattern](#shared-interface-pattern)
- [Shared Helper Pattern](#shared-helper-pattern)
- [Cross-Unit Verification Decision](#cross-unit-verification-decision)
- [Event-Driven Decomposition](#event-driven-decomposition)
- [Phased Rollout Decomposition](#phased-rollout-decomposition)
- [Over-Split vs Under-Split Detection](#over-split-vs-under-split-detection)
- [Worked Example: MiMo Codespace](#worked-example-mimo-codespace)

---

## Shared Interface Pattern

**Problem:** Two tasks (e.g., backend + frontend) depend on a shared contract (API schema, event type, interface definition).

**Solution:** Extract the contract as its own prerequisite task.

```
T1: Define shared interface / schema / types   [prereq]
T2: Backend implementation                     [depends: T1]
T3: Frontend implementation                    [depends: T1] [parallel: T2]
```

**Why:** If T2 and T3 start from their own assumptions about the contract, they diverge. T1 anchors both.

**When to apply:**
- Backend and frontend both reference a data shape
- Two modules communicate via an event or message format
- Multiple files import from a shared types file

---

## Shared Helper Pattern

**Problem:** Two or more tasks need the same *logic* (validation, formatting, parsing, error mapping, retry) — not just a shared contract.

**Solution:** Extract the helper as its own prerequisite task — named and domain-scoped, never a generic `utils`.

```text
T1: Shared helper module (e.g. auth/token-utils)   [prereq]
T2: Feature A, imports helper                      [depends: T1]
T3: Feature B, imports helper                      [depends: T1] [parallel: T2]
```

**Why:** Parallel subagents cannot see each other's code. Without T1, T2 and T3 each write their own copy of the same logic — and no later phase merges them, so the duplication ships.

**When to apply:**
- Two tasks' steps describe the same computation, validation, or transformation
- A GWT precondition repeats across tasks in different modules
- You catch yourself pasting identical step content into two packets (the No Placeholders
  rule makes duplication visible — treat that as a decomposition signal, not a chore)

**In Pocket Packets:**
- T1's DELIVERABLE: unit-tested helper API (its own GWT scenarios)
- T2/T3's QUALITY BAR must-not: reimplementing the helper locally instead of importing it

---

## Cross-Unit Verification Decision

**Problem:** A GWT scenario in the spec is only true when two or more implementation units
collaborate. Unit tests on each side can all pass while the collaboration is still broken.

**Solution:** Decide the integration verification during planning (Phase 3 Rule 6), not during
execution. Two shapes, one question.

```
Is the integration verification independently useful AND runnable
once its dependencies complete?
  YES → own integration-test task:  T_n: Integration test: <scenario> [depends: T_a, T_b]
  NO  → extra TDD cycle inside the owning task
```

**Own task — when:**
- The scenario is a named acceptance criteria rule in its own right
- It exercises a seam other work will keep depending on (producer → consumer, API → client)
- It needs its own fixture, harness, or test file (`tests/integration/…`)

**Inline cycle — when:**
- The collaboration is an implementation detail of one task's deliverable
- The second unit is a thin adapter the owning task also creates
- Splitting it out would produce a task that cannot fail independently of its parent

**In Pocket Packets, either way:**
- The test intent names the level explicitly: `Level: integration`
- `Exercise through:` names the outer boundary — the entry point a caller actually uses,
  not either unit's internals
- `Test doubles:` doubles only what is outside the collaboration (network, clock, third-party
  service). Never mock a unit whose behavior the scenario is meant to prove
- `Expected RED:` states the collaboration failure, not a missing symbol

Tasks whose test level is arguable — could plausibly be unit or integration — get the
`[test-risk]` marker appended after their dependency annotation. That marker is a Phase 6
trigger.

---

## Event-Driven Decomposition

**Problem:** Feature uses events, queues, or pub/sub. Producer and consumer are separate concerns.

**Solution:** Decompose around event lifecycle.

```
T1: Define event schema + types                [prereq]
T2: Implement event producer                   [depends: T1]
T3: Implement event consumer / handler         [depends: T1] [parallel: T2]
T4: Integration test (producer → consumer)     [depends: T2, T3]
```

**In Pocket Packets:**
- T2's QUALITY BAR: must-not emit events outside the schema defined in T1
- T3's QUALITY BAR: must handle unknown event fields gracefully (forward-compat)
- T4's DELIVERABLE: end-to-end GWT scenarios covering the full flow

---

## Phased Rollout Decomposition

**Problem:** Feature needs to be behind a flag, or has a migration step before full cutover.

**Solution:** Decompose into phases as explicit tasks.

```
T1: Implement feature behind flag              [prereq]
T2: Migrate existing data / state              [depends: T1]
T3: Enable feature (remove flag or cutover)    [depends: T2]
```

**In Pocket Packets:**
- T1's STOP CONDITIONS: Done when feature works with flag=ON, flag=OFF leaves old behavior intact
- T2's QUALITY BAR: migration is idempotent — safe to run twice
- T3's DELIVERABLE: GWT scenarios for full post-cutover behavior

---

## Over-Split vs Under-Split Detection

### Signs of Over-Splitting
- A task is "create one function" — too small, bundle with caller
- Task N can't be verified without Task N+1 being done — they're actually one task
- More than 6 steps inside a task — reconsider splitting it

### Signs of Under-Splitting
- Task touches 5+ files across 3+ modules — split by module boundary
- Task includes both "define contract" and "implement against it" — split (see Shared Interface Pattern)
- Task has two independent GWT rules — split into one task per rule
- Steps inside task say "if X is done, otherwise do Y" — this is a dependency disguised as a step
- Two tasks' steps describe the same logic — that's a shared helper `[prereq]` task in disguise (see Shared Helper Pattern)

### Decision: Split or Step?

```
Is the second piece of work useful/releasable without the first?
  YES → two tasks (T2 depends on T1)
  NO  → one task, second piece is a step inside T1

Can the second piece be done by a different subagent concurrently?
  YES → two parallel tasks
  NO  → one task with sequential steps
```

---

## Worked Example: MiMo Codespace

Applying decomposition to the MiMo Codespace spec (5 acceptance criteria rules → 10 tasks):

```
T1:  Scaffold Tauri 2.x project (Rust crate + React/Vite + axum skeleton)
     [prereq] — complexity: lightweight

T2:  WebSocket server endpoint (connect/disconnect/message routing in axum)
     [depends: T1] — complexity: standard

T3:  Chat streaming — token-by-token API → WebSocket → frontend
     [depends: T2] — complexity: standard

T4:  ESC cancel streaming (abort signal through WebSocket)
     [depends: T2] [parallel: T3] — complexity: lightweight

T5:  AES-256-GCM credential storage module (encrypt/decrypt + secret.key)
     [depends: T1] [parallel: T2] — complexity: standard

T6:  Settings page UI + first-launch gate (React + Tauri invoke)
     [depends: T5] — complexity: standard

T7:  Session persistence (JSON read/write to ~/.mimo/sessions/)
     [depends: T2] — complexity: lightweight

T8:  Prompt caching — in-memory LRU with hash-based cache key
     [depends: T3] — complexity: standard

T9:  Auto-retry with exponential backoff (3x, axum middleware layer)
     [depends: T3] — complexity: lightweight

T10: Error UI — error in chat + retry button (React component)
     [depends: T9] — complexity: lightweight
```

Parallelizable groups:
- After T1: T2 and T5 can run concurrently
- After T2: T3, T4, T7 can run concurrently
- After T3: T8 and T9 can run concurrently

Key decomposition decisions made:
- T3 and T4 split (both depend on T2, independent concerns — stream vs cancel)
- T5 and T2 parallelized (no shared dependency after T1)
- T9 (backend retry) separated from T10 (frontend error UI) — different layers
