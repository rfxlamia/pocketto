# Learning Summary and Journal

Every Education task ends with a short learning summary. When `journal: true` (the default), the same summary is saved, so later sessions have evidence for — or against — a level change. It is plain Markdown in the learner's repository: no scores, no dashboard.

## Where

```text
docs/pocket/learning/<YYYY-MM-DD>-<task-slug>.md
```

One file per task. If the slug already exists for that date, append `-2`, `-3`, … Never rewrite an older entry.

## Template

```markdown
# Learning summary — <task title>

- Date: <YYYY-MM-DD>
- Outcome: completed | handed-over | paused
- Skills: testing (foundation), typescript (independent)
- Deepest hint: testing=2, typescript=0
- Review rounds: 2
- Solution revealed: no

## Concepts practiced
- Arrange / act / assert in a Jest test
- Narrowing `T | undefined` before use

## Mistakes corrected — and the reasoning that found them
- Read `project.ownerId` before checking that the project exists → traced what `findProject()` returns for an unknown id.

## Patterns in this repo worth remembering
- Authorization runs after loading the entity: `authorize(user, 'delete', project)` (see `modules/invoices/service.ts`).

## Level recommendation (the learner decides)
- testing: foundation → guided — third testing task in a row finished with at most one hint. Learner: accepted | declined | not asked
```

`Deepest hint` uses the rung numbers from `hint-ladder.md`; write `full` for a full explanation. Keep the whole entry under ~40 lines.

## Recommendations

Read the headers of the most recent journal entries (newest first, up to ten) before recommending. Recommend **at most two** changes per summary, at most one per skill.

| Recommend | When |
|-----------|------|
| **Less guidance** (`foundation → guided`, `guided → independent`) | The last three completed entries that practiced the skill (this one included) each reached hint rung ≤ 1 for it, with no full explanation and no basic-concept question for it. |
| **More guidance** (`independent → guided`, `guided → foundation`) | This task reached `full` for the skill twice, or the last two entries both reached `full`, or the learner said they feel lost. |

With `journal: false`, base recommendations on the current session only, and say so ("based on today only").

Wording — evidence first, then the offer, then the question:

> "You've finished three testing tasks without needing foundation-level guidance. If you're comfortable with test structure, assertions, and running targeted tests, we can move **testing** from foundation → guided so future tasks are less verbose. Update it? (yes/no)"

Only a **yes** runs `npx -y pocketto-pi edu set --level <skill>=<level> --json --contract 3`. Record the answer on the entry's recommendation line. A **no** is final for this task; do not ask again in the same session.

## Handed-over and paused tasks

- `handed-over` — the learner explicitly asked the agent to implement. Record it with `Skills` and `Deepest hint` so far. It is never evidence for *less* guidance.
- `paused` — the session ended mid-task. Record where they stopped so the next session can pick up ("next: write the failing test for the empty-list case").
