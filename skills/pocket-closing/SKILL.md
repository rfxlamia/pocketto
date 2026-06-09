---
name: pocket-closing
description: Terminal pocket stage. User invokes after pocket-review writes verdicts. Reconciles reviews against log.json, gates on REVIEW_FAIL/REVIEW_BLOCKED, advances REVIEW→DONE, runs `log close`, and emits a closeout summary. Trigger on "pocket-closing", "close the plan", "close out", "finalize plan", or when a plan is fully reviewed and all verdicts pass.
---

# Pocket Closing

The terminal stage of the Pocket pipeline. Invoked directly by the user after pocket-review has written verdicts for a phase or flat plan. It reconciles those verdicts against the execution log, gates closure on review results, advances state, and produces the closeout artifact that ends the plan.

**Core principle:** Verdicts decide. pocket-closing never re-reviews and never improvises a close — it reads what pocket-review wrote and translates it into an accept-and-close or a block. No clean verdict, no close.

## Position in Pocket Bundle

```text
pocket-grinding → pocket-planning → pocket-structuring → pocket-development → pocket-review → POCKET-CLOSING
                                                                                                    ↑
                                                                                  User invokes — or pocket-review
                                                                                  auto-chains here (one confirmation)
                                                                                       when all tasks pass review
```

pocket-closing runs whichever way the user reaches it: invoked **directly** (`/pocketto:pocket-closing <path>`), or **auto-chained** by pocket-review after a phase passes with all `REVIEW_PASS` — pocket-review surfaces a one-prompt confirmation and, on **yes**, hands the plan path here. Either path, pocket-closing owns the close from scratch: pocket-review deliberately does NOT update `log.json` ("leave to user or pocket-closing"), so this skill still runs its full preflight, verdict gate, freshness check, and `log close`. pocket-development names `log.json` as "pocket-closing's primary input." This skill is where the loop actually closes.

## Invocation

```text
/pocketto:pocket-closing <path-to-execution-plan-or-plan-dir>
```

Examples:
```text
/pocketto:pocket-closing docs/pocket/plans/2026-06-03-typing-dna/
/pocketto:pocket-closing docs/pocket/plans/2026-05-28-auth/execution-plan.md
/pocketto:pocket-closing docs/pocket/plans/2026-05-28-auth/execution-plan-phase-2.md
```

## Main Agent Role (HARDENED)

Main agent = **Reconciler + Closer only**. Does NOT review code.

