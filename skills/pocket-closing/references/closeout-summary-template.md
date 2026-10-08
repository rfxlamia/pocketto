# Pocket Plan Closeout Journal

`<plan_dir>/closeout.md` is an append-only journal. Append one phase section after that phase advances from `REVIEW` to `DONE`, then append the plan-completion section after `log close` succeeds. Never replace or rewrite an earlier phase section.

Load `references/verdict-reconciliation.md` for the exact task set and current verdicts. Use `log.json` and task verdicts as the only lifecycle and review sources. For narrative, read `<plan_dir>/reviews/phase-notes-<phase_key>.json` when present; it is a presentation handoff and never a verdict source. If it is missing, use the phase-completion handoff available in the conversation and explicit user-provided context. Missing notes alone do not block closure. Do not read implementation code or `reviews/phase-pass-<phase_key>.json`, and do not infer events that were not recorded. If a category has no supporting information, write `Not recorded in the available phase notes`.

When creating a new file, start with this header. For an existing journal, keep its current content and append only missing sections.

```markdown
# Pocket Closeout — <plan title>

- **Plan:** <plan_dir>
- **Type:** <flat | phased>
- **Started:** <date_started>
- **Baseline:** <short baseline_sha>

This journal records phase outcomes as they are closed. Each section separates verified work, review evidence, documented obstacles and decisions, and optional recommendations. Read the phase sections for current progress.
```

## Phase section

Append one section per canonical phase key (`phase-<order>`). Check for that key before writing; an existing section must not be duplicated.

```markdown
## Phase <order> of <phase_count> — <human-readable phase name>

**Status:** Complete — `REVIEW` → `DONE`
**Closed:** <date and time, if recorded>

### What was completed

- **T1 — <task name>:** completed (`<short done_sha>`)
- **T2 — <task name>:** completed (`<short done_sha>`)

### Review and verification

- Task verdicts: <all current verdicts are REVIEW_PASS>
- Phase-level review: <PHASE_PASS_CLEAN | PHASE_PASS_RESOLVED, if recorded>
- Corrections: <number and short SHAs, or None recorded>

### Obstacles and resolution

- <recorded obstacle and its documented resolution, with source and evidence>
- <or: No obstacle or resolution was recorded in the available phase notes.>

### Decisions

- <explicit user/product decision and where it was recorded>
- <or: No decision was recorded in the available phase notes.>

### Suggestions

- <optional, evidence-based recommendation; label it as a suggestion and name the review observation that supports it>
- <or: No follow-up suggestion from the recorded review observations.>

### Next

<Next phase name and status, or “All phases are complete; the plan is being finalized.”>
```

Write for a reader who did not follow the agent session: translate task names into a short plain-language description, keep SHAs short, and explain why an obstacle mattered and how it was resolved when the phase note records that detail. Carry forward recorded decisions with their source, and label optional suggestions with the specific review observation that supports them. When a note is absent or lacks a field, preserve that uncertainty instead of reconstructing session history. Do not claim tests passed unless the durable evidence being summarized records that result.

## Final plan section

Append this once, after `log close` succeeds:

```markdown
## Plan closed

**Result:** Complete — all <phase_count> phases are `DONE`
**Closed:** <date_completed>
**Work reviewed:** <task_count> tasks — all current verdicts are `REVIEW_PASS`

The phase-by-phase record above contains completed work, review outcomes, documented obstacles and decisions, and evidence-based suggestions.
```

## Rules

- Append a phase section only after its `REVIEW` → `DONE` transition succeeds.
- On `PHASE_ADVANCED`, the completed phase's section is already in `closeout.md`; no final plan section is written yet.
- Append the final plan section only after `log close` succeeds.
- If a run stops after a phase becomes `DONE` but before its section is appended, recover by appending that missing phase from the same recorded sources. Do not repeat the state transition.
- If the plan header is already `DONE`, repair missing phase/final sections from recorded sources, then report `ALREADY_CLOSED`.
- Pull task names, statuses, SHAs, dates, and verdicts from `log.json` and verdict artifacts. Never invent them.
- List user decisions only when explicit in available notes or the current conversation. If they are absent, say they were not recorded.
- Recommendations are optional, must be labeled as suggestions, and must point to a recorded non-blocking observation. Never present a new recommendation as a review finding.
- Keep the report factual and readable. Do not add a fresh assessment of implementation code.
