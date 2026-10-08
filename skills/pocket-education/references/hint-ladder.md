# The Hint Ladder

Help arrives at a depth that fits the learner's level and request. Each hint should leave the learner with a useful next move. The ladder protects the practice; it should not make the agent repeat a failed path or ignore a clear request for explanation.

## Rungs

| Rung | Name | Gives | Example (task: protect project deletion) |
|------|------|-------|------------------------------------------|
| 0 | Question | A question whose answer reveals the next step | "Who is allowed to delete a project? Where does the code check that today?" |
| 1 | Orient | Where to look | "Look at how authorization is handled in another module." |
| 2 | Pattern | An analogous, existing example in this repo | "Search for calls to `authorize()` — `modules/invoices/service.ts` is a close match." |
| 3 | Mechanism | The shape of the gap: which function, which values | "Compare the arguments `authorize()` gets there with what your delete flow has available." |
| 4 | Pinpoint | The exact missing step, **in words** | "The permission check needs the loaded project, so it has to come after `findProject()` and before the delete." |
| — | Full explanation | The concept, why it is needed, and a worked example on *different* code or pseudocode | A short explanation of load-then-authorize ordering, illustrated on a made-up `deleteComment` function |

## Rules

1. **One rung per hint reply.** Give one actionable next move, then let the learner try it. If that path fails, use the result to choose a different evidence-backed path; do not repeat the same instruction or treat one failed attempt as a human blocker.
2. **Start where the level says** (`teaching-depth.md`): `independent` starts at rung 0; `foundation` and `guided` start at rung 1.
3. **Climb only on need** — the learner asks, or they tried and are still stuck. Being slow is not being stuck.
4. **Full explanation**
   - `teaching_mode: guided` — offer it once rung 4 has not unblocked them: "Want me to explain the whole idea?"
   - `teaching_mode: socratic` — lead with questions unless the learner asks for an explanation.
   - A direct request such as "just tell me" is explicit; give the requested explanation without asking them to confirm again.
5. **The worked example is never a drop-in patch.** Use a different function, different names, or pseudocode, so the learner still has to transfer the idea to their code.
6. **Exact code for their file — last resort.** Only after a full explanation, and only on an explicit request. Show it in chat, labelled as the solution; the learner applies it themselves. Record `Solution revealed: yes` in the journal.
7. **Track the deepest rung** reached for every finding or stuck point, per skill. The learning summary reports it; it is the main evidence for progression recommendations.

## Tone

Matter-of-fact and encouraging. Climbing the ladder is normal, not a failure — never comment on how many hints someone needed. Praise reasoning ("good instinct to check the return value"), not speed.
