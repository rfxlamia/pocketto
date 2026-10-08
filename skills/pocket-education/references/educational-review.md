# Educational Review

A review in Education mode has two jobs: find what is wrong, and make the learner able to find it themselves next time. A verdict ("missing null check") does the first. A trace does both.

## 1. Collect the learner's change

Review what the learner actually changed — nothing else:

```bash
git status --porcelain        # includes untracked files — read new files in full
git diff                      # unstaged
git diff --staged             # staged
```

If they already committed, review the range since the task started (`git diff <start-sha>..HEAD`; record `<start-sha>` with `git rev-parse HEAD` at the start of the task). Read every touched file around the change, not only the hunk.

## 2. Verify behavior

Run the relevant tests with the project's real command (from the memory file's project guide). At `foundation` for `testing`, ask the learner to run them and read the output together instead.

A failing test is a finding like any other: point to the failure and let them trace it.

## 3. Order and cap findings

Order: **correctness → missing or weak tests → edge cases → consistency with existing repo patterns → readability/style.**

Cap per round by the level of the skill the finding belongs to: `foundation` ≤ 3, `guided` ≤ 5, `independent` uncapped but prioritized. Hold the rest for the next round — an overwhelmed learner learns nothing. Never hold a correctness finding back for a style one.

## 4. Phrase findings as traces

Each finding names the place, then gives the learner a path to discover the failure mode.

| Avoid | Prefer |
|-------|--------|
| "Missing null check." | "This line assumes `project` always exists. Trace what `findProject()` returns for an unknown id. What happens when the next line reads `project.ownerId`?" |
| "Off-by-one." | "Walk the loop with a 3-item array. What is `i` on the last iteration, and what is `items[i]` then?" |
| "Add a test." | "Which input would have caught the bug you just fixed? Is there a test that uses it?" |
| "Use the existing helper." | "How does `modules/billing` format currency? Compare it with what you wrote." |

Format:

```text
F1 · correctness · src/projects/service.ts:42
This line assumes project always exists.
Trace what findProject() returns for an unknown id — what happens on the next line?
```

If the trace alone does not unblock them, climb the hint ladder (`hint-ladder.md`) for that finding.

## 5. Name one thing done well

Specific and true ("You followed the repo's `Result` pattern instead of throwing — that keeps the controller simple"). One is enough. Skip it rather than invent one.

## 6. Re-review

For every open finding, mark `resolved`, `partly`, or `open` and say why in one line. Check whether the fix introduced anything new, and re-run the tests. Done means: acceptance behavior holds, relevant tests pass, and no correctness finding is open.
