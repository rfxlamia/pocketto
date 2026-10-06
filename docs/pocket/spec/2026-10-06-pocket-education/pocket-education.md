# Pocket Education

**Date:** 2026-10-06
**Status:** draft — for review in the implementing PR
**Issue:** #55
**Spec path:** docs/pocket/spec/2026-10-06-pocket-education/pocket-education.md

---

## Summary

Pocket Education is an explicit, opt-in mode in which the agent does **not** implement the work. The human writes the code; the agent explains, points to the right files, reviews, and coaches with progressive hints. A compact, skill-specific learner profile is calibrated once during `pocket-init` and persisted in the project memory file, so later sessions teach at the right depth without recalibrating. The profile changes only with the learner's explicit consent.

```text
Pocket Core        AI works with you.
Pocket Enterprise  AI works with your organization.
Pocket Education   AI teaches you how to work.
```

---

## Context

- `pocket-init` already owns onboarding and the project memory file (`CLAUDE.md` on Claude Code, `AGENTS.md` on Pi). It writes a regenerable managed section (`<!-- pocket-init:start/end -->`) and, on opt-in, a `## Pocket Enterprise` fenced config block through `pocketto-pi mode init`.
- `cli/lib/mode.js` establishes the pattern for opt-in modes: a heading plus a fenced `key: value` block, `AGENTS.md` < `CLAUDE.md` precedence (last wins), strict validation, and fail-closed detection.
- Every implementing skill (`hotfix`, `bug-hunting`, `pocket-development`) assumes the agent (or its subagents) writes the code. Without a guard, a learner who says "fix this bug" gets the fix and loses the lesson.

---

## Design Decisions

### D1 — Education is its own skill, not a flag on `pocket-development`

`pocket-development` is a delegator/auditor contract; changing who implements would silently change its meaning. Education gets its own standalone skill, `pocket-education`, whose loop is built around a human implementer. Existing skills only gain a guard that routes to it.

### D2 — The profile lives in its own `## Pocket Education` block

The issue proposed extending the `pocket-init` managed section. That section is *regenerated* whenever the project guide is refreshed, which would reset calibration. The profile therefore lives in a sibling block, exactly like `## Pocket Enterprise`, in the same memory file. Regenerating the project guide never touches it, and the two modes never touch each other's block.

~~~markdown
## Pocket Education

When `education: true`, the learner writes the code; the agent explains, points to files, reviews, and gives progressive hints (`pocket-education` skill). Teach each skill at its level below and do not re-explain what a level already covers. Levels change only when the learner explicitly agrees: `npx -y pocketto-pi edu set --level <skill>=<level>`.

```
education: true
profile_schema: 1
teaching_mode: guided
journal: true
skill.programming_fundamentals: guided
skill.typescript: foundation
skill.git: guided
skill.testing: foundation
```
~~~

The prose line is deliberate: any agent that loads the memory file learns the contract even before the skill is loaded.

### D3 — Deterministic writes go through the CLI

Profile writes are done by `pocketto-pi edu`, not by the model editing Markdown. The CLI validates the schema, preserves everything outside the block byte-for-byte (including CRLF files), and makes the important rules structural:

| Rule | Enforced by |
|------|-------------|
| A valid profile is reused, not recalibrated | `edu init` refuses with `EDU_PROFILE_EXISTS` unless `--reset` |
| Levels are skill-specific | `skill.<id>: foundation\|guided\|independent`, one line per skill |
| Malformed profile never silently means "off" | `EDU_CONFIG_INVALID` (exit 1); skills stop and surface it |
| Future schema is not misread | `profile_schema` other than `1` → `EDU_SCHEMA_UNSUPPORTED` |
| Every level change is visible | `edu set` reports `changes[]` with `more_guidance` / `less_guidance` / `added` |

Consent itself cannot be verified by a CLI; the skill's hard gate owns it (D5).

### D4 — Three teaching depths, two teaching modes

Levels (per skill): `foundation` (explain fundamentals, small explicit steps), `guided` (assume basics; focus on repo navigation, patterns, testing, debugging strategy), `independent` (constraints, edge cases, trade-offs, verification).

Teaching modes (global):

