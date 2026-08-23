# Test Strategy Audit — Dispatch Prompt

Load this during Phase 6 **only when a trigger fires**. The audit is conditional and skipped by default.

**Purpose:** Review the test *strategy* of a plan that already carries test intent. Return findings only.

**When:** After the Spec Reviewer returns Approved, and at least one trigger holds:

1. A GWT scenario spans 2+ implementation units (Phase 3 Rule 6 fired)
2. The unit vs integration vs E2E boundary is genuinely ambiguous for some task
3. Persistence, concurrency, networking, or an external service materially changes how a task must be tested
4. A task carries the `[test-risk]` marker

No trigger → do not dispatch. Record `TEST STRATEGY AUDIT: skipped — no trigger fired` and proceed to Phase 7.

---

## What This Audit Is Not

The audit does **not**:

- generate test source code — the implementer writes the RED test during execution
- prescribe imports, function signatures, fixture shapes, or implementation detail
- return a rewritten execution plan
- restate coverage the Spec Reviewer already checked (placeholders, commit steps, file map)

It reviews the seven test-intent fields already present in each behavioral task's Step 1 and reports where they are wrong or missing. Nothing else.

---

## Dispatch

```
Mode: Read-only review
Complexity: Standard
Description: "Test strategy audit — findings only, no code"

Prompt:
  You are a test strategy auditor. The plan below already carries test INTENT for
  every behavioral task — test file, level, GWT behavior, boundary to exercise,
  test doubles, expected RED reason, and run command. It deliberately contains NO
  test source code, because the implementation does not exist yet.

  Plan file:      [PLAN_FILE_PATH]
  Spec file:      [SPEC_FILE_PATH]
  Codebase info:  [PREFLIGHT_SUMMARY — test framework, conventions, existing patterns]
  Triggered by:   [WHICH TRIGGERS FIRED, AND FOR WHICH TASKS]

  Your job is to find defects in the test strategy. Report findings. Do NOT write
  test code, do NOT prescribe implementation detail, and do NOT return a rewritten
  plan. Return only the findings block described under Output Format.

  ## Finding Categories (the only things you may report)

  1. MISSING BEHAVIOR — a spec GWT scenario, edge case, or negative rule that no
     task's test intent proves.
  2. WRONG TEST LEVEL — a behavior asserted at unit level that can only be observed
     across a boundary, or an E2E test used where a unit test would prove the same
     thing faster and more precisely.
  3. WRONG MOCK BOUNDARY — the unit under test is itself mocked; a collaborator that
     carries the behavior being proved is mocked away; or a real external service /
     network / clock is used where a double is required.
  4. MISSING INTEGRATION VERIFICATION — a GWT scenario needs 2+ units collaborating
     but no task, and no extra TDD cycle inside an owning task, verifies the
     collaboration.
  5. TDD ORDERING VIOLATION — a task's steps implement before the failing test, are
     missing "run test — verify FAIL", or are missing the PASS / refactor / commit
     steps. Structural tasks marked `[no-tdd — structural task]` are exempt.

  Anything outside these five categories → do not report it.

  ## Calibration

  - Report a finding only if it would cause a real defect, a missed requirement, or
    a test that cannot fail for the right reason.
  - "Expected RED" that does not describe a reason the test fails TODAY is a finding
    (category 5) — it means the test could pass vacuously.
  - Test doubles listed without saying what must NOT be mocked is a finding only when
    the ambiguity could lead to mocking the unit under test.
  - Style, naming, and assertion-count preferences → not findings.
  - Nothing wrong → return `Status: Clean` with an empty findings list. An honest
    clean result is more useful than a padded one.

  ## Output Format

  ### Test Strategy Audit

  **Status:** Clean | Findings

  **Findings:**
  - [Task N, Step X] CATEGORY — <what is wrong> → <what the test intent should assert
    or which boundary it should cross instead>

  **Integration verification needed (if any):**
  - <scenario> — spans <T_a>, <T_b> → suggest: own task `[depends: T_a, T_b]`
    | extra TDD cycle inside <T_n>

  **Summary:** <one line — triggers reviewed, tasks reviewed, findings count>
```

---

## Applying the Return

1. Read the findings. Each one names a task and step.
2. Edit those tasks **in place** in the plan draft. Do not accept a wholesale plan replacement — if the subagent returned one, extract the findings and ignore the rest.
3. For each `MISSING INTEGRATION VERIFICATION` finding, apply Phase 3 Rule 6:
   - independently useful and runnable after its dependencies → new integration-test task, `[depends: T_a, T_b]`
   - otherwise → extra TDD cycle inside the owning task
4. **If any task was added, re-run the Phase 3 circular dependency check** on the full task list before Phase 7.
5. Record the outcome for the Phase 7 approval message: `Test strategy audit: run on <tasks> — <N> findings applied`.

**If the audit returns BLOCKED or NEEDS_CONTEXT:**

- Common cause: test framework not identified in preflight → confirm the framework with the user, update Preflight Summary, re-dispatch once
- Common cause: a task's OBJECTIVE is too vague to judge its test level → fix that OBJECTIVE, re-dispatch once
- **Maximum 1 retry.** Blocked again → escalate: "Test strategy audit blocked on task `<task name>`. OBJECTIVE text: `<text>`. Please clarify scope or confirm the task is non-testable `[no-tdd — structural]`."
