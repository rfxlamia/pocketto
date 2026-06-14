# Verdict Reconciliation

How pocket-closing maps each reviewable task to its review verdict, decides the gate, and gathers what to carry forward. Load when reconciling reviews against `log.json`.

## The review file contract

pocket-review writes one file per reviewed task (batch mode):

```text
<plan_dir>/reviews/<task_id>-review.json
```

Fields pocket-closing reads:

| Field | Use |
|-------|-----|
| `task_id` | Join key back to `log.json` task `id` (case-insensitive: `T1`) |
| `overall` | The verdict: `REVIEW_PASS` \| `REVIEW_FAIL` \| `REVIEW_BLOCKED` |
| `reviewed_sha` | **Primary freshness anchor** — the boundary SHA pocket-review actually reviewed. Exact-matched against `latest_owned_sha(T)` to prove the verdict covers current code. Present on any review produced after Task 4 of #34 landed. |
| `timestamp` | When the review was produced — **legacy fallback only**, used when `reviewed_sha` is absent (older reviews predating `reviewed_sha` support). |
| `fix_instructions` | Printed verbatim on a block. Empty string when PASS |
| `stage_2.issues[]` | `severity` Critical/Important/Minor — Minor on a PASS = carried-forward observation |
| `stage_2.strengths[]` | Carried-forward positives for the closeout |

pocket-closing reads these fields only. It does NOT open the files the review references, re-run stages, or recompute SHA ranges.

## Reconciliation algorithm

```text
reviewable = []   # tasks that gate the close
skipped    = []   # not reviewable, excluded from gate
missing    = []   # reviewable but no verdict → blocks
stale      = []   # verdict does not cover latest owned sha → blocks

for phase in target_phases:
    for task in phase.tasks:
        if task.status != "DONE" or not task.done_sha:
            skipped.append(task)                 # pocket-review skipped it too
            continue
        verdict_file = reviews/<task.id>-review.json
        if not exists(verdict_file):
            missing.append(task)                 # DONE but never reviewed
            continue
        review = read(verdict_file)

        # Compute the boundary that must be covered by the review.
        # tasks(c) = ({ c.for_task } if present) ∪ { owner[f] : f ∈ c.files and owner[f] is defined }
        # owner[f]  = the task whose original done-range (prev..done_sha, in plan order) last touched f
        latest_owned_sha = max_by_commit_time(
            { task.done_sha }
            ∪ { c.sha : c ∈ phase.corrections and task ∈ tasks(c) }
        )

        # Primary: exact SHA match (all reviews produced after reviewed_sha was introduced).
        if review.reviewed_sha is present:
            if review.reviewed_sha != latest_owned_sha:
                stale.append(task)               # correction landed after this review
                continue
        # Legacy fallback: timestamp proxy (reviews predating reviewed_sha support).
        else:
            commit_time = git_show_committer_time(latest_owned_sha)   # %cI, UTC instant
            if review.timestamp < commit_time:   # code changed after review
                stale.append(task)
                continue

        reviewable.append((task, review.overall))

if missing or stale: CLOSE_BLOCKED                 # Iron Law 2
```

Two dangerous cases, both blocked — never assume PASS:

- **No review file** for a `DONE` task: it looks finished but was never independently reviewed.
- **Stale review** for a `DONE` task: a verdict exists, but the code boundary advanced *after* the review was written — either the `done_sha` moved or a correction was attributed to the task after review. **Primary check:** `review.reviewed_sha` must exactly equal `latest_owned_sha(T)` (see definition in pseudocode above). If `reviewed_sha` is absent (legacy review), fall back to comparing the review's `timestamp` against the committer time of `latest_owned_sha(T)` (`git show -s --format=%cI <latest_owned_sha>`, compared as UTC instants). In either case, a mismatch is stale — never close on it.

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
| `review.reviewed_sha` present and `!= latest_owned_sha(T)` | Stale — a correction landed after this review. `CLOSE_BLOCKED: "T{id} verdict is stale: a correction changed its files after review. Re-run pocket-review."` Never close on it. |
| `review.reviewed_sha` absent and `review.timestamp < committer_time(latest_owned_sha(T))` | Legacy stale — code boundary advanced after review (timestamp proxy). `CLOSE_BLOCKED: "T{id} verdict is stale. Re-run pocket-review."` Never close on it. |
| Review `timestamp` missing/unparseable and `reviewed_sha` absent | Cannot prove freshness → treat as stale → `CLOSE_BLOCKED`. Re-run pocket-review to regenerate the verdict |
| Phase has zero reviewable tasks (all skipped) | Cannot attest a close — `CLOSE_BLOCKED: "Phase <file> has no reviewed tasks."` |
| Dir invocation, one phase blocks, others pass | Advance the passing phases, then `log close` returns `PHASES_NOT_DONE` → report `CLOSE_BLOCKED` for the blocked phase. Never close while any target phase is blocked. |
