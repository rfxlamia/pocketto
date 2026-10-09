# Teaching Depth

Engineering ability is not one number. A learner can be `independent` in TypeScript and `foundation` in testing at the same time. Every explanation is pitched at the level of the **skill the concept belongs to**, not at a global "beginner/advanced" label.

## The three levels

| Level | Assume | Focus on | Step size |
|-------|--------|----------|-----------|
| `foundation` | Little or no prior exposure to this skill | Fundamentals: syntax, operators, variables, functions, control flow, basic Git concepts, how to read compiler/test errors, *why* each development step exists | Small, explicit steps; one decision at a time |
| `guided` | Basic knowledge of this skill | Repository navigation, existing patterns, debugging strategy, testing approach, API behavior, code organization, implementation hints | Medium steps; the learner fills in the mechanics |
| `independent` | The learner can execute the details | Constraints, architecture, edge cases, trade-offs, review findings, verification | The goal and the constraints; the learner decides the steps |

## Per loop step

| Loop step | `foundation` | `guided` | `independent` |
|-----------|--------------|----------|---------------|
| Understand | Define every term the task uses. Explain what "done" means and why the tests matter. | State the goal and acceptance behavior; define only repo-specific terms. | State the goal, the constraints, and what must not change. |
| Investigate | Name the exact file and the function to read first; walk the call path with them. | Name the area and one existing example to compare with. | Name the boundary (module/layer); let them find the files. |
| Learner plans | Offer a step skeleton with decisions left blank. | Invite a brief approach; ask about material gaps. | Confirm the approach and surface material risks. |
| Hints | Start at rung 1 and expect to climb. | Start at rung 1; expect 1–2 rungs. | Start with a question (rung 0); hints are rare. |
| Review | ≤ 3 findings per round, correctness first; explain the underlying concept once. | ≤ 5 findings per round; point to the pattern the repo already uses. | All findings that matter, prioritized; focus on edge cases, trade-offs, and verification. |

## Mixing levels in one task

Pitch each concept at the level of the skill it belongs to.

> Testing `foundation`, TypeScript `independent`, task: add a test for `parseDuration`.
>
> Explain what a test case, an assertion, and an edge case are, and how to run just this test file. Do **not** explain TypeScript types, generics, or `import` syntax.

When a concept straddles two skills, use the **lower** level for that concept only.

## Do not repeat what a level covers

A concept that falls inside a `guided` or `independent` skill is not explained unless the learner asks. If they ask, explain it once, plainly — that is not a reason to change their level, but it is evidence for the journal ("asked about X").

`foundation` explanations are also not repeated *within a session*: once a concept was explained and the learner used it correctly, refer back to it ("same as the assertion earlier") instead of re-teaching it.

## Teaching modes

| `teaching_mode` | How help is given |
|-----------------|-------------------|
| `guided` (default) | Hints climb the ladder when the learner asks or is clearly stuck; a full explanation is offered once the ladder is exhausted. |
| `socratic` | Lead with questions. If the learner asks for help or is stuck after trying, give one useful next-step question. Give a full explanation on an explicit request ("explain it", "show me"). |

Neither mode lets the agent edit the learner's code.
