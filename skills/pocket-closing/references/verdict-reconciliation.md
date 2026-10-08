# Verdict Reconciliation

How pocket-closing maps each reviewable task to its review verdict, decides the gate, and gathers what to carry forward. Load when reconciling reviews against `log.json`.

## The review file contract

pocket-development writes one file per task verdict:

```text
<plan_dir>/reviews/<task_id>-review.json
```

Fields pocket-closing reads:

| Field | Use |
|-------|-----|
| `task_id` | Join key back to `log.json` task `id` (case-insensitive: `T1`) |
| `overall` | The verdict: `REVIEW_PASS` \| `REVIEW_FAIL` \| `REVIEW_BLOCKED` |
| `reviewed_sha` | **Primary freshness anchor** — the boundary SHA the phase-level pass actually reviewed. Exact-matched against `latest_owned_sha(T)` to prove the verdict covers current code. Present on any review produced after Task 4 of #34 landed. |
| `timestamp` | When the review was produced — **legacy fallback only**, used when `reviewed_sha` is absent (older reviews predating `reviewed_sha` support). |
| `fix_instructions` | Printed verbatim on a block. Empty string when PASS |
| `stage_2.issues[]` | `severity` Critical/Important/Minor — Minor on a PASS = carried-forward observation |
| `stage_2.strengths[]` | Carried-forward positives for the closeout |

pocket-closing reads these fields only. It does NOT open the files the review references, re-run stages, or recompute SHA ranges.

## Reconciliation algorithm

```text
reviewable = []   # DONE tasks with a pinned SHA and a current verdict
incomplete = []   # phase task is not DONE or has no done_sha → blocks
missing    = []   # reviewable but no verdict → blocks
stale      = []   # verdict does not cover latest owned sha → blocks

for phase in target_phases:
    for task in phase.tasks:
        if task.status != "DONE" or not task.done_sha:
            incomplete.append(task)              # REVIEW requires every task complete
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

if incomplete or missing or stale: CLOSE_BLOCKED  # Do not advance an incomplete phase
```

Two dangerous cases, both blocked — never assume PASS:

- **No review file** for a `DONE` task: it looks finished but has no recorded verdict.
- **Stale review** for a `DONE` task: a verdict exists, but the code boundary advanced *after* the review was written — either the `done_sha` moved or a correction was attributed to the task after review. **Primary check:** `review.reviewed_sha` must exactly equal `latest_owned_sha(T)` (see definition in pseudocode above). If `reviewed_sha` is absent (legacy review), fall back to comparing the review's `timestamp` against the committer time of `latest_owned_sha(T)` (`git show -s --format=%cI <latest_owned_sha>`, compared as UTC instants). In either case, a mismatch is stale — never close on it.
- A task without `DONE` and `done_sha` means the phase is not ready to close. A no-change task with a valid `REVIEW_PASS` skip stub is still included and must have its exact `reviewed_sha` checked.

## Gate decision per phase

A phase passes only when **every task** is `DONE`, has a `done_sha`, and has a current `REVIEW_PASS` verdict. A valid empty-diff skip stub counts as a verdict and remains in the task list.

| Verdict present in phase | Phase result |
|--------------------------|--------------|
| any `REVIEW_FAIL` | BLOCKED — print that task's `fix_instructions` |
| any `REVIEW_BLOCKED` with `blocked_category: "auditor-unavailable"` | BLOCKED — `CLOSE_BLOCKED`; report the exact human capability or access recorded in the artifact, then resume pocket-development when available (do NOT print unrelated `ESCALATE:` instructions) |
| any other `REVIEW_BLOCKED` with `fix_instructions` starting with `ESCALATE:` or `blocked_category: "audit-failed"` | BLOCKED — print the escalation `fix_instructions` |
| `REVIEW_BLOCKED` with no `blocked_category` and no `ESCALATE:` prefix | BLOCKED — stale/incomplete stub; re-run pocket-development's phase-level pass to regenerate verdicts (do not close) |
| all `REVIEW_PASS` | PASS — eligible for `log update … DONE` |

`REVIEW_FAIL` vs `REVIEW_BLOCKED`:

- `REVIEW_FAIL` — issues were found. Path: fix the code → re-run pocket-development's phase-level pass (overwrites the verdict) → re-run pocket-closing.
- `REVIEW_BLOCKED` — the current verdict records a human dependency or an unavailable independent-review capability. Repeated failures or a retry counter alone do not qualify. Follow the recorded unblock action; ask the user only for a decision, access, information, or authorization that is genuinely unavailable.

A `REVIEW_BLOCKED` **stub** may also appear when the phase-level pass's subagent could not run at all. Block closure until a valid verdict exists; disposition depends on `blocked_category` (below).

**Distinguishing infra stubs from genuine escalations:**
- `blocked_category: "auditor-unavailable"` — no independent audit route is available without a human restoring or authorizing a capability. A timeout, tool failure, or exhausted counter alone is insufficient. Closure stays blocked; report the specific capability or access recorded in the artifact, then resume pocket-development when it is available. Do NOT print unrelated `ESCALATE:` instructions.
- `blocked_category: "audit-failed"` or `fix_instructions` starts with `ESCALATE:` — genuine quality escalation. This needs a human decision.

## Carried-forward observations (PASS only)

When all verdicts pass, collect non-blocking signal for `closeout.md` so it is not lost:

- `stage_2.issues[]` with `severity == "Minor"` — e.g. unused import, naming nit
- `stage_2.strengths[]` — what the review praised
- Out-of-scope notes the reviewer recorded as observations (not issues)

These never block a close. They are recorded so the next person sees what review flagged but accepted.

## Edge cases

| Situation | Handling |
|-----------|----------|
| Header `status` already `DONE` | Do not repeat state transitions; restore any missing phase/final closeout sections from current recorded verdicts, then report `ALREADY_CLOSED` |
| `reviews/` absent or empty | `CLOSE_BLOCKED: "No reviews found. Resume pocket-development's phase-level pass first."` |
| Verdict file present for a non-DONE task | Do not use the verdict; the incomplete task still blocks phase advancement |
| Any target-phase task is not DONE or lacks `done_sha` | Phase is incomplete — do not advance; resume pocket-development for that task |
| `review.reviewed_sha` present and `!= latest_owned_sha(T)` | Stale — a correction landed after this review. `CLOSE_BLOCKED: "T{id} verdict is stale: a correction changed its files after review. Re-run pocket-development's phase-level pass."` Never close on it. |
| `review.reviewed_sha` absent and `review.timestamp < committer_time(latest_owned_sha(T))` | Legacy stale — code boundary advanced after review (timestamp proxy). `CLOSE_BLOCKED: "T{id} verdict is stale. Re-run pocket-development's phase-level pass."` Never close on it. |
| Review `timestamp` missing/unparseable and `reviewed_sha` absent | Cannot prove freshness → treat as stale → `CLOSE_BLOCKED`. Re-run pocket-development's phase-level pass to regenerate the verdict |
| A no-change task has a valid REVIEW_PASS stub with exact `reviewed_sha` | Include it as a reviewed task; do not list it as skipped |
| Directory invocation finds more than one phase in REVIEW | Process the lowest-order REVIEW phase first; do not skip an earlier phase |
