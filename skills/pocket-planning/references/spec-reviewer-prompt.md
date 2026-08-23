# Spec Reviewer — Dispatch Prompt

Load this during Phase 5 to dispatch the spec reviewer subagent.

**Purpose:** Verify the execution plan covers the spec completely, carries usable test intent, and has no placeholder failures.

**When:** After all Pocket Packets are generated. Before Phase 6's conditional test strategy audit, and before the plan is presented for approval.

---

## Dispatch

```
Mode: Read-only review
Complexity: Standard
Description: "Spec reviewer — verify plan covers spec"

Prompt:
  You are a plan document reviewer. Your job is to verify this execution
  plan is complete, matches the spec, and has no placeholder failures.

  Plan file: [PLAN_FILE_PATH]
  Spec file: [SPEC_FILE_PATH]

  ## What to Check

  | Category | What to Look For |
  |----------|-----------------|
  | Spec coverage | Every acceptance criteria rule has ≥1 task implementing it |
  | No placeholders | No "TBD", "TODO", "implement later", "handle edge cases", "similar to Task N" |
  | Task scope | Every task names exact files — no wildcards or vague references |
  | TDD structure | Every task has: write test → verify fail → implement → verify pass → refactor while green → commit |
  | Commit steps | Every task ends with a git commit step with a conventional commit message |
  | GWT traceability | Every task's DELIVERABLE contains GWT scenarios from the spec |
  | Out-of-scope | No task touches items listed in spec Out-of-Scope section |
  | File map | Every file mentioned in tasks was listed in Phase 2 File Structure Map |
  | Test intent present | Every behavioral task carries all seven fields across its RED cycle: test file, level, GWT test intent, boundary to exercise, test doubles, expected RED reason (Step 1), and the exact command (Step 2). A command defined in Step 2 only is correct — do not flag it as missing from Step 1 |
  | Test level sane | The stated level (unit / integration / E2E) can actually observe the behavior being proved — not a unit test for a cross-boundary outcome |
  | Mock boundary sane | Test doubles do not mock the unit under test, and external services / network / clock are doubled rather than hit for real |
  | GWT → cycle mapping | Every GWT scenario in a task's DELIVERABLE maps to its own RED cycle with its own exact command. Two scenarios sharing one cycle is a finding — the second is never independently proved, and the mechanical gate has no command to run for it |
  | Cross-unit coverage | Every GWT scenario needing 2+ units collaborating has integration verification — an integration-test task, or an explicit extra TDD cycle inside the owning task |
  | TDD ordering | Order is RED → GREEN → refactor → commit, and "Expected RED" states why the test fails **today** (not a vacuous pass) |
  | `[test-risk]` usage | The marker is appended after a dependency annotation, never used alone (alone it parses as depth 0 and reorders execution) |

  The plan must contain **no test source code**. Test code in a plan is a finding, not a bonus — the implementer writes the RED test during execution.

  ## Calibration

  Only flag issues that would cause real problems during implementation:
  - A spec requirement with no implementing task → MUST flag
  - A task with placeholder content → MUST flag
  - A task missing the TDD steps (test before implement) → MUST flag
  - A task missing the commit step → MUST flag
  - A behavioral task with no test intent, or missing test file / level / expected RED → MUST flag
  - A cross-unit GWT scenario with no integration verification anywhere → MUST flag
  - Test source code written into the plan → MUST flag
  - Preferring a different-but-equivalent test level or double → do NOT flag
  - Minor wording or style → do NOT flag
  - "Nice to have" suggestions → do NOT flag (use Recommendations)

  Approve unless there are serious gaps. A focused "Issues Found" with 2 real
  problems is more useful than a padded "Approved" with caveats.

  ## Output Format

  ### Plan Review

  **Status:** Approved | Issues Found

  **Issues (if any):**
  - [Task N, Step X]: [specific issue] — [why it blocks implementation]

  **Recommendations (advisory, do not block approval):**
  - [suggestion]
```

---

## Handling the Return

| Reviewer Status | Action |
|-----------------|--------|
| Approved | Proceed to Phase 6 and run its trigger check (the audit itself is conditional) |
| Issues Found | Fix each issue inline in the execution plan, re-dispatch reviewer |

**Fix loop:** Fix → re-dispatch → repeat until Approved. Do not proceed past Phase 5 with open issues.

**Maximum 2 review cycles.** If cycle 2 still returns Issues Found, output exactly:

```
REVIEW BLOCKED — <N> unresolved issues after 2 cycles:
<reviewer's Issues list verbatim>

Please resolve the above before the plan can be presented for approval.
```

Do not summarize or paraphrase the issues. Do not auto-advance to Phase 6 or Phase 7. Wait for user input.
