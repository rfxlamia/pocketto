# Verdict Reconciliation

How pocket-closing maps each reviewable task to its review verdict, decides the gate, and gathers what to carry forward. Load when reconciling reviews against `log.json`.

## The review file contract

pocket-review writes one file per reviewed task (batch mode):

```
<plan_dir>/reviews/<task_id>-review.json
```

Fields pocket-closing reads:

| Field | Use |
|-------|-----|
| `task_id` | Join key back to `log.json` task `id` (case-insensitive: `T1`) |
| `overall` | The verdict: `REVIEW_PASS` \| `REVIEW_FAIL` \| `REVIEW_BLOCKED` |
| `fix_instructions` | Printed verbatim on a block. Empty string when PASS |
| `stage_2.issues[]` | `severity` Critical/Important/Minor — Minor on a PASS = carried-forward observation |
| `stage_2.strengths[]` | Carried-forward positives for the closeout |

pocket-closing reads these fields only. It does NOT open the files the review references, re-run stages, or recompute SHA ranges.

## Reconciliation algorithm

```
reviewable = []   # tasks that gate the close
skipped    = []   # not reviewable, excluded from gate
missing    = []   # reviewable but no verdict → blocks

for phase in target_phases:
    for task in phase.tasks:
        if task.status != "DONE" or not task.done_sha:
            skipped.append(task)                 # pocket-review skipped it too
            continue
        verdict_file = reviews/<task.id>-review.json
        if not exists(verdict_file):
            missing.append(task)                 # DONE but never reviewed
            continue
        reviewable.append((task, read(verdict_file).overall))

if missing: CLOSE_BLOCKED                          # Iron Law 2
```

A task that is `DONE` with a `done_sha` but no review file is the dangerous case: it looks finished but was never independently reviewed. Always block — never assume PASS.

## Gate decision per phase

A phase passes only when **every** reviewable task in it is `REVIEW_PASS`.

| Verdict present in phase | Phase result |
|--------------------------|--------------|
| any `REVIEW_FAIL` | BLOCKED — print that task's `fix_instructions` |
| any `REVIEW_BLOCKED` | BLOCKED — print the escalation `fix_instructions` |
| all `REVIEW_PASS` | PASS — eligible for `log update … DONE` |

`REVIEW_FAIL` vs `REVIEW_BLOCKED`:

- `REVIEW_FAIL` — issues were found. Path: fix the code → re-run pocket-review (overwrites the verdict) → re-run pocket-closing.
- `REVIEW_BLOCKED` — the reviewer could not complete or escalated (e.g. plan/spec unreadable, repeated failures). `fix_instructions` starts with `ESCALATE:`. This needs a human decision, not just a code fix. Surface it and stop.

A `REVIEW_BLOCKED` **stub** may also appear when pocket-review's subagent could not run at all. Treat any `overall == REVIEW_BLOCKED` identically: block and print its `fix_instructions`.

## Carried-forward observations (PASS only)

When all verdicts pass, collect non-blocking signal for `closeout.md` so it is not lost:

- `stage_2.issues[]` with `severity == "Minor"` — e.g. unused import, naming nit
- `stage_2.strengths[]` — what the review praised
- Out-of-scope notes the reviewer recorded as observations (not issues)

These never block a close. They are recorded so the next person sees what review flagged but accepted.

## Edge cases

| Situation | Handling |
|-----------|----------|
| Header `status` already `DONE` | `ALREADY_CLOSED` — idempotent no-op, do not re-run CLI |
| `reviews/` absent or empty | `CLOSE_BLOCKED: "No reviews found. Run pocket-review first."` |
| Verdict file present for a non-DONE task | Stale verdict from a prior cycle — ignore; the task is not reviewable now |
| Phase has zero reviewable tasks (all skipped) | Cannot attest a close — `CLOSE_BLOCKED: "Phase <file> has no reviewed tasks."` |
| Dir invocation, one phase blocks, others pass | Advance the passing phases, then `log close` returns `PHASES_NOT_DONE` → report `CLOSE_BLOCKED` for the blocked phase. Never close while any target phase is blocked. |
