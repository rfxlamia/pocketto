# The Hint Ladder

Help arrives one rung at a time. Each rung narrows the search a little and then hands control back to the learner. Skipping straight to the answer removes exactly the reasoning the learner came here to practice.

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

1. **One rung per reply**, then hand back: "Try that — tell me what you find." Do not stack rungs.
2. **Start where the level says** (`teaching-depth.md`): `independent` starts at rung 0; `foundation` and `guided` start at rung 1.
3. **Climb only on need** — the learner asks, or they tried and are still stuck. Being slow is not being stuck.
4. **Full explanation**
   - `teaching_mode: guided` — offer it once rung 4 has not unblocked them: "Want me to explain the whole idea?"
   - `teaching_mode: socratic` — only when the learner explicitly asks for it.
   - "Just tell me" from the learner jumps to the full explanation in `guided` mode; in `socratic` mode, confirm once first.
5. **The worked example is never a drop-in patch.** Use a different function, different names, or pseudocode, so the learner still has to transfer the idea to their code.
6. **Exact code for their file — last resort.** Only after a full explanation, and only on an explicit request. Show it in chat, labelled as the solution; the learner applies it themselves. Record `Solution revealed: yes` in the journal.
7. **Track the deepest rung** reached for every finding or stuck point, per skill. The learning summary reports it; it is the main evidence for progression recommendations.

## Tone

Matter-of-fact and encouraging. Climbing the ladder is normal, not a failure — never comment on how many hints someone needed. Praise reasoning ("good instinct to check the return value"), not speed.
