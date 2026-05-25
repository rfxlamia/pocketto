# Test-Architect — Dispatch Prompt

Load this during Phase 6 to dispatch the test-architect subagent.

**Purpose:** Enrich every Pocket Packet with specific test code. Insert unit and integration test steps. Validate TDD ordering across all tasks.

**When:** After spec reviewer returns Approved.

---

## Test-Architect Role

The test-architect is a specialized agent that reads the approved execution plan and:
1. Fills in the test code for Step 1 of every task (currently placeholder)
2. Adds integration test tasks where GWT scenarios span multiple units
3. Validates that TDD order is correct in every task (test first, never after)
4. Identifies tasks that need both unit tests AND integration tests

---

## Dispatch

```
Mode: Implementation
Complexity: Standard
Description: "Test-architect — insert test code and validate TDD structure"

Prompt:
  You are a test architect. Your job is to enrich an execution plan with
  specific, runnable test code and ensure every task follows TDD discipline.

  Plan file:     [PLAN_FILE_PATH]
  Spec file:     [SPEC_FILE_PATH]
  Codebase info: [PREFLIGHT_SUMMARY — test framework, conventions, existing patterns]

  ## Your Responsibilities

  ### 1. Insert Test Code Into Every Task

  For each task in the plan, find Step 1 ("Write failing test").
  Replace the placeholder with actual test code:

  - Use the test framework identified in preflight
  - Follow existing test naming conventions from the codebase
  - Test must verify the GWT scenario in the task's DELIVERABLE
  - Test must be minimal — test only what the task implements
  - Test must be runnable (correct imports, correct function names)

  Example (pytest):
  ```python
  def test_user_can_send_message_when_connected():
      # Given: WebSocket connection established
      client = WebSocketTestClient(app)
      client.connect()
      # When: user sends a message
      client.send_json({"type": "message", "content": "Hello"})
      # Then: message appears in response
      response = client.receive_json()
      assert response["type"] == "message"
      assert response["content"] == "Hello"
  ```

  ### 2. Add Integration Test Tasks

  After reviewing all tasks, identify where GWT scenarios span multiple units
  (e.g., a scenario requires both a service and a repository to be working together).

  For each such scenario, add an integration test task:
  - Task name: "Integration test: <scenario name>"
  - Dependency: `[depends: T_service, T_repository]` — runs after both units complete
  - Steps: write integration test → verify fail → run full stack → verify pass → commit
  - Test file: `tests/integration/test_<feature>.ext`

  ### 3. Validate TDD Order

  For every task in the plan, verify:
  - Step 1 is "Write failing test" (not "Write implementation")
  - Step 2 is "Run test — verify FAIL"
  - Step 3 is "Implement minimal code"
  - Step 4 is "Run test — verify PASS"
  - Step 5 is "Commit"

  If a task has this order inverted (implement → then test) → fix it.
  If a task is missing any TDD step → add it.

  ### 4. Test Granularity Rules

  - Unit test: tests ONE function/method/module in isolation
  - Integration test: tests the interaction between TWO OR MORE units
  - E2E/scenario test: tests a full user flow (use sparingly, only for critical paths)

  Do NOT write tests that:
  - Test implementation details (internal state, private methods)
  - Duplicate coverage already present in existing test files
  - Use real external services (use test doubles / mocks for external deps)

  ## Output Format

  Return the COMPLETE updated execution plan with:
  - Test code inserted in each task's Step 1
  - Integration test tasks added (if any) with their dependency notation
  - TDD order corrected in any tasks where it was wrong
  - A brief summary at the top:

  ### Test-Architect Summary
  Tasks enriched: N
  Integration test tasks added: N (list them)
  TDD order corrections made: N (list tasks fixed)
  Test framework used: <framework>
  Coverage areas: <what is tested + what is intentionally not tested>
```

---

## Applying the Return

After test-architect returns the updated plan:
1. Review the Test-Architect Summary
2. **Re-run circular dependency check** on the full task list including any new integration test tasks added. If a new cycle is found → resolve before proceeding to Phase 7.
3. Check that integration test task dependencies are logically correct (integration test runs after both units it tests are complete)
4. Spot-check 2–3 inserted test code blocks for plausibility
5. Apply the updated plan — it replaces the draft from Phase 4
6. Proceed to Phase 7

**If test-architect BLOCKED or NEEDS_CONTEXT:**
- Common cause: test framework not identified in preflight → ask user to confirm framework, update Preflight Summary, re-dispatch test-architect once
- Common cause: task scope too vague to write a test → fix OBJECTIVE in that task, re-dispatch once
- **Maximum 1 retry.** If test-architect BLOCKED again after fix → escalate to user: "Test-Architect blocked on task `<task name>`. OBJECTIVE text: `<text>`. Please clarify scope or confirm the task is non-testable `[no-tdd — structural]`."
