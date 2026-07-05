# Spec Reviewer — Dispatch Prompt

Load this during Phase 5 to dispatch the spec reviewer subagent.

**Purpose:** Verify the execution plan covers the spec completely and has no placeholder failures before test-architect runs.

**When:** After all Pocket Packets are generated. Before test-architect.

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

  ## Calibration

  Only flag issues that would cause real problems during implementation:
  - A spec requirement with no implementing task → MUST flag
  - A task with placeholder content → MUST flag
  - A task missing the TDD steps (test before implement) → MUST flag
  - A task missing the commit step → MUST flag
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
| Approved | Proceed to Phase 6 (Test-Architect) |
| Issues Found | Fix each issue inline in the execution plan, re-dispatch reviewer |

**Fix loop:** Fix → re-dispatch → repeat until Approved. Do not proceed to Phase 6 with open issues.

**Maximum 2 review cycles.** If cycle 2 still returns Issues Found, output exactly:

```
REVIEW BLOCKED — <N> unresolved issues after 2 cycles:
<reviewer's Issues list verbatim>

Please resolve the above before proceeding to Test-Architect.
```

Do not summarize or paraphrase the issues. Do not auto-advance to Phase 6. Wait for user input.