| Main agent MUST | Main agent MUST NOT |
|-----------------|---------------------|
| Read log.json and every reviews/*.json | Read implementation files or assess code |
| Reconcile each reviewable task to its verdict | Re-run, re-interpret, or override a review verdict |
| Gate close on REVIEW_FAIL / REVIEW_BLOCKED | Close a plan with any failing or missing verdict |
| Advance phases via `pocketto-pi log` CLI | Hand-edit log.json (CLI is the only writer) |
| Run `log close` and write closeout.md | Mark a task DONE or re-touch any `done_sha` |
| Emit a structured CLOSED / PHASE_ADVANCED / CLOSE_BLOCKED report | Silently block — every block names what, why, unblock |

## Preflight

Run ALL steps before changing any state. Failure in steps 1–3 → `CLOSE_BLOCKED` immediately.

### Step 1: Resolve plan_dir and target phases

```text
If invoked with a file path → plan_dir = parent dir, target = that phase file
If invoked with a dir path  → plan_dir = dir, target = every phase in log.json
```

### Step 2: Read log.json

```text
<plan_dir>/log.json
```

Verify:
- File exists → else `CLOSE_BLOCKED: "log.json not found at <path>. Run pocket-development first."`
- `header` present with `status` and `phases[]` → else `CLOSE_BLOCKED: "log.json malformed: <field> missing"`
- Header `status` is `IN_PROGRESS` → if already `DONE`, report `ALREADY_CLOSED` and stop (idempotent, no re-close)

### Step 3: Load review verdicts and reconcile

```bash
ls <plan_dir>/reviews/
```

Read every `reviews/<task_id>-review.json`. For each reviewable task in each target phase (the same task set pocket-review computed — `status == DONE` with a non-null `done_sha`):

| Condition | Reconciliation |
|-----------|----------------|
| `DONE` + `done_sha` + review file **current for that `done_sha`** | Reviewable — record its `overall` verdict |
| `DONE` + `done_sha` + review file **stale** (predates the current `done_sha`) | `CLOSE_BLOCKED` — "T{id} verdict is stale: reviewed before the current done_sha. Re-run pocket-review." |
| `DONE` + `done_sha` but NO review file | `CLOSE_BLOCKED` — "T{id} has no verdict. Run pocket-review before closing." |
| Task is not `DONE` / missing `done_sha` | Not reviewable — was skipped by pocket-review; note and exclude from the gate |
| `reviews/` dir absent or empty | `CLOSE_BLOCKED` — "No reviews found. Run pocket-review first." |

**Freshness check (mandatory).** A review proves a verdict only for the SHA it actually reviewed. If a task is re-implemented after review, its `done_sha` advances but the old verdict lingers — closing on it would accept code that was never reviewed at the SHA being closed. For each reviewable task, confirm the verdict is current:

```bash
git show -s --format=%cI <task.done_sha>     # committer time of the reviewed commit
```

The verdict is current iff the review's `timestamp` is **at or after** that commit time (compare as UTC instants). If the commit at `done_sha` is newer than the review → stale → `CLOSE_BLOCKED`. If the review file records the reviewed SHA explicitly, require an exact match instead — it is stronger than the timestamp proxy.

Reconciliation details, REVIEW_BLOCKED stub handling, and observation extraction: load `references/verdict-reconciliation.md`.

## Gate on Verdicts

A phase may advance ONLY when every reviewable task in it is `REVIEW_PASS`.

| Any task verdict | Action |
|------------------|--------|
| `REVIEW_FAIL` | `CLOSE_BLOCKED`. Print each failing task's `fix_instructions` verbatim. Fix → re-run pocket-review → re-run pocket-closing. |
| `REVIEW_BLOCKED` | `CLOSE_BLOCKED`. Print the escalation `fix_instructions`. Resolve the escalation before closing. |
| all `REVIEW_PASS` | Phase passes the gate — proceed to Advance State. |

Non-blocking observations (`stage_2` Minor issues, strengths, out-of-scope notes on PASSing tasks) do NOT block. Collect them — they go into the closeout summary as "carried forward."

## Advance State

For each phase that **passed the gate**, advance it `REVIEW → DONE` at the phase level only:

```bash
npx -y pocketto-pi log update <plan_dir> <phase_file> DONE --json --contract 2
```

[CRITICAL] Phase-level update only. NEVER pass `--task` here — task `DONE` recomputes `done_sha` from current HEAD and would corrupt the review's SHA range. Tasks were already marked DONE by pocket-development; leave them untouched.

Parse the envelope, confirm `ok: true` and `data.newStatus == "DONE"` before continuing.

## Close

Attempt the close once all passed phases are `DONE`:

```bash
npx -y pocketto-pi log close <plan_dir> --json --contract 2
```

`log close` verifies **every** phase in the plan is `DONE`. Read the envelope:

| Result | Meaning | pocket-closing output |
|--------|---------|----------------------|
| `ok: true`, `data.status == "DONE"` | All phases DONE → header set to `DONE` + `date_completed` | `CLOSED` — write closeout.md, emit final report |
| `ok: false`, code `PHASES_NOT_DONE` | Other phases still `WAITING`/`REVIEW` (Type B, plan not finished) | `PHASE_ADVANCED` — the reviewed phase is DONE; name the next phase to run. Do NOT treat the non-zero exit as an error. |

`PHASE_ADVANCED` is the normal mid-pipeline state for phased plans: you advanced one phase, the plan continues. Point the user back to pocket-development / pocket-review for the next phase.

## Enterprise Mode (opt-in): Closeout

This section runs **only** when enterprise mode is active **and** the plan reached `CLOSED` (all verdicts clean, `log close` succeeded). Non-enterprise runs skip it entirely — the skill behaves exactly as today.

### Step E1: Detect enterprise mode

```bash
npx -y pocketto-pi mode --json --contract 2
```

Parse the envelope. If `ok: false` or `data.enterprise` is not `true` → **skip this entire section** (proceed directly to Closeout Summary). Fail-closed: no GitHub calls in non-enterprise mode, ever.

### Step E2: Read linked issue from `.pocket-meta.json`

```bash
npx -y pocketto-pi meta get <plan_dir> github_issue.number --json --contract 2
```

If `data.value` is `null` or missing → emit warning: `"Enterprise closeout skipped: no linked issue in .pocket-meta.json."` → proceed to Closeout Summary (no GitHub call).

### Step E3: Build closeout body via CLI

Write the closeout input to a temp JSON file:

```json
{ "slug": "<plan-slug>", "issue": <issue-number>, "phases": <phase-count> }
```

Then:

```bash
npx -y pocketto-pi format closeout --input <tmp.json> --json --contract 2
```

Parse `data.bodyFile` from the envelope.

### Step E4: Post closeout comment

```bash
gh issue comment <issue-number> --body-file <bodyFile>
```

**[CRITICAL] Do NOT call `gh issue close`.** The issue closes when the supervisor **merges** the final PR (`closes #<issue>` in the PR body). Merge is the human gate — Pocket never closes the issue directly.

### Step E5: Discover linking PR number

```bash
npx -y pocketto-pi meta get <plan_dir> github_pr.number --json --contract 2
```

If `data.value` is non-null → use it as the PR number. Otherwise, fall back to branch discovery:

```bash
branch=$(git rev-parse --abbrev-ref HEAD)
gh pr list --head "$branch" --json number --jq '.[0].number // empty'
```

If no PR number is found by either method → emit warning: `"Enterprise closeout: could not determine linking PR number — skipping merge-state check."` → skip to Closeout Summary (the closeout comment was still posted).

### Step E6: Check linking PR merge state

```bash
gh pr view <pr-number> --json state,merged
```

If `merged` is `false` → the closeout comment has been posted, but emit this warning:

```text
⚠️  The linking PR (#<pr-number>) is not yet merged.
    The issue will close when the supervisor merges this PR.
```

## Closeout Summary

On `CLOSED` only, write `<plan_dir>/closeout.md` — the artifact that ends the plan. Load `references/closeout-summary-template.md` for the exact format. It records, per phase: each task, its `done_sha`, its verdict, and the observations carried forward; plus header dates and the final SHA range.

Then emit the terminal report:

```text
PLAN CLOSED — <plan_dir>
──────────────────────────────────────────
Phases : N — all DONE
Tasks  : M reviewed — all REVIEW_PASS
Closed : <date_completed>
Carried forward: K non-blocking observations (see closeout.md)
──────────────────────────────────────────
Closeout: <plan_dir>/closeout.md
```

## Output States

| State | Meaning |
|-------|---------|
| `CLOSED` | All phases DONE, header `DONE` + `date_completed`, closeout.md written |
| `PHASE_ADVANCED` | Reviewed phase advanced to DONE; other phases remain — plan continues |
| `CLOSE_BLOCKED` | Preflight failed, a verdict is missing, or a task is REVIEW_FAIL/REVIEW_BLOCKED |
| `ALREADY_CLOSED` | Header already `DONE` — idempotent no-op |

## Iron Laws

```text
1. NO CLOSE WITH A FAILING VERDICT
   Any REVIEW_FAIL or REVIEW_BLOCKED in a target phase → CLOSE_BLOCKED.
   WHY: Closing translates review results into an accept decision.
   Closing over a failure ships unreviewed-bad code as "done".

2. NO CLOSE WITHOUT A CURRENT VERDICT
   Every reviewable task (DONE + done_sha) must have a review file whose
   verdict was produced for that exact done_sha — not an earlier one.
   WHY: A DONE task with no verdict, or one whose code changed after the
   review, was never reviewed at the SHA being closed. Closing it asserts
   a review that did not happen.

3. NO CODE READING BY MAIN AGENT
   pocket-closing reconciles verdicts; it never re-reviews implementation.
   WHY: Re-reviewing duplicates pocket-review and invites the main agent
   to override an independent verdict with its own judgment.

4. NO MANUAL log.json EDIT
   Only `pocketto-pi log` writes log.json. Never hand-edit it.
   WHY: The CLI keeps the schema, SHAs, and dates consistent and is the
   single source of state transitions across the bundle.

5. NO SILENT BLOCK
   Every CLOSE_BLOCKED states: what blocked, why, what would unblock.
   WHY: "Can't close" without a reason creates deadlock.
```

## Sample log.json — Before and After

**Before** (the canonical end state pocket-review leaves — flat plan, all passed, still open):

```json
{
  "header": {
    "plan_dir": "docs/pocket/plans/2026-06-03-typing-dna",
    "plan_type": "flat",
    "status": "IN_PROGRESS",
    "date_started": "2026-06-03",
    "date_completed": null,
    "baseline_sha": "abc1234"
  },
  "phases": [
    {
      "order": 1,
      "file": "execution-plan.md",
      "status": "REVIEW",
      "tasks": [
        { "id": "T1", "name": "Capture keystroke timing", "status": "DONE", "done_sha": "bcd2345" },
        { "id": "T2", "name": "Derive dwell features",     "status": "DONE", "done_sha": "cde3456" }
      ]
    }
  ]
}
```

reviews/T1-review.json → `REVIEW_PASS`, reviews/T2-review.json → `REVIEW_PASS`.

**After** pocket-closing (gate passes → phase DONE → `log close`):

```json
{
  "header": {
    "plan_dir": "docs/pocket/plans/2026-06-03-typing-dna",
    "plan_type": "flat",
    "status": "DONE",
    "date_started": "2026-06-03",
    "date_completed": "2026-06-04",
    "baseline_sha": "abc1234"
  },
  "phases": [
    { "order": 1, "file": "execution-plan.md", "status": "DONE", "tasks": [ /* unchanged */ ] }
  ]
}
```

Plus `closeout.md` written to the plan dir. Output state: `CLOSED`.

## Reference Triggers

| Reference | When to Load |
|-----------|--------------|
| `references/verdict-reconciliation.md` | Mapping tasks↔verdicts, REVIEW_BLOCKED stubs, extracting carried-forward observations, edge cases |
| `references/closeout-summary-template.md` | Writing closeout.md — exact section structure and a filled example |
