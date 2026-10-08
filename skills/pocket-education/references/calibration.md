# Learner Calibration

A short, friendly onboarding that decides how much to explain per skill. **It is onboarding, not an exam:** no scores, no pass/fail, nothing graded. Say so up front:

> "A few quick questions so I know how much to explain. There are no wrong answers — this only sets how detailed my guidance is, and you can change it any time."

Run it when: `pocket-init`'s Education Gate is accepted, `pocket-education` finds no profile, or the learner asks to recalibrate. Never on a session where a valid profile already exists.

## 1. Pick the skills to calibrate

When `pocket-education` creates a profile for a task, include the **1–3 skill dimensions this task actually uses**. Do not calibrate unrelated skills just to fill out a profile. Include a core dimension below only when the task exercises it. Add language, framework, database, or system-design dimensions when the repository and task provide evidence that they matter.

For `pocket-init` onboarding, or an explicit request to recalibrate the learner's broader profile, choose a compact set of **4–8 dimensions**: the core skills below plus relevant stack skills. Keep the selection tied to the learner's goals and this repository.

| id | Covers |
|----|--------|
| `programming_fundamentals` | variables, functions, control flow, data structures |
| `repository_navigation` | finding code, following call paths, reading unfamiliar modules |
| `git` | status/add/commit, branches, diffs, resolving simple conflicts |
| `testing` | test structure, assertions, running targeted tests, test doubles |
| `debugging` | reading errors and stack traces, forming and checking hypotheses |

Add stack skills only when supported by repository evidence (the `pocket-init` scan or manifests) and relevant to the task: the language (`typescript`, `python`, `go`, …), framework (`react`, `django`, …), `sql` when database work is involved, or `system_design` when the learner wants architecture coaching. Use lowercase ids joined by `_` or `-`; keep any calibration to at most 8 dimensions.

## 2. Self-assessment (one message)

In one message, ask for one letter per selected skill:

```text
For each, pick a / b / c:
  a = new to me    b = I've used it with help    c = comfortable on my own

  <selected skill dimension> _
  <selected skill dimension> _
```

Map `a → foundation`, `b → guided`, `c → independent`.

## 3. Optional practical probe

Do not probe by default. Use at most one small, one-sentence probe when its answer could materially change the starting level. Prefer a real, short, pure function from this repository when one fits. Probe only a skill the learner rated `b` or `c`.

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

Show the proposed levels for the selected skills and the reason for any probe adjustment. Let the learner choose the teaching style and whether to keep a journal; avoid asking them to re-confirm information they already gave.

```text
Proposed learner profile (for this task):
  testing                    foundation   (you picked b; the probe suggests starting gentler)
  typescript                 independent

Teaching style: guided (hints step by step; full explanation after the hints) or socratic (questions first; ask for a full explanation any time).
Learning journal: on (short notes in docs/pocket/learning/ after each task, used to suggest level changes) or off.

Choose or change the teaching style and journal setting, adjust any proposed level, or confirm.
```

The learner may change any proposed level in either direction. Once they confirm, write only the selected dimensions:

```bash
npx -y pocketto-pi edu init --file <memory_file> \
  --level testing=foundation --level typescript=independent \
  [--teaching-mode socratic] [--journal false] --json --contract 3
```

`EDU_PROFILE_EXISTS` means a profile is already there: stop and reuse it. Only an explicit recalibration request adds `--reset`.

## Adding one skill later

When a task needs a skill that is not in the profile, ask one self-assessment question for that skill only (a / b / c), optionally one probe, propose the level, and on confirmation:

```bash
npx -y pocketto-pi edu set --level sql=guided --json --contract 3
```

The CLI reports it as `direction: "added"`.
