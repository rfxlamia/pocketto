# Task Decomposition — Advanced Patterns

Load this during Phase 3 when: a rule is ambiguous to decompose, tasks share an interface, the feature is event-driven, or a phased rollout is involved.

## Contents
- [Shared Interface Pattern](#shared-interface-pattern)
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
