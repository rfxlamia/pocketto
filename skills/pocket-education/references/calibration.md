# Learner Calibration

A short, friendly onboarding that decides how much to explain per skill. **It is onboarding, not an exam:** no scores, no pass/fail, nothing graded. Say so up front:

> "A few quick questions so I know how much to explain. There are no wrong answers — this only sets how detailed my guidance is, and you can change it any time."

Run it when: `pocket-init`'s Education Gate is accepted, `pocket-education` finds no profile, or the learner asks to recalibrate. Never on a session where a valid profile already exists.

## 1. Pick the skills (4–8)

Always include the core set:

| id | Covers |
|----|--------|
| `programming_fundamentals` | variables, functions, control flow, data structures |
| `repository_navigation` | finding code, following call paths, reading unfamiliar modules |
| `git` | status/add/commit, branches, diffs, resolving simple conflicts |
| `testing` | test structure, assertions, running targeted tests, test doubles |
| `debugging` | reading errors and stack traces, forming and checking hypotheses |

Add stack skills **only from evidence** in the repository (the `pocket-init` scan, or manifests you read now): the main language (`typescript`, `python`, `go`, …), the main framework (`react`, `django`, …), `sql` if there is a database layer or migrations, `system_design` only if the learner wants architecture coaching. Use lowercase ids joined by `_` or `-`. Keep the profile compact — at most 8 at calibration.

## 2. Self-assessment (one message)

Ask for one letter per skill:

```text
For each, pick a / b / c:
  a = new to me    b = I've used it with help    c = comfortable on my own

  programming_fundamentals   _
  repository_navigation      _
  git                        _
  testing                    _
  debugging                  _
  typescript                 _
```

Map `a → foundation`, `b → guided`, `c → independent`.

## 3. Two or three practical probes

Small, answerable in one sentence, written in the repo's language. Prefer a **real** short, pure function from this repository (≤ 10 lines) when one fits — it also teaches them something about the codebase. Probe skills the learner rated `b` or `c`; never more than three probes in total.

Probe shapes:

- **Boundary / control flow** — "What does this loop print for `[1, 2, 3]`? Anything off?"
  ```ts
  for (let i = 0; i <= items.length; i++) console.log(items[i]);
  ```
- **Code reading** — "What does `slugify('  Hello World ')` return?" (using a real helper from the repo when possible)
- **Error / return value** — "A test fails with `TypeError: Cannot read properties of undefined (reading 'id')` at `service.ts:42`. What is the first thing you would check?"

Rules:

- A probe can only **lower** a proposed level, by one step, and only for the skill it probes. It never raises a level — a too-steep start is worse than a gentle one.
- If an answer misses, explain the answer briefly and kindly, then move on. Do not chain follow-up questions.

## 4. Propose, confirm, write

Show the proposal and the reason for any probe adjustment:

```text
Proposed learner profile:
  programming_fundamentals   guided
  repository_navigation      guided
  git                        guided
  testing                    foundation   (you picked b; the loop question suggests starting gentler)
  debugging                  guided
  typescript                 independent

Teaching style: guided (hints step by step; full explanation after the hints) — or socratic (questions first, explanations only when you ask).
Learning journal: on (short notes in docs/pocket/learning/ after each task, used to suggest level changes) — say "off" if you prefer.

Change anything, or confirm?
```

The learner may change any level in either direction — it is their call. Then write it:

```bash
npx -y pocketto-pi edu init --file <memory_file> \
  --level programming_fundamentals=guided --level repository_navigation=guided \
  --level git=guided --level testing=foundation --level debugging=guided \
  --level typescript=independent \
  [--teaching-mode socratic] [--journal false] --json --contract 3
```

`EDU_PROFILE_EXISTS` means a profile is already there: stop and reuse it. Only an explicit recalibration request adds `--reset`.

## Adding one skill later

When a task needs a skill that is not in the profile, ask one self-assessment question for that skill only (a / b / c), optionally one probe, propose the level, and on confirmation:

```bash
npx -y pocketto-pi edu set --level sql=guided --json --contract 3
```

The CLI reports it as `direction: "added"`.