- `guided` (default) — progressive hint ladder; a full explanation is offered once the ladder is exhausted.
- `socratic` — questions first; hints when asked; a full explanation only on explicit request.

In both modes the agent never edits application code or tests.

### D5 — The learner owns progression

The agent may *recommend* a level change, based on evidence (the learning journal, D6). The persisted level changes only after the learner explicitly agrees or directly states a level ("keep testing at foundation", "stop explaining git basics"). Requests for more guidance are honored the same way, in the other direction.

### D6 — A local learning journal is the evidence base

Recommendations need evidence across sessions, but sessions are stateless. Each completed Education task writes a short summary to `docs/pocket/learning/<date>-<slug>.md` recording skills practiced, the deepest hint reached per skill, review rounds, and any recommendation. It is plain Markdown in the learner's repo: no scores, no dashboard. `journal: false` turns it off, in which case recommendations rely on the current session only.

### D7 — Guards, not rewrites, in implementing skills

`hotfix`, `bug-hunting` (reactive fixes), and `pocket-development` check the memory file already in context for a `## Pocket Education` block. With no block, they behave exactly as before and make no extra call. With `education: true`, they ask once whether the learner wants to implement with guidance (→ `pocket-education`) or explicitly hand this task to the agent. Handing a task over is always explicit, never silent.

---

## Scope

### In scope (V0)

- `pocketto-pi edu` read / `edu init` / `edu set`, with tests.
- `pocket-education` skill: session start, 7-step loop, hint ladder, review style, learning summary + journal, level-change protocol.
- `pocket-init`: Education Gate and lightweight calibration, independent of the Enterprise Gate.
- Guards in `hotfix`, `bug-hunting`, `pocket-development`.
- Docs: README, `llms.txt`, `pocket-help`, pipeline diagram, CHANGELOG.

### Out of scope

An LMS, grading, scores, dashboards, classroom/instructor views, coding challenges, cross-repository profiles, automatic level changes, and Education-specific GitHub behavior. Education makes zero GitHub calls; Enterprise behaves exactly as before whether Education is on or off.

---

## Acceptance Criteria

```gherkin
Scenario: Opting in during pocket-init
  Given a repository without a Pocket Education block
  When the user says yes at the Education Gate and confirms the proposed levels
  Then a "## Pocket Education" block with education: true and one skill.<id> line per calibrated skill is written to the chosen memory file
  And content outside the block is unchanged

Scenario: A later session reuses the profile
  Given a valid Pocket Education profile exists
  When pocket-education starts a task
  Then it reads the profile via "edu --json" and does not recalibrate
  And "edu init" without --reset is refused with EDU_PROFILE_EXISTS

Scenario: Depth follows the skill, not the person
  Given testing is foundation and typescript is independent
  When a task involves writing a test in TypeScript
  Then test structure and assertions are explained step by step
  And TypeScript syntax is not explained

Scenario: The human implements
  Given Education is enabled
  When the learner asks for help with a task
  Then the agent explains, points to files, and asks guiding questions
  And it does not edit application code or tests

Scenario: Review teaches reasoning
  Given the learner's change has a defect
  When the agent reviews the diff
  Then the finding is phrased as a trace or question that leads to the failure mode
  And deeper hints are given only one rung at a time

Scenario: Progression is recommended, not applied
  Given the journal shows several testing tasks completed with at most one hint
  When the learning summary is written
  Then the agent recommends moving testing from foundation to guided
  And the profile is unchanged until the learner agrees

Scenario: Learner asks for more guidance
  Given testing is guided
  When the learner says "explain testing more slowly again"
  Then "edu set --level testing=foundation" is run and reports direction more_guidance

Scenario: Implementing skills respect Education
  Given Education is enabled
  When the user invokes hotfix for a change
  Then hotfix asks whether to route to pocket-education or explicitly hand the task over
  And no implementation is written before the answer

Scenario: Disabled Education changes nothing
  Given no Pocket Education block exists
  When any Core or Enterprise skill runs
  Then its behavior is unchanged and no edu call is made

Scenario: Education coexists with Enterprise
  Given both blocks exist in the same memory file
  When "mode" and "edu" are read and "edu set" runs
  Then each reads its own block and the Enterprise block is byte-for-byte unchanged
```
